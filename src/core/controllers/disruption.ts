// disruption 컨트롤러: PodDisruptionBudget 마다 지금 건강한(Ready) Pod 수와 최소로 남겨야 할 수를 계산해 disruptionsAllowed 를 적는다.
// Eviction API(drain)는 이 값을 보고 허락하거나 거절한다 (자발적 중단만 막는다 — 노드가 죽는 것은 못 막는다).
// 축소판: expectedPods 는 셀렉터에 맞는 Pod 를 만든 ReplicaSet 들의 replicas 합 (없으면 맞는 Pod 수).
import { refOf } from "../api/server";
import { controllerOf, isPodReady, isPodTerminal, matchesSelector, type PodDisruptionBudget } from "../api/types";
import { stableJson } from "../rng";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";
import { resolveIntOrPercent } from "./deployment";

export class DisruptionController extends Controller {
  constructor(ctx: ComponentContext) {
    super("disruption-controller", ctx);
    ctx.api.watch("PodDisruptionBudget", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("Pod", (ev) => {
      const ns = ev.object.metadata.namespace ?? "default";
      for (const b of ctx.api.peekList("PodDisruptionBudget", ns)) if (matchesSelector(ev.object.metadata.labels, b.spec.selector)) this.enqueue(nsKey(ns, b.metadata.name));
    });
    ctx.api.watch("ReplicaSet", (ev) => {
      const ns = ev.object.metadata.namespace ?? "default";
      for (const b of ctx.api.peekList("PodDisruptionBudget", ns)) this.enqueue(nsKey(ns, b.metadata.name));
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const b = this.api.get("PodDisruptionBudget", name, ns);
    if (!b) return;
    const status = computePdbStatus(b, this.api.peekList("Pod", ns), this.api.peekList("ReplicaSet", ns), this.api.peekList("Deployment", ns));
    if (stableJson(status) === stableJson(b.status)) return;
    const before = b.status.disruptionsAllowed;
    this.api.patch("PodDisruptionBudget", name, ns, this.name, (o) => {
      o.status = status;
    });
    if (before !== status.disruptionsAllowed)
      this.ctx.trace.add(this.name, "controller.reconcile", `PDB ${name}: Ready ${status.currentHealthy} · 최소 ${status.desiredHealthy} → 지금 중단 허용 ${status.disruptionsAllowed}개`, refOf(b));
  }
}

export function computePdbStatus(
  b: PodDisruptionBudget,
  pods: readonly import("../api/types").Pod[],
  rss: readonly import("../api/types").ReplicaSet[],
  deps: readonly import("../api/types").Deployment[] = [],
): PodDisruptionBudget["status"] {
  const mine = pods.filter((p) => matchesSelector(p.metadata.labels, b.spec.selector) && !isPodTerminal(p));
  // 기대 수: Pod 의 주인(scale 을 가진 것)의 replicas — RS 가 Deployment 의 것이면 Deployment 의 replicas (롤아웃 중 RS 합이 아니라)
  const scales = new Map<string, number>();
  let orphans = 0;
  for (const p of mine) {
    const ref = controllerOf(p.metadata);
    const rs = ref ? rss.find((r) => r.metadata.uid === ref.uid) : undefined;
    if (!rs) {
      orphans++;
      continue;
    }
    const dref = controllerOf(rs.metadata);
    const d = dref ? deps.find((x) => x.metadata.uid === dref.uid) : undefined;
    if (d) scales.set(d.metadata.uid, d.spec.replicas);
    else scales.set(rs.metadata.uid, rs.spec.replicas);
  }
  const expected = [...scales.values()].reduce((n, x) => n + x, 0) + orphans;
  const healthy = mine.filter((p) => isPodReady(p) && p.metadata.deletionTimestamp === undefined).length;
  let desired: number;
  if (b.spec.maxUnavailable !== undefined) desired = Math.max(0, expected - resolveIntOrPercent(b.spec.maxUnavailable, expected, true));
  else desired = resolveIntOrPercent(b.spec.minAvailable ?? 1, expected, true);
  return { currentHealthy: healthy, desiredHealthy: desired, disruptionsAllowed: Math.max(0, healthy - desired), expectedPods: expected, observedGeneration: b.metadata.generation };
}
