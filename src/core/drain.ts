// kubectl drain 흉내: 노드를 cordon 하고, 그 노드의 Pod 를 Eviction API 로 하나씩 내보낸다.
// PodDisruptionBudget 이 거절하면 5초 뒤 다시 시도한다 (실제 kubectl 처럼). Pod 가 실제로 사라지면 "evicted" 를 찍는다.
// kubectl 은 이 과정 동안 계속 붙어 있으므로, 출력 줄이 시간이 지나며 늘어난다 (화면은 lines 를 다시 읽는다).
// 축소판: DaemonSet·emptyDir 없음 (--ignore-daemonsets 등은 받아만 둔다), 10분 넘게 못 끝내면 포기 (실제 기본은 무한 대기).
import { ApiError } from "./api/server";
import type { Cluster } from "./cluster";

const RETRY_MS = 5000;
const POLL_MS = 1000;
const GIVE_UP_MS = 600_000;

export class DrainJob {
  readonly lines: string[] = [];
  done = false;
  failed = false;
  private readonly waiting = new Map<string, string>(); // 이름 → uid (내보내기 요청이 받아들여진 Pod)
  private readonly started: number;

  constructor(
    private readonly c: Cluster,
    readonly node: string,
  ) {
    this.started = c.now;
    const n = c.api.get("Node", node);
    if (n?.spec.unschedulable) this.lines.push(`node/${node} already cordoned`);
    else {
      c.api.patch("Node", node, undefined, "kubectl", (o) => {
        o.spec.unschedulable = true;
      });
      this.lines.push(`node/${node} cordoned`);
    }
    this.round();
  }

  private log(s: string): void {
    this.lines.push(s);
    this.c.trace.add("kubectl", "user", `drain ${this.node}: ${s}`, { kind: "Node", name: this.node });
  }

  /** 아직 내보내지 않은 Pod 를 내보내 보고, 거절된 것은 5초 뒤 다시 */
  private round(): void {
    if (this.done) return;
    const pods = this.c.api.list("Pod").filter((p) => p.spec.nodeName === this.node && p.metadata.deletionTimestamp === undefined && !this.waiting.has(p.metadata.name));
    let refused = false;
    for (const p of pods) {
      const name = p.metadata.name;
      this.log(`evicting pod default/${name}`);
      try {
        this.c.api.evict(name, p.metadata.namespace, "kubectl");
        this.waiting.set(name, p.metadata.uid);
      } catch (e) {
        if (!(e instanceof ApiError) || e.reason !== "TooManyRequests") throw e;
        this.log(`error when evicting pods/"${name}" -n "default" (will retry after 5s): ${e.message}`);
        refused = true;
      }
    }
    this.poll();
    if (refused) this.c.clock.after(RETRY_MS, "kubectl", () => this.round());
  }

  /** 내보낸 Pod 가 사라졌는지 보고, 다 비면 끝 */
  private poll(): void {
    if (this.done) return;
    for (const [name, uid] of [...this.waiting]) {
      const p = this.c.api.get("Pod", name, "default");
      if (!p || p.metadata.uid !== uid) {
        this.waiting.delete(name);
        this.log(`pod/${name} evicted`);
      }
    }
    const left = this.c.api.list("Pod").filter((p) => p.spec.nodeName === this.node).length;
    if (left === 0 && this.waiting.size === 0) {
      this.done = true;
      this.log(`node/${this.node} drained`);
      return;
    }
    if (this.c.now - this.started > GIVE_UP_MS) {
      this.done = true;
      this.failed = true;
      this.log(`error: unable to drain node "${this.node}" — 10분 동안 끝내지 못해 포기합니다 (축소판: 실제 기본은 --timeout=0 무한 대기). PDB 가 허락하지 않는지 확인하세요`);
      return;
    }
    if (this.waiting.size) this.c.clock.after(POLL_MS, "kubectl", () => this.poll());
  }
}
