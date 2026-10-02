// 부하 발생기: 한 Pod 에서 정해진 간격으로 curl 을 계속 보내 성공·실패를 센다.
// 롤링 업데이트·Pod 삭제 중에 요청이 실패하는 순간(종료 순서 경합)을 보려고 쓴다.
// 끝없는 주기 동작이라 배경 타이머로 돈다. 요청마다 트레이스를 남기지 않고 실패만 남긴다.
import type { Cluster } from "../cluster";
import { simulateFromPod } from "./request";

export interface TrafficSample {
  t: number;
  ok: boolean;
  servedBy?: string;
  /** 실패 이유 한 줄 */
  reason?: string;
}

const KEEP = 150;

export class Traffic {
  ok = 0;
  fail = 0;
  readonly samples: TrafficSample[] = [];
  stopped = false;
  private handle?: { cancel(): void };

  constructor(
    private readonly c: Cluster,
    readonly from: string,
    readonly target: string,
    readonly intervalMs: number,
  ) {
    this.schedule();
  }

  private schedule(): void {
    this.handle = this.c.clock.background(this.intervalMs, "traffic", () => this.tick());
  }

  private tick(): void {
    if (this.stopped) return;
    const p = this.c.api.get("Pod", this.from, "default");
    const cs = p?.status.containerStatuses[0];
    if (!p || p.metadata.deletionTimestamp !== undefined || !p.spec.nodeName || !this.c.nodePowered(p.spec.nodeName) || !cs || !("running" in cs.state)) {
      this.c.trace.add("user", "net.fail", `부하 멈춤: 출발 Pod ${this.from} 이(가) 돌고 있지 않음`);
      this.stopped = true;
      return;
    }
    const r = simulateFromPod(this.c, p, "curl", this.target);
    const last = r.steps.at(-1);
    const sample: TrafficSample = { t: this.c.now, ok: r.ok, servedBy: r.servedBy, reason: r.ok ? undefined : (last?.text ?? r.output.split("\n")[0]) };
    if (r.ok) this.ok++;
    else {
      this.fail++;
      const at = last?.at?.pod ?? r.servedBy;
      this.c.trace.add("traffic", "net.fail", `부하 요청 실패 (${r.output.split("\n")[0]}) — ${sample.reason}`, at ? { kind: "Pod", namespace: "default", name: at } : undefined);
    }
    this.samples.push(sample);
    if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.handle?.cancel();
  }

  reset(): void {
    this.ok = 0;
    this.fail = 0;
    this.samples.length = 0;
  }
}
