// ReplicaSet 컨트롤러: 원하는 수(spec.replicas) vs 셀렉터에 맞고 이 ReplicaSet 이 주인인 살아 있는 Pod 수 → 모자라면 만들고 남으면 지운다.
// 축소판: 실제는 한 번에 만드는 수를 1·2·4… 로 늘리는 slow start 와 "expectations"(캐시 지연 보정)가 있다 — 여기서는 API 를 직접 읽어 필요 없다.
import { refOf } from "../api/server";
import { controllerOf, isPodReady, isPodTerminal, type Pod, type ReplicaSet } from "../api/types";
import { randomSuffix, type Rng } from "../rng";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";

export class ReplicaSetController extends Controller {
  constructor(
    ctx: ComponentContext,
    private readonly rng: Rng,
  ) {
    super("replicaset-controller", ctx);
    ctx.api.watch("ReplicaSet", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("Pod", (ev) => {
      const owner = controllerOf(ev.object.metadata);
      if (owner?.kind === "ReplicaSet") this.enqueue(nsKey(ev.object.metadata.namespace, owner.name));
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const rs = this.api.get("ReplicaSet", name, ns);
    if (!rs || rs.metadata.deletionTimestamp !== undefined) return;
    const owned = this.api.list("Pod", ns).filter((p) => controllerOf(p.metadata)?.uid === rs.metadata.uid);
    const active = owned.filter((p) => p.metadata.deletionTimestamp === undefined && !isPodTerminal(p));
    const want = rs.spec.replicas;
    const diff = want - active.length;
    if (diff > 0) {
      const made: string[] = [];
      for (let i = 0; i < diff; i++) made.push(this.createPod(rs));
      this.ctx.trace.add(
        this.name,
        "controller.reconcile",
        `${rs.metadata.name} 원하는 ${want} · 있는 ${active.length} → Pod ${diff}개 생성 (${made.join(", ")})`,
        refOf(rs),
      );
    } else if (diff < 0) {
      const victims = [...active].sort(deletionOrder).slice(0, -diff);
      for (const p of victims) {
        this.api.delete("Pod", p.metadata.name, ns, this.name);
        this.api.recordEvent(rs, "Normal", "SuccessfulDelete", `Deleted pod: ${p.metadata.name}`, this.name);
      }
      this.ctx.trace.add(
        this.name,
        "controller.reconcile",
        `${rs.metadata.name} 원하는 ${want} · 있는 ${active.length} → Pod ${-diff}개 삭제 (${victims.map((p) => p.metadata.name).join(", ")} — 아직 안 뜬 것·최근 것부터)`,
        refOf(rs),
      );
    }
    this.updateStatus(rs, ns);
  }

  private createPod(rs: ReplicaSet): string {
    const ns = rs.metadata.namespace;
    for (;;) {
      // generateName 처럼: 앞부분을 58자로 잘라 접미사 5자를 붙인다 (maxGeneratedNameLength)
      const name = `${`${rs.metadata.name}-`.slice(0, 58)}${randomSuffix(this.rng)}`;
      if (this.api.get("Pod", name, ns)) continue;
      const spec = structuredClone(rs.spec.template.spec);
      delete spec.nodeName;
      this.api.create<"Pod">(
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name,
            namespace: ns,
            labels: { ...rs.spec.template.metadata.labels },
            ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: rs.metadata.name, uid: rs.metadata.uid, controller: true }],
          },
          spec,
        },
        this.name,
      );
      this.api.recordEvent(rs, "Normal", "SuccessfulCreate", `Created pod: ${name}`, this.name);
      return name;
    }
  }

  private updateStatus(rs: ReplicaSet, ns: string): void {
    this.api.patch("ReplicaSet", rs.metadata.name, ns, this.name, (cur) => {
      const pods = this.api
        .list("Pod", ns)
        .filter((p) => controllerOf(p.metadata)?.uid === cur.metadata.uid && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p));
      const ready = pods.filter(isPodReady).length;
      cur.status = { replicas: pods.length, readyReplicas: ready, availableReplicas: ready, observedGeneration: cur.metadata.generation };
    });
  }
}

/** 지울 Pod 고르는 순서 (실제 ActivePods 정렬의 축소판): 노드 없음 → Pending → 준비 안 됨 → 재시작 많음 → 최근 생성 */
function deletionOrder(a: Pod, b: Pod): number {
  const rank = (p: Pod) => [
    p.spec.nodeName ? 1 : 0,
    p.status.phase === "Pending" ? 0 : 1,
    isPodReady(p) ? 1 : 0,
    -Math.max(0, ...p.status.containerStatuses.map((c) => c.restartCount)),
    -p.metadata.creationTimestamp,
  ];
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
  return a.metadata.name < b.metadata.name ? 1 : -1;
}
