// Deployment 컨트롤러: Pod 템플릿의 해시로 "지금 템플릿용 ReplicaSet" 을 찾거나 만들고, replicas 를 그쪽에 둔다.
// 축소판: 템플릿이 바뀌면 옛 ReplicaSet 을 바로 0 으로 줄인다 (Recreate 와 비슷). 롤링 업데이트(maxSurge·maxUnavailable)는 3단계.
import { refOf } from "../api/server";
import { controllerOf, type Deployment, type ReplicaSet } from "../api/types";
import { templateHash } from "../rng";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";

export const HASH_LABEL = "pod-template-hash";

export class DeploymentController extends Controller {
  constructor(ctx: ComponentContext) {
    super("deployment-controller", ctx);
    ctx.api.watch("Deployment", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("ReplicaSet", (ev) => {
      const owner = controllerOf(ev.object.metadata);
      if (owner?.kind === "Deployment") this.enqueue(nsKey(ev.object.metadata.namespace, owner.name));
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const d = this.api.get("Deployment", name, ns);
    if (!d || d.metadata.deletionTimestamp !== undefined) return;
    const hash = templateHash(d.spec.template);
    const owned = this.api.list("ReplicaSet", ns).filter((rs) => controllerOf(rs.metadata)?.uid === d.metadata.uid);
    let cur = owned.find((rs) => rs.metadata.labels[HASH_LABEL] === hash);
    if (!cur) {
      cur = this.createReplicaSet(d, hash);
      this.ctx.trace.add(
        this.name,
        "controller.reconcile",
        `${d.metadata.name} 템플릿 해시 ${hash} 의 ReplicaSet 이 없음 → ReplicaSet ${cur.metadata.name} 생성 (replicas ${d.spec.replicas})`,
        refOf(d),
      );
      this.api.recordEvent(d, "Normal", "ScalingReplicaSet", `Scaled up replica set ${cur.metadata.name} from 0 to ${d.spec.replicas}`, this.name);
    } else if (cur.spec.replicas !== d.spec.replicas) {
      const from = cur.spec.replicas;
      cur = this.scale(cur, d.spec.replicas);
      this.ctx.trace.add(
        this.name,
        "controller.reconcile",
        `${d.metadata.name} 원하는 replicas ${d.spec.replicas} · ReplicaSet ${cur.metadata.name} 은 ${from} → ${d.spec.replicas} 로 조정`,
        refOf(d),
      );
      this.api.recordEvent(d, "Normal", "ScalingReplicaSet", `Scaled ${d.spec.replicas > from ? "up" : "down"} replica set ${cur.metadata.name} from ${from} to ${d.spec.replicas}`, this.name);
    }
    for (const old of owned) {
      if (old.metadata.uid === cur.metadata.uid || old.spec.replicas === 0) continue;
      const from = old.spec.replicas;
      this.scale(old, 0);
      this.ctx.trace.add(this.name, "controller.reconcile", `${d.metadata.name} 의 옛 템플릿 ReplicaSet ${old.metadata.name} → 0 으로 축소 (축소판: 롤링 업데이트는 3단계)`, refOf(old));
      this.api.recordEvent(d, "Normal", "ScalingReplicaSet", `Scaled down replica set ${old.metadata.name} from ${from} to 0`, this.name);
    }
    this.updateStatus(d, ns, hash);
  }

  private createReplicaSet(d: Deployment, hash: string): ReplicaSet {
    const labels = { ...d.spec.template.metadata.labels, [HASH_LABEL]: hash };
    return this.api.create<"ReplicaSet">(
      {
        apiVersion: "apps/v1",
        kind: "ReplicaSet",
        metadata: {
          name: `${d.metadata.name}-${hash}`,
          namespace: d.metadata.namespace,
          labels,
          ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: d.metadata.name, uid: d.metadata.uid, controller: true }],
        },
        spec: {
          replicas: d.spec.replicas,
          selector: { matchLabels: { ...d.spec.selector.matchLabels, [HASH_LABEL]: hash } },
          template: { metadata: { labels }, spec: structuredClone(d.spec.template.spec) },
        },
      },
      this.name,
    );
  }

  private scale(rs: ReplicaSet, replicas: number): ReplicaSet {
    return this.api.patch("ReplicaSet", rs.metadata.name, rs.metadata.namespace, this.name, (o) => {
      o.spec.replicas = replicas;
    })!;
  }

  private updateStatus(d: Deployment, ns: string, hash: string): void {
    this.api.patch("Deployment", d.metadata.name, ns, this.name, (cur) => {
      const owned = this.api.list("ReplicaSet", ns).filter((rs) => controllerOf(rs.metadata)?.uid === cur.metadata.uid);
      const sum = (f: (rs: ReplicaSet) => number) => owned.reduce((n, rs) => n + f(rs), 0);
      cur.status = {
        replicas: sum((rs) => rs.status.replicas),
        updatedReplicas: owned.find((rs) => rs.metadata.labels[HASH_LABEL] === hash)?.status.replicas ?? 0,
        readyReplicas: sum((rs) => rs.status.readyReplicas),
        availableReplicas: sum((rs) => rs.status.availableReplicas),
        observedGeneration: cur.metadata.generation,
      };
    });
  }
}
