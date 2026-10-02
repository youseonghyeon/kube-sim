// node-lifecycle-controller: 5초마다 노드의 Lease 를 보고, 40초 넘게 갱신이 없으면 Ready=Unknown + unreachable taint.
// 다시 갱신되고 kubelet 이 Ready 를 보고하면 taint 를 뗀다.
// taint-eviction-controller: NoExecute taint 가 붙은 노드의 Pod 를 toleration 이 끝나면 지운다 (기본 300초 — DefaultTolerationSeconds).
// 그래서 노드가 죽고 Pod 가 다른 노드로 옮겨지기까지 약 40초 + 300초가 걸린다.
// 축소판: zone 별 eviction 속도 제한(--node-eviction-rate)·대규모 장애 보호 모드 없음.
import { refOf } from "../api/server";
import { condition, NODE_LEASE_NS, type Node, type Pod, type Taint } from "../api/types";
import type { TimerHandle } from "../clock";
import { setCondition, tolerates } from "../scheduler";
import { fmtClock } from "../units";
import type { ComponentContext } from "./base";

/** 노드 상태를 확인하는 주기 (실제값 --node-monitor-period 5s) */
export const NODE_MONITOR_PERIOD_MS = 5000;
/** 이만큼 Lease 갱신이 없으면 NotReady (실제값 --node-monitor-grace-period 40s, v1.31) */
export const NODE_MONITOR_GRACE_MS = 40_000;

export const UNREACHABLE = "node.kubernetes.io/unreachable";
export const NODE_LIFECYCLE = "node-lifecycle-controller";
export const TAINT_EVICTION = "taint-eviction-controller";

export class NodeLifecycleController {
  constructor(private readonly ctx: ComponentContext) {
    this.schedule();
  }

  /** 배경 타이머: 끝없는 주기 동작이라 시계를 스스로 움직이지 않는다 */
  private schedule(): void {
    this.ctx.clock.background(NODE_MONITOR_PERIOD_MS, NODE_LIFECYCLE, () => {
      this.monitor();
      this.schedule();
    });
  }

  monitor(): void {
    const { api, clock, trace } = this.ctx;
    const now = clock.now;
    for (const node of api.list("Node")) {
      const name = node.metadata.name;
      const lease = api.get("Lease", name, NODE_LEASE_NS);
      const renew = lease?.spec.renewTime ?? node.metadata.creationTimestamp;
      const stale = now - renew > NODE_MONITOR_GRACE_MS;
      const ready = condition(node, "Ready");
      const tainted = (node.spec.taints ?? []).some((t) => t.key === UNREACHABLE);
      if (stale && ready?.status !== "Unknown") {
        trace.add(
          NODE_LIFECYCLE,
          "node.notready",
          `${name} 의 Lease 가 ${Math.round((now - renew) / 1000)}초 동안 갱신 안 됨 (마지막 ${fmtClock(renew)}, 한도 ${NODE_MONITOR_GRACE_MS / 1000}초) → Ready=Unknown, taint ${UNREACHABLE}:NoSchedule·NoExecute 추가, 이 노드의 Pod 를 Ready=False 로`,
          refOf(node),
        );
        api.patch("Node", name, undefined, NODE_LIFECYCLE, (n) => {
          for (const c of n.status.conditions) {
            if (c.type !== "Ready") continue;
            if (c.status !== "Unknown") c.lastTransitionTime = now;
            c.status = "Unknown";
            c.reason = "NodeStatusUnknown";
            c.message = "Kubelet stopped posting node status.";
          }
          const rest = (n.spec.taints ?? []).filter((t) => t.key !== UNREACHABLE);
          n.spec.taints = [...rest, { key: UNREACHABLE, effect: "NoSchedule", timeAdded: now }, { key: UNREACHABLE, effect: "NoExecute", timeAdded: now }];
        });
        api.recordEvent(node, "Normal", "NodeNotReady", `Node ${name} status is now: NodeNotReady`, "node-controller");
        for (const p of api.list("Pod")) {
          if (p.spec.nodeName !== name || p.metadata.deletionTimestamp !== undefined) continue;
          api.patch("Pod", p.metadata.name, p.metadata.namespace, NODE_LIFECYCLE, (o) => setCondition(o, "Ready", "False", now, "NodeNotReady", "Node is not ready"));
          api.recordEvent(p, "Warning", "NodeNotReady", "Node is not ready", "node-controller");
        }
      } else if (!stale && ready?.status === "True" && tainted) {
        trace.add(NODE_LIFECYCLE, "node.ready", `${name} 의 Lease 가 다시 갱신되고 kubelet 이 Ready 를 보고함 → taint ${UNREACHABLE} 제거`, refOf(node));
        api.patch("Node", name, undefined, NODE_LIFECYCLE, (n) => {
          const rest = (n.spec.taints ?? []).filter((t) => t.key !== UNREACHABLE);
          if (rest.length) n.spec.taints = rest;
          else delete n.spec.taints;
        });
        api.recordEvent(node, "Normal", "NodeReady", `Node ${name} status is now: NodeReady`, "node-controller");
      }
    }
  }
}

