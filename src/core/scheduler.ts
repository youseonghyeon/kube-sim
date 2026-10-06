// kube-scheduler: 노드가 정해지지 않은 Pod 를 골라 필터 → 점수 → 바인딩(spec.nodeName).
// 자리가 없으면 FailedScheduling 이벤트에 노드별 이유를 실제 문구로 모으고, 클러스터가 바뀔 때(노드 추가·변경, 노드에 있던 Pod 삭제) 다시 시도한다.
// 볼륨(5d): Pod 가 쓰는 PVC 가 없으면 아무 노드도 못 고르고, PVC 가 묶인 PV 가 노드에 묶여 있으면(local-path) 그 노드만 (VolumeBinding 필터).
// 아직 안 묶인 WaitForFirstConsumer PVC 는 바인딩할 때 고른 노드를 PVC 에 적어(selected-node) 프로비저너가 그 노드에 디스크를 만들게 한다.
// 축소판: 점수는 LeastAllocated 하나 (실제는 여러 플러그인의 가중합), preemption 없음, 5분 주기 재시도 없음, PV 프로비저닝을 기다린 뒤 바인딩하지 않는다(PreBind 생략).
import { refOf } from "./api/server";
import { isNodeReady, isPodTerminal, podRequests, type Node, type Pod, type Resources, type Taint, type Toleration } from "./api/types";
import { nsKey, splitKey, type ComponentContext } from "./controllers/base";
import { stableJson } from "./rng";
import { podClaims, pvNode, SELECTED_NODE } from "./storage";
import { fmtCpu, fmtMem } from "./units";

export const SCHEDULER = "kube-scheduler";

export interface NodeUsage {
  requested: Resources;
  pods: number;
}

/** 노드에 올라간(끝나지 않은) Pod 들의 requests 합. Terminating Pod 도 사라질 때까지 자리를 차지한다 */
export function nodeUsage(pods: readonly Pod[], nodeName: string): NodeUsage {
  let cpu = 0;
  let memory = 0;
  let n = 0;
  for (const p of pods) {
    if (p.spec.nodeName !== nodeName || isPodTerminal(p)) continue;
    const r = podRequests(p.spec);
    cpu += r.cpu;
    memory += r.memory;
    n++;
  }
  return { requested: { cpu, memory }, pods: n };
}

export class Scheduler {
  private readonly queue = new Set<string>();
  /** 자리가 없어 기다리는 Pod (클러스터가 바뀌면 다시 큐로) */
  private readonly unschedulable = new Set<string>();
  private scheduled = false;
  /** 기다리던 Pod 를 다시 시도하게 만든 클러스터 변화 (트레이스에 이유로 남긴다) */
  private readonly retryWhy = new Map<string, string>();
  /** 노드마다 스케줄에 영향을 주는 속성의 요약 — 이것이 바뀔 때만 다시 시도 (status.images 같은 변화는 무시) */
  private readonly nodeProps = new Map<string, string>();

  constructor(private readonly ctx: ComponentContext) {
    ctx.api.watch("Pod", (ev) => {
      const p = ev.object;
      const key = nsKey(p.metadata.namespace, p.metadata.name);
      if (ev.type === "DELETED") {
        this.queue.delete(key);
        this.unschedulable.delete(key);
        if (p.spec.nodeName) this.retryUnschedulable(`노드 ${p.spec.nodeName} 의 Pod ${p.metadata.name} 이(가) 사라져 자리가 났을 수 있음`);
        return;
      }
      if (p.spec.nodeName || p.metadata.deletionTimestamp !== undefined) return;
      // 실패를 기록한 상태 갱신이 다시 깨우지 않게: 기다리는 Pod 는 클러스터 변화로만 다시 시도
      if (this.unschedulable.has(key)) return;
      this.enqueue(key);
    });
    // PVC·PV 가 생기거나 묶이면 기다리던 Pod 가 갈 곳이 생겼을 수 있다
    ctx.api.watch("PersistentVolumeClaim", (ev) => {
      if (ev.type !== "DELETED") this.retryUnschedulable(`PVC ${ev.object.metadata.name} 이(가) ${ev.type === "ADDED" ? "생김" : "바뀜"}`);
    });
    ctx.api.watch("PersistentVolume", (ev) => {
      if (ev.type !== "DELETED") this.retryUnschedulable(`PV ${ev.object.metadata.name} 이(가) 바뀜`);
    });
    ctx.api.watch("Node", (ev) => {
      const n = ev.object;
      if (ev.type === "DELETED") {
        this.nodeProps.delete(n.metadata.name);
        return;
      }
      const props = stableJson({ a: n.status.allocatable, u: n.spec.unschedulable ?? false, t: n.spec.taints ?? [], l: n.metadata.labels, r: isNodeReady(n) });
      const prev = this.nodeProps.get(n.metadata.name);
      this.nodeProps.set(n.metadata.name, props);
      if (prev === props) return;
      this.retryUnschedulable(prev === undefined ? `노드 ${n.metadata.name} 추가됨` : `노드 ${n.metadata.name} 의 자원·cordon·taint·라벨이 바뀜`);
    });
  }

