// StatefulSet 컨트롤러: Pod 이름이 <이름>-0, -1 … 로 고정되고, Pod 마다 자기 PVC(<템플릿>-<이름>-<번호>)를 갖는다.
// OrderedReady(기본): 앞 번호가 Running·Ready 여야 다음 번호를 만들고, 줄일 때는 큰 번호부터 하나씩. 지운 Pod 는 같은 이름·같은 PVC 로 다시 만든다 —
// 옛 Pod 가 아직 지워지는 중(Terminating)이면 이름이 겹쳐 기다린다(at most one). 템플릿이 바뀌면 큰 번호부터 하나씩 지워 새 템플릿으로 다시 만든다.
// PVC 는 StatefulSet 이 주인이 아니라(Retain) 줄이거나 StatefulSet 을 지워도 남는다.
// 축소판: ControllerRevision 오브젝트 없음(해시만), partition·maxUnavailable·minReadySeconds·persistentVolumeClaimRetentionPolicy 없음.
import { ApiError, refOf } from "../api/server";
import { controllerOf, isPodReady, isPodTerminal, type Pod, type StatefulSet } from "../api/types";
import { stableJson, templateHash } from "../rng";
import { LOCAL_PATH } from "../storage";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";

export const REVISION_LABEL = "controller-revision-hash";
export const POD_NAME_LABEL = "statefulset.kubernetes.io/pod-name";

export function stsRevision(sts: StatefulSet): string {
  return `${sts.metadata.name}-${templateHash(stableJson(sts.spec.template))}`;
}

export function ordinalOf(sts: string, pod: string): number | undefined {
  const m = new RegExp(`^${sts.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`).exec(pod);
  return m ? Number(m[1]) : undefined;
}

export function claimName(template: string, sts: string, i: number): string {
  return `${template}-${sts}-${i}`;
}

export class StatefulSetController extends Controller {
  /** 같은 기다림을 되풀이해 적지 않게 (StatefulSet 마다 마지막 기다림 문구) */
  private readonly waiting = new Map<string, string>();