export class TaintEvictionController {
  /** Pod uid → 지우기 예약 */
  private readonly timers = new Map<string, { handle: TimerHandle; node: string }>();

  constructor(private readonly ctx: ComponentContext) {
    ctx.api.watch("Node", (ev) => {
      if (ev.type === "DELETED") {
        this.cancelNode(ev.object.metadata.name);
        return;
      }
      for (const p of ctx.api.list("Pod")) if (p.spec.nodeName === ev.object.metadata.name) this.consider(p, ev.object);
    });
    ctx.api.watch("Pod", (ev) => {
      const p = ev.object;
      if (ev.type === "DELETED") {
        this.cancel(p.metadata.uid);
        return;
      }
      if (!p.spec.nodeName) return;
      const node = ctx.api.get("Node", p.spec.nodeName);
      if (node) this.consider(p, node);
    });
  }

  /** 이 Pod 가 노드의 NoExecute taint 를 견딜 수 있는 시간을 계산해 지우기를 예약하거나 취소한다 */
  private consider(p: Pod, node: Node): void {
    const uid = p.metadata.uid;
    if (p.metadata.deletionTimestamp !== undefined) {
      this.cancel(uid);
      return;
    }
    const taints = (node.spec.taints ?? []).filter((t) => t.effect === "NoExecute");
    if (!taints.length) {
      this.cancel(uid);
      return;
    }
    const at = evictionTime(p, taints, this.ctx.clock.now);
    if (at === undefined) {
      this.cancel(uid);
      return;
    }
    const cur = this.timers.get(uid);
    if (cur && cur.handle.at === Math.max(at, this.ctx.clock.now) && !cur.handle.cancelled) return;
    cur?.handle.cancel();
    const delay = Math.max(0, at - this.ctx.clock.now);
    // 일반 타이머: 끝이 있는 기다림 (taint 가 빠지면 취소)
    const handle = this.ctx.clock.after(delay, TAINT_EVICTION, () => this.evict(uid, p.metadata.name, p.metadata.namespace, node.metadata.name));
    this.timers.set(uid, { handle, node: node.metadata.name });
  }

  private evict(uid: string, name: string, ns: string | undefined, nodeName: string): void {
    this.timers.delete(uid);
    const { api, trace } = this.ctx;
    const p = api.get("Pod", name, ns);
    const node = api.get("Node", nodeName);
    if (!p || p.metadata.uid !== uid || p.metadata.deletionTimestamp !== undefined || !node) return;
    const taints = (node.spec.taints ?? []).filter((t) => t.effect === "NoExecute");
    const at = evictionTime(p, taints, this.ctx.clock.now);
    if (at === undefined || at > this.ctx.clock.now) return;
    const taint = taints[0]!;
    const tol = (p.spec.tolerations ?? []).find((t) => tolerates([t], taint));
    trace.add(
      TAINT_EVICTION,
      "node.evict",
      `${name} 이(가) ${nodeName} 의 taint ${taint.key}:NoExecute 를 ${tol?.tolerationSeconds !== undefined ? `tolerationSeconds ${tol.tolerationSeconds}초 동안 견딤 → 시간 끝` : "견디지 못함"} → Pod 삭제 (노드가 응답이 없으면 Terminating 에 멈춘다)`,
      refOf(p),
    );
    api.recordEvent(p, "Normal", "TaintManagerEviction", `Marking for deletion Pod ${ns ?? "default"}/${name}`, TAINT_EVICTION);
    api.delete("Pod", name, ns, TAINT_EVICTION);
  }

  private cancel(uid: string): void {
    this.timers.get(uid)?.handle.cancel();
    this.timers.delete(uid);
  }

  private cancelNode(node: string): void {
    for (const [uid, t] of [...this.timers]) if (t.node === node) this.cancel(uid);
  }
}

/** NoExecute taint 들 중 가장 먼저 끝나는 toleration 시각. 영원히 견디면 undefined, 못 견디면 지금 */
export function evictionTime(p: Pod, taints: Taint[], now: number): number | undefined {
  let at: number | undefined;
  for (const t of taints) {
    const tol = (p.spec.tolerations ?? []).filter((x) => tolerates([x], t));
    if (!tol.length) return now;
    if (tol.some((x) => x.tolerationSeconds === undefined)) continue;
    const secs = Math.min(...tol.map((x) => x.tolerationSeconds!));
    const end = (t.timeAdded ?? now) + secs * 1000;
    at = at === undefined ? end : Math.min(at, end);
  }
  return at;
}