  private enqueue(key: string): void {
    this.queue.add(key);
    if (this.scheduled) return;
    this.scheduled = true;
    this.ctx.clock.after(0, SCHEDULER, () => this.drain());
  }

  private retryUnschedulable(why: string): void {
    if (!this.unschedulable.size) return;
    const keys = [...this.unschedulable];
    this.unschedulable.clear();
    for (const k of keys) {
      this.retryWhy.set(k, why);
      this.enqueue(k);
    }
  }

  private drain(): void {
    this.scheduled = false;
    const keys = [...this.queue];
    this.queue.clear();
    for (const key of keys) this.scheduleOne(key);
  }

  private scheduleOne(key: string): void {
    const [ns, name] = splitKey(key);
    const api = this.ctx.api;
    const pod = api.get("Pod", name, ns);
    const why = this.retryWhy.get(key);
    this.retryWhy.delete(key);
    if (!pod || pod.spec.nodeName || pod.metadata.deletionTimestamp !== undefined) return;
    const again = why ? ` (다시 시도: ${why})` : "";
    const req = podRequests(pod.spec);
    const nodes = [...api.peekList("Node")].sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1));
    const pods = api.peekList("Pod");
    const reasons = new Map<string, number>();
    const fits: { node: Readonly<Node>; score: number }[] = [];
    const rejected: string[] = [];
    const vol = volumeCheck(api, pod);
    if (vol.missing) {
      // PreFilter 에서 막힘: 노드를 하나도 보지 않는다
      const msg = `0/${nodes.length} nodes are available: persistentvolumeclaim "${vol.missing}" not found.`;
      this.unschedulable.add(key);
      this.ctx.trace.add(SCHEDULER, "scheduler.fail", `${name}${again} 가 쓰는 PVC ${vol.missing} 가 없음 → 노드를 고르지 않고 Pending 으로 대기 (PVC 가 생기면 다시 시도)`, refOf(pod));
      api.recordEvent(pod, "Warning", "FailedScheduling", msg, SCHEDULER);
      api.patch("Pod", name, ns, SCHEDULER, (p) => setCondition(p, "PodScheduled", "False", this.ctx.clock.now, "Unschedulable", msg));
      return;
    }
    for (const node of nodes) {
      let why = filter(node, pod, req, nodeUsage(pods, node.metadata.name));
      if (!why.length && vol.node !== undefined && vol.node !== node.metadata.name) why = ["node(s) had volume node affinity conflict"];
      if (why.length) {
        for (const r of why) reasons.set(r, (reasons.get(r) ?? 0) + 1);
        rejected.push(`${node.metadata.name}: ${why.join(", ")}`);
      } else fits.push({ node, score: score(node, req, nodeUsage(pods, node.metadata.name)) });
    }
    const reqText = `요청 cpu ${fmtCpu(req.cpu)} · memory ${fmtMem(req.memory)}`;
    if (!fits.length) {
      const msg = failedSchedulingMessage(nodes.length, reasons);
      this.unschedulable.add(key);
      this.ctx.trace.add(
        SCHEDULER,
        "scheduler.fail",
        `${name}${again} ${reqText} → 맞는 노드 없음${rejected.length ? ` (${rejected.join(" · ")})` : ""} → Pending 으로 대기, 클러스터가 바뀌면 다시 시도`,
        refOf(pod),
      );
      api.recordEvent(pod, "Warning", "FailedScheduling", msg, SCHEDULER);
      api.patch("Pod", name, ns, SCHEDULER, (p) => {
        setCondition(p, "PodScheduled", "False", this.ctx.clock.now, "Unschedulable", msg);
      });
      return;
    }
    fits.sort((a, b) => b.score - a.score || (a.node.metadata.name < b.node.metadata.name ? -1 : 1));
    const best = fits[0]!;
    const nodeName = best.node.metadata.name;
    const ranking = fits.map((f) => `${f.node.metadata.name} ${f.score}`).join(" > ");
    // 아직 안 묶인 PVC(WaitForFirstConsumer): 고른 노드를 적어 프로비저너가 그 노드에 디스크를 만들게 한다
    for (const claim of vol.unbound) api.patch("PersistentVolumeClaim", claim, ns, SCHEDULER, (c) => (c.metadata.annotations = { ...(c.metadata.annotations ?? {}), [SELECTED_NODE]: nodeName }));
    api.patch("Pod", name, ns, SCHEDULER, (p) => {
      p.spec.nodeName = nodeName;
      setCondition(p, "PodScheduled", "True", this.ctx.clock.now);
    });
    this.ctx.trace.add(
      SCHEDULER,
      "scheduler.bind",
      `${name}${again} ${reqText}${vol.node ? ` · 디스크(PV)가 ${vol.node} 에 묶여 있어 그 노드만` : ""}${vol.unbound.length ? ` · PVC ${vol.unbound.join(", ")} 는 아직 디스크가 없어 고른 노드에 만들게 함` : ""} → 후보 ${fits.length}/${nodes.length}${rejected.length ? ` (제외 ${rejected.join(" · ")})` : ""} → 점수 ${ranking} → ${nodeName} 에 바인딩`,
      refOf(pod),
    );
    api.recordEvent(pod, "Normal", "Scheduled", `Successfully assigned ${ns}/${name} to ${nodeName}`, SCHEDULER);
  }
}