  constructor(ctx: ComponentContext) {
    super("statefulset-controller", ctx);
    ctx.api.watch("StatefulSet", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("Pod", (ev) => {
      const owner = controllerOf(ev.object.metadata);
      if (owner?.kind === "StatefulSet") this.enqueue(nsKey(ev.object.metadata.namespace, owner.name));
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const sts = this.api.get("StatefulSet", name, ns);
    if (!sts || sts.metadata.deletionTimestamp !== undefined) return;
    const rev = stsRevision(sts);
    const ordered = (sts.spec.podManagementPolicy ?? "OrderedReady") === "OrderedReady";
    const owned = this.api.peekList("Pod", ns).filter((p) => controllerOf(p.metadata)?.uid === sts.metadata.uid);
    const byOrd = new Map<number, Pod>();
    for (const p of owned) {
      const i = ordinalOf(name, p.metadata.name);
      if (i !== undefined) byOrd.set(i, p);
    }
    const want = sts.spec.replicas;
    const healthy = (p: Pod | undefined) => !!p && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p) && p.status.phase === "Running" && isPodReady(p);
    let wait: string | undefined;

    // 1) 없는 번호를 앞에서부터 (OrderedReady: 앞 번호가 모두 Running·Ready 일 때만, 한 번에 하나)
    for (let i = 0; i < want; i++) {
      const p = byOrd.get(i);
      if (!p) {
        if (this.createPod(sts, i, rev) === "exists") {
          wait = `${name}-${i} 의 옛 Pod 가 아직 지워지는 중 → 같은 이름이라 다 지워질 때까지 기다림 (StatefulSet 은 같은 번호의 Pod 를 둘 두지 않는다)`;
        }
        if (ordered) break;
        continue;
      }
      if (p.metadata.deletionTimestamp !== undefined) {
        wait = `${p.metadata.name} 이(가) 지워지는 중 → 다 지워지면 같은 이름·같은 PVC 로 다시 만든다`;
        if (ordered) break;
        continue;
      }
      if (ordered && !healthy(p)) {
        if (i + 1 < want && !byOrd.get(i + 1)) wait = `${name}-${i + 1} 을(를) 만들기 전에 ${p.metadata.name} 이(가) Running·Ready 가 되기를 기다림 (OrderedReady)`;
        break;
      }
    }

    // 2) 줄이기: OrderedReady 는 큰 번호부터 하나씩 (지우는 중인 것이 있으면 기다림), Parallel 은 한꺼번에
    const extra = [...byOrd.entries()].filter(([i]) => i >= want).sort((a, b) => b[0] - a[0]);
    let acted = false;
    if (!ordered) {
      const victims = extra.map(([, p]) => p).filter((p) => p.metadata.deletionTimestamp === undefined);
      for (const v of victims) {
        this.api.delete("Pod", v.metadata.name, ns, this.name);
        this.api.recordEvent(sts, "Normal", "SuccessfulDelete", `delete Pod ${v.metadata.name} in StatefulSet ${name} successful`, this.name);
      }
      if (victims.length) {
        acted = true;
        this.ctx.trace.add(this.name, "controller.reconcile", `${name} 원하는 ${want} → ${victims.map((v) => v.metadata.name).join(", ")} 를 한꺼번에 지움 (Parallel — 순서를 기다리지 않음, PVC 는 남김)`, refOf(sts));
      }
    } else if (extra.length && !owned.some((p) => p.metadata.deletionTimestamp !== undefined)) {
      const lowerReady = !ordered || [...byOrd.entries()].filter(([i]) => i < want).every(([, p]) => healthy(p));
      if (lowerReady) {
        const [, victim] = extra[0]!;
        acted = true;
        this.api.delete("Pod", victim.metadata.name, ns, this.name);
        this.api.recordEvent(sts, "Normal", "SuccessfulDelete", `delete Pod ${victim.metadata.name} in StatefulSet ${name} successful`, this.name);
        this.ctx.trace.add(this.name, "controller.reconcile", `${name} 원하는 ${want} · 있는 ${byOrd.size} → 가장 큰 번호 ${victim.metadata.name} 부터 지움 (PVC 는 남김 — 다시 늘리면 그 데이터로)`, refOf(sts));
      }
    }

    // 3) 템플릿이 바뀜: 모두 Ready 이고 지우는 중인 것이 없을 때 큰 번호부터 하나씩 지워 새 템플릿으로 (RollingUpdate) — 축소가 먼저, 한 번에 하나
    if (!acted && !owned.some((p) => p.metadata.deletionTimestamp !== undefined) && (sts.spec.updateStrategy?.type ?? "RollingUpdate") === "RollingUpdate") {
      const live = [...byOrd.entries()].filter(([i]) => i < want).sort((a, b) => b[0] - a[0]);
      const allReady = live.length === want && live.every(([, p]) => healthy(p));
      const stale = live.find(([, p]) => p.metadata.labels[REVISION_LABEL] !== rev);
      if (allReady && stale) {
        const p = stale[1];
        this.api.delete("Pod", p.metadata.name, ns, this.name);
        this.ctx.trace.add(this.name, "controller.reconcile", `${name} 템플릿이 바뀜 (리비전 ${rev}) → 큰 번호부터 하나씩: ${p.metadata.name} 을(를) 지우고 새 템플릿으로 다시 만든다 (나머지는 그동안 그대로)`, refOf(sts));
      }
    }

    if (wait && this.waiting.get(key) !== wait) this.ctx.trace.add(this.name, "controller.reconcile", `${name}: ${wait}`, refOf(sts));
    if (wait) this.waiting.set(key, wait);
    else this.waiting.delete(key);
    this.updateStatus(sts, rev);
  }

  /** 번호 i 의 Pod (와 없으면 PVC) 를 만든다. 같은 이름의 Pod 가 아직 있으면 "exists" */
  private createPod(sts: StatefulSet, i: number, rev: string): "created" | "exists" {
    const ns = sts.metadata.namespace ?? "default";
    const name = `${sts.metadata.name}-${i}`;
    if (this.api.get("Pod", name, ns)) return "exists";
    const madeClaims: string[] = [];
    for (const t of sts.spec.volumeClaimTemplates ?? []) {
      const claim = claimName(t.metadata.name, sts.metadata.name, i);
      if (this.api.get("PersistentVolumeClaim", claim, ns)) continue;
      this.api.create<"PersistentVolumeClaim">(
        {
          apiVersion: "v1",
          kind: "PersistentVolumeClaim",
          metadata: { name: claim, namespace: ns, labels: { ...sts.spec.selector.matchLabels } },
          spec: { ...structuredClone(t.spec), storageClassName: t.spec.storageClassName ?? LOCAL_PATH },
        },
        this.name,
      );
      this.api.recordEvent(sts, "Normal", "SuccessfulCreate", `create Claim ${claim} Pod ${name} in StatefulSet ${sts.metadata.name} success`, this.name);
      madeClaims.push(claim);
    }
    const spec = structuredClone(sts.spec.template.spec);
    delete spec.nodeName;
    spec.hostname = name;
    spec.subdomain = sts.spec.serviceName;
    const claimVols = (sts.spec.volumeClaimTemplates ?? []).map((t) => ({ name: t.metadata.name, persistentVolumeClaim: { claimName: claimName(t.metadata.name, sts.metadata.name, i) } }));
    spec.volumes = [...(spec.volumes ?? []).filter((v) => !claimVols.some((c) => c.name === v.name)), ...claimVols];
    try {
      this.api.create<"Pod">(
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name,
            namespace: ns,
            labels: { ...sts.spec.template.metadata.labels, [POD_NAME_LABEL]: name, [REVISION_LABEL]: rev, "apps.kubernetes.io/pod-index": String(i) },
            ...(sts.spec.template.metadata.annotations ? { annotations: { ...sts.spec.template.metadata.annotations } } : {}),
            ownerReferences: [{ apiVersion: "apps/v1", kind: "StatefulSet", name: sts.metadata.name, uid: sts.metadata.uid, controller: true }],
          },
          spec,
        },
        this.name,
      );
    } catch (e) {
      if (e instanceof ApiError && e.reason === "AlreadyExists") return "exists";
      throw e;
    }
    this.api.recordEvent(sts, "Normal", "SuccessfulCreate", `create Pod ${name} in StatefulSet ${sts.metadata.name} successful`, this.name);
    this.ctx.trace.add(
      this.name,
      "controller.reconcile",
      `${sts.metadata.name} 원하는 ${sts.spec.replicas} → ${name} 생성 (고정 이름·번호 ${i}${i ? ` — 앞 번호가 Running·Ready` : ""})${madeClaims.length ? ` · PVC ${madeClaims.join(", ")} 생성` : (sts.spec.volumeClaimTemplates?.length ? ` · 있던 PVC ${claimVols.map((c) => c.persistentVolumeClaim.claimName).join(", ")} 를 그대로 씀` : "")}`,
      refOf(sts),
    );
    return "created";
  }

  private updateStatus(sts: StatefulSet, rev: string): void {
    const ns = sts.metadata.namespace ?? "default";
    this.api.patch("StatefulSet", sts.metadata.name, ns, this.name, (cur) => {
      const pods = this.api.peekList("Pod", ns).filter((p) => controllerOf(p.metadata)?.uid === cur.metadata.uid && p.metadata.deletionTimestamp === undefined && !isPodTerminal(p));
      const ready = pods.filter(isPodReady).length;
      const updated = pods.filter((p) => p.metadata.labels[REVISION_LABEL] === rev).length;
      const currentRevision = updated === pods.length && pods.length === cur.spec.replicas ? rev : (cur.status.currentRevision ?? rev);
      cur.status = {
        replicas: pods.length,
        readyReplicas: ready,
        availableReplicas: ready,
        currentReplicas: pods.filter((p) => p.metadata.labels[REVISION_LABEL] === currentRevision).length,
        updatedReplicas: updated,
        currentRevision,
        updateRevision: rev,
        observedGeneration: cur.metadata.generation,
      };
    });
  }
}
