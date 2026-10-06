// HPA 컨트롤러 (horizontal-pod-autoscaler): 15초마다 대상(Deployment·StatefulSet)의 Pod CPU 사용률(requests 대비 %)을 보고 replicas 를 고친다.
// 계산: 원하는 수 = ceil(Ready Pod 수 × 사용률/목표), 비율 차이가 10% 안쪽이면 그대로. Ready 아닌 Pod(Pending 포함)는 빼고 계산하되 늘릴 때만 0% 로 넣어 다시 보고,
// 사용량 없는 Ready Pod 는 줄일 때 max(100%, 목표)·늘릴 때 0% 로 넣는다 (replica_calculator.go). replicas 가 min~max 밖이면 사용률을 보기 전에 끝으로.
// 늘릴 때는 15초에 두 배 또는 +4 중 큰 것까지, 줄일 때는 지난 5분 추천 중 가장 큰 것(stabilization window 300초). minReplicas~maxReplicas 안으로.
// 15초 주기는 끝없는 주기 동작이라 배경 타이머. 사용량은 metrics-server 흉내(Cluster.podMetrics)를 바로 읽는다.
// 축소판: CPU Resource Utilization 메트릭만(메모리·custom·external 없음), behavior 사용자 설정 없음(기본값만), cpu initialization period 를 Ready 여부로만.
import { refOf } from "../api/server";
import { controllerOf, isPodReady, isPodTerminal, matchesSelector, type HorizontalPodAutoscaler, type Pod } from "../api/types";
import type { TimerHandle } from "../clock";
import { setCondition } from "../scheduler";
import { fmtCpu } from "../units";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";

export const HPA_SYNC_MS = 15_000;
export const TOLERANCE = 0.1;
export const SCALE_DOWN_WINDOW_MS = 300_000;
export const HPA = "horizontal-pod-autoscaler";

type Metrics = (p: Pod) => { cpu: number } | undefined;

export class HpaController extends Controller {
  private timer?: TimerHandle;
  /** HPA 마다 지난 추천 (시각, 수) — 줄일 때 5분 동안의 가장 큰 것을 따른다 */
  private readonly recs = new Map<string, { t: number; n: number }[]>();
  /** 같은 말을 15초마다 되풀이해 적지 않게 */
  private readonly last = new Map<string, string>();