/** Pod 의 PVC 들: 없는 것, 묶인 PV 가 정한 노드, 아직 안 묶인(WaitForFirstConsumer) 것 */
export function volumeCheck(api: ComponentContext["api"], pod: Pod): { missing?: string; node?: string; unbound: string[] } {
  const ns = pod.metadata.namespace ?? "default";
  const unbound: string[] = [];
  let node: string | undefined;
  for (const { claim } of podClaims(pod)) {
    const pvc = api.peekList("PersistentVolumeClaim", ns).find((c) => c.metadata.name === claim);
    if (!pvc) return { missing: claim, unbound };
    if (pvc.status.phase !== "Bound" || !pvc.spec.volumeName) {
      unbound.push(claim);
      continue;
    }
    const pv = api.peekList("PersistentVolume").find((v) => v.metadata.name === pvc.spec.volumeName);
    const n = pv ? pvNode(pv) : undefined;
    if (n) node = n;
  }
  return { node, unbound };
}

/** 노드가 이 Pod 를 받을 수 없는 이유들 (실제 문구) — 비어 있으면 통과 */
export function filter(node: Node, pod: Pod, req: Resources, usage: NodeUsage): string[] {
  if (node.spec.unschedulable) return ["node(s) were unschedulable"];
  const taints = [...(node.spec.taints ?? [])];
  if (!isNodeReady(node) && !taints.some((t) => t.key.startsWith("node.kubernetes.io/"))) {
    taints.push({ key: "node.kubernetes.io/not-ready", effect: "NoSchedule" });
  }
  const bad = taints.find((t) => (t.effect === "NoSchedule" || t.effect === "NoExecute") && !tolerates(pod.spec.tolerations ?? [], t));
  if (bad) return [`node(s) had untolerated taint {${bad.key}: ${bad.value ?? ""}}`];
  const sel = pod.spec.nodeSelector ?? {};
  if (Object.entries(sel).some(([k, v]) => node.metadata.labels[k] !== v)) return ["node(s) didn't match Pod's node affinity/selector"];
  const out: string[] = [];
  const alloc = node.status.allocatable;
  if (usage.pods + 1 > alloc.pods) out.push("Too many pods");
  if (usage.requested.cpu + req.cpu > alloc.cpu) out.push("Insufficient cpu");
  if (usage.requested.memory + req.memory > alloc.memory) out.push("Insufficient memory");
  return out;
}

export function tolerates(tols: Toleration[], t: Taint): boolean {
  return tols.some(
    (tol) => (tol.key === t.key || (tol.operator === "Exists" && !tol.key)) && (tol.operator === "Exists" || (tol.value ?? "") === (t.value ?? "")) && (!tol.effect || tol.effect === t.effect),
  );
}

/** LeastAllocated: 바인딩 후 남는 비율이 클수록 높은 점수 (cpu·memory 평균, 0~100) */
export function score(node: Node, req: Resources, usage: NodeUsage): number {
  const a = node.status.allocatable;
  const free = (cap: number, used: number) => (cap <= 0 ? 0 : Math.max(0, (cap - used) / cap));
  return Math.floor(((free(a.cpu, usage.requested.cpu + req.cpu) + free(a.memory, usage.requested.memory + req.memory)) / 2) * 100);
}

/** `0/3 nodes are available: 1 Insufficient memory, 3 Insufficient cpu.` — 이유 문자열을 정렬해 잇는다(실제 FitError 와 같음) */
export function failedSchedulingMessage(nodeCount: number, reasons: Map<string, number>): string {
  if (nodeCount === 0) return "no nodes available to schedule pods";
  const parts = [...reasons].map(([r, n]) => `${n} ${r}`).sort();
  return `0/${nodeCount} nodes are available: ${parts.join(", ")}.`;
}

export function setCondition(o: { status: { conditions: import("./api/types").Condition[] } }, type: string, status: "True" | "False" | "Unknown", now: number, reason?: string, message?: string): void {
  const cur = o.status.conditions.find((c) => c.type === type);
  if (cur) {
    if (cur.status !== status) cur.lastTransitionTime = now;
    cur.status = status;
    cur.reason = reason;
    cur.message = message;
  } else o.status.conditions.push({ type, status, reason, message, lastTransitionTime: now });
}