  constructor(
    ctx: ComponentContext,
    private readonly metrics: Metrics,
  ) {
    super(HPA, ctx);
    ctx.api.watch("HorizontalPodAutoscaler", (ev) => {
      const key = nsKey(ev.object.metadata.namespace, ev.object.metadata.name);
      if (ev.type === "DELETED") {
        this.recs.delete(key);
        this.last.delete(key);
        return;
      }
      if (ev.type === "ADDED") this.enqueue(key);
      this.ensureTimer();
    });
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = this.ctx.clock.background(HPA_SYNC_MS, this.name, () => {
      this.timer = undefined;
      const all = this.api.peekList("HorizontalPodAutoscaler");
      for (const h of all) this.enqueue(nsKey(h.metadata.namespace, h.metadata.name));
      if (all.length) this.ensureTimer();
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const hpa = this.api.get("HorizontalPodAutoscaler", name, ns);
    if (!hpa) return;
    const ref = hpa.spec.scaleTargetRef;
    const target = this.api.get(ref.kind, ref.name, ns);
    const now = this.now;
    const min = hpa.spec.minReplicas ?? 1;
    const max = hpa.spec.maxReplicas;
    const goal = hpa.spec.metrics[0]?.resource.target.averageUtilization ?? 80;
    if (!target) {
      this.fail(hpa, key, "AbleToScale", "FailedGetScale", `the HPA controller was unable to get the target's current scale: ${ref.kind.toLowerCase()}s.apps "${ref.name}" not found`, `${ref.kind} ${ref.name} 이(가) 없음 → 고칠 대상이 없어 아무것도 안 함`);
      return;
    }
    const current = target.spec.replicas;
    if (current === 0) {
      this.status(hpa, current, current, undefined, [["ScalingActive", "False", "ScalingDisabled", "scaling is disabled since the replica count of the target is zero"]]);
      return;
    }
    // 실제처럼 사용률을 보기 전에: 지금 replicas 가 min~max 밖이면 그 끝으로 (horizontal.go reconcileAutoscaler)
    if (current > max || current < min) {
      const to = current > max ? max : min;
      const reason = current > max ? "Current number of replicas above Spec.MaxReplicas" : "Current number of replicas below Spec.MinReplicas";
      this.api.patch(ref.kind, ref.name, ns, HPA, (o) => ((o.spec as { replicas: number }).replicas = to));
      this.api.recordEvent(hpa, "Normal", "SuccessfulRescale", `New size: ${to}; reason: ${reason}`, HPA);
      this.ctx.trace.add(this.name, "controller.reconcile", `${name}: ${ref.kind}/${ref.name} replicas ${current} 가 ${current > max ? `maxReplicas ${max} 보다 큼` : `minReplicas ${min} 보다 작음`} → 사용률을 보기 전에 범위 끝으로 → replicas ${current} → ${to}`, refOf(hpa));
      this.last.set(key, "");
      this.status(hpa, current, to, hpa.status.currentMetrics?.[0], [["AbleToScale", "True", "SucceededRescale", `the HPA controller was able to update the target scale to ${to}`]], now);
      return;
    }
    const pods = this.api
      .peekList("Pod", ns)
      .filter((p) => matchesSelector(p.metadata.labels, target.spec.selector) && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p) && controllerOf(p.metadata));
    // requests 가 없으면 사용률(%)을 낼 수 없다
    for (const p of pods)
      for (const c of p.spec.containers)
        if (!c.resources.requests.cpu) {
          const why = `failed to get cpu utilization: missing request for cpu in container ${c.name} of Pod ${p.metadata.name}`;
          this.api.recordEvent(hpa, "Warning", "FailedGetResourceMetric", why, HPA);
          this.fail(hpa, key, "ScalingActive", "FailedGetResourceMetric", `the HPA was unable to compute the replica count: ${why}`, `${p.metadata.name} 의 컨테이너 ${c.name} 에 requests.cpu 가 없음 → 사용률(requests 대비 %)을 낼 수 없어 TARGETS 가 <unknown> — 늘리지도 줄이지도 않음`);
          return;
        }
    // replica_calculator.go groupPods: Ready 이고 사용량이 있는 것 / Ready 아님(Pending 포함) / Ready 인데 사용량 없음
    const ready: { pod: Pod; cpu: number; req: number }[] = [];
    const unready: { pod: Pod; req: number }[] = [];
    const missing: { pod: Pod; req: number }[] = [];
    for (const p of pods) {
      const req = p.spec.containers.reduce((n, c) => n + c.resources.requests.cpu, 0);
      if (!isPodReady(p)) {
        unready.push({ pod: p, req });
        continue;
      }
      const m = this.metrics(p);
      if (m) ready.push({ pod: p, cpu: m.cpu, req });
      else missing.push({ pod: p, req });
    }
    if (!ready.length) {
      this.fail(hpa, key, "ScalingActive", "FailedGetResourceMetric", "the HPA was unable to compute the replica count: did not receive metrics for targeted pods (pods might be unready)", `Ready 이고 사용량이 있는 Pod 가 없음 → 이번에는 계산하지 않음`);
      return;
    }
    const used = ready.reduce((n, r) => n + r.cpu, 0);
    const reqSum = ready.reduce((n, r) => n + r.req, 0);
    // 실제처럼 정수 나눗셈 (int32(합 × 100 / requests 합))
    const util = Math.floor((used * 100) / reqSum);
    const ratio = util / goal;
    const scaleUpWithUnready = unready.length > 0 && ratio > 1;
    let rec: number;
    let formula: string;
    let note = "";
    if (!scaleUpWithUnready && !missing.length) {
      // Ready 아닌 Pod 는 계산에서 뺀다 (줄일 때도 — 100% 로 치지 않는다)
      if (unready.length) note = ` · Ready 아닌 Pod ${unready.length}개는 빼고 계산`;
      if (Math.abs(ratio - 1) <= TOLERANCE) {
        rec = current;
        formula = `목표와 ${Math.round(Math.abs(ratio - 1) * 100)}% 차이 (10% 안쪽) → 그대로`;
      } else {
        rec = Math.ceil(ratio * ready.length);
        formula = `원하는 ceil(${ready.length} × ${util}%/${goal}%) = ${rec}`;
      }
    } else {
      // 보수적으로 다시: 사용량 없는 Pod 는 줄일 때 max(100%, 목표)·늘릴 때 0%, Ready 아닌 Pod 는 늘릴 때만 0% 로 넣는다
      let used2 = used;
      let req2 = reqSum;
      let n2 = ready.length;
      const parts: string[] = [];
      if (missing.length) {
        for (const m of missing) {
          if (ratio < 1) used2 += (Math.max(100, goal) * m.req) / 100;
          req2 += m.req;
          n2++;
        }
        parts.push(`사용량 없는 Pod ${missing.length}개를 ${ratio < 1 ? `${Math.max(100, goal)}%` : "0%"} 로`);
      }
      if (scaleUpWithUnready) {
        for (const u of unready) {
          req2 += u.req;
          n2++;
        }
        parts.push(`Ready 아닌 Pod ${unready.length}개를 0% 로`);
      }
      const util2 = Math.floor((used2 * 100) / req2);
      const ratio2 = util2 / goal;
      note = ` · ${parts.join(", ")} 쳐서 다시 ${util2}%`;
      if (Math.abs(ratio2 - 1) <= TOLERANCE || (ratio < 1 && ratio2 > 1) || (ratio > 1 && ratio2 < 1)) {
        rec = current;
        formula = "목표와 가깝거나 방향이 바뀜 → 그대로";
      } else {
        rec = Math.ceil(ratio2 * n2);
        if ((ratio2 > 1 && rec < current) || (ratio2 < 1 && rec > current)) rec = current;
        formula = `원하는 ceil(${n2} × ${util2}%/${goal}%) = ${rec}`;
      }
    }
    // 줄이기 안정화: 지난 5분 추천(정책으로 자르기 전 값) 중 가장 큰 것
    const hist = (this.recs.get(key) ?? []).filter((r) => now - r.t < SCALE_DOWN_WINDOW_MS);
    hist.push({ t: now, n: rec });
    this.recs.set(key, hist);
    let desired = rec;
    let held = "";
    if (rec < current) {
      const top = Math.max(...hist.map((r) => r.n));
      if (top > rec) {
        desired = Math.min(current, top);
        const since = hist.find((r) => r.n === top)!.t;
        held = ` · 줄이기 안정화: 지난 5분 추천 중 가장 큰 ${top} 를 따름 (${Math.ceil((since + SCALE_DOWN_WINDOW_MS - now) / 1000)}초 뒤 풀림)`;
      }
    }
    // 늘리기 정책(15초에 두 배 또는 +4)과 min~max (normalizeDesiredReplicasWithBehaviors)
    let clamped = desired;
    let limit: [string, "True" | "False", string, string] = ["ScalingLimited", "False", "DesiredWithinRange", "the desired count is within the acceptable range"];
    let bound = "";
    if (desired > current) {
      const cap = Math.max(current * 2, current + 4);
      const allowed = Math.min(max, cap);
      if (desired > allowed) {
        clamped = allowed;
        if (max > cap) {
          limit = ["ScalingLimited", "True", "ScaleUpLimit", "the desired replica count is increasing faster than the maximum scale rate"];
          bound = ` · 한 번에 늘릴 수 있는 만큼(두 배 또는 +4)만 ${cap}`;
        } else {
          limit = ["ScalingLimited", "True", "TooManyReplicas", "the desired replica count is more than the maximum replica count"];
          bound = ` · maxReplicas ${max} 로 자름`;
        }
      }
    } else if (desired < min) {
      clamped = min;
      limit = ["ScalingLimited", "True", "TooFewReplicas", "the desired replica count is less than the minimum replica count"];
      bound = ` · minReplicas ${min} 로 자름`;
    }
    const metric = { type: "Resource" as const, resource: { name: "cpu" as const, current: { averageUtilization: util, averageValue: Math.round(used / ready.length) } } };
    const msg = `${name}: ${ref.kind}/${ref.name} cpu 사용 ${fmtCpu(used)} / requests ${fmtCpu(reqSum)} = ${util}% (목표 ${goal}%)${note} → ${formula}${held}${bound}`;
    if (clamped !== current) {
      this.api.patch(ref.kind, ref.name, ns, HPA, (o) => ((o.spec as { replicas: number }).replicas = clamped));
      const reason = clamped > current ? "cpu resource utilization (percentage of request) above target" : "All metrics below target";
      this.api.recordEvent(hpa, "Normal", "SuccessfulRescale", `New size: ${clamped}; reason: ${reason}`, HPA);
      this.ctx.trace.add(this.name, "controller.reconcile", `${msg} → replicas ${current} → ${clamped}`, refOf(hpa));
      this.last.set(key, "");
      this.status(hpa, current, clamped, metric, [["AbleToScale", "True", "SucceededRescale", `the HPA controller was able to update the target scale to ${clamped}`], ["ScalingActive", "True", "ValidMetricFound", "the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)"], limit], now);
      return;
    }
    // 바뀐 게 없으면 판단이 달라졌을 때만 적는다 (15초마다 같은 줄이 쌓이지 않게)
    const quiet = `${util}|${rec}|${held ? "held" : ""}|${bound}`;
    if (this.last.get(key) !== quiet) {
      this.last.set(key, quiet);
      this.ctx.trace.add(this.name, "controller.reconcile", `${msg} → replicas ${current} 그대로`, refOf(hpa));
    }
    this.status(hpa, current, clamped, metric, [
      held ? ["AbleToScale", "True", "ScaleDownStabilized", "recent recommendations were higher than current one, applying the highest recent recommendation"] : ["AbleToScale", "True", "ReadyForNewScale", "recommended size matches current size"],
      ["ScalingActive", "True", "ValidMetricFound", "the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)"],
      limit,
    ]);
  }

  private fail(hpa: HorizontalPodAutoscaler, key: string, type: string, reason: string, message: string, why: string): void {
    if (this.last.get(key) !== reason) {
      this.last.set(key, reason);
      this.ctx.trace.add(this.name, "controller.reconcile", `${hpa.metadata.name}: ${why}`, refOf(hpa));
    }
    this.api.patch("HorizontalPodAutoscaler", hpa.metadata.name, hpa.metadata.namespace, HPA, (o) => {
      o.status.currentMetrics = undefined;
      setCondition(o, type, "False", this.now, reason, message);
    });
  }

  private status(hpa: HorizontalPodAutoscaler, current: number, desired: number, metric: NonNullable<HorizontalPodAutoscaler["status"]["currentMetrics"]>[number] | undefined, conds: [string, "True" | "False", string, string][], scaled?: number): void {
    this.api.patch("HorizontalPodAutoscaler", hpa.metadata.name, hpa.metadata.namespace, HPA, (o) => {
      o.status.currentReplicas = current;
      o.status.desiredReplicas = desired;
      o.status.currentMetrics = metric ? [metric] : undefined;
      if (scaled !== undefined) o.status.lastScaleTime = scaled;
      o.status.observedGeneration = o.metadata.generation;
      for (const [t, s, r, m] of conds) setCondition(o, t, s, this.now, r, m);
    });
  }
}
