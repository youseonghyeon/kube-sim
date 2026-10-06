// 스토리지: k3s 기본 StorageClass local-path (rancher.io/local-path) 흉내.
// - WaitForFirstConsumer: PVC 는 그것을 쓰는 Pod 가 노드에 정해질 때까지 Pending. 스케줄러가 PVC 에 selected-node 를 적으면
//   프로비저너가 그 노드의 디렉터리로 PV 를 만들고(nodeAffinity = 그 노드) PVC 와 묶는다 → 이후 그 PVC 를 쓰는 Pod 는 그 노드에만 갈 수 있다.
// - PVC 를 지우면 reclaimPolicy Delete 라 PV 와 데이터도 지운다.
// - 데이터(앱이 적은 것)는 API 오브젝트가 아니라 노드 디스크라 여기 따로 둔다 (PV 이름 → 내용).
// - PV 에는 pv-protection finalizer: 묶인 PVC 가 있는 동안 PV 를 지우면 Terminating 으로 남고(데이터 그대로), PVC 가 사라지면 그때 지운다.
// 축소판: 용량 검사·확장, pvc-protection finalizer(쓰는 Pod 가 있으면 PVC 가 Terminating 으로 남음), 다른 StorageClass·Immediate 바인딩의 정적 PV 짝짓기 없음.
import { refOf } from "./api/server";
import type { PersistentVolumeClaim, Pod } from "./api/types";
import { Controller, nsKey, splitKey, type ComponentContext } from "./controllers/base";

export const LOCAL_PATH = "local-path";
export const LOCAL_PATH_PROVISIONER = "rancher.io/local-path";
export const SELECTED_NODE = "volume.kubernetes.io/selected-node";
export const DEFAULT_SC_ANNOTATION = "storageclass.kubernetes.io/is-default-class";
/** 묶인 PVC 가 있는 동안 PV 를 지워도 Terminating 으로 남게 (실제 pv-protection) */
export const PV_PROTECTION = "kubernetes.io/pv-protection";
const ACTOR = "local-path-provisioner";

/** 노드 디스크에 남는 앱 데이터 (PV 이름 → 키·값) */
export type VolumeData = Map<string, Record<string, string>>;

/** PV 가 묶인 노드 (local-path 의 nodeAffinity) */
export function pvNode(pv: { spec: { nodeAffinity?: { required: { nodeSelectorTerms: { matchExpressions: { key: string; values: string[] }[] }[] } } } }): string | undefined {
  return pv.spec.nodeAffinity?.required.nodeSelectorTerms[0]?.matchExpressions.find((e) => e.key === "kubernetes.io/hostname")?.values[0];
}

/** Pod 가 쓰는 PVC 이름들 */
export function podClaims(p: Pod): { volume: string; claim: string }[] {
  return (p.spec.volumes ?? []).flatMap((v) => (v.persistentVolumeClaim ? [{ volume: v.name, claim: v.persistentVolumeClaim.claimName }] : []));
}

export class LocalPathProvisioner extends Controller {
  /** 이미 "기다림" 이벤트를 남긴 PVC (같은 말을 되풀이하지 않게) */
  private readonly waitedFor = new Set<string>();

  constructor(
    ctx: ComponentContext,
    private readonly data: VolumeData,
  ) {
    super(ACTOR, ctx);
    ctx.api.watch("PersistentVolumeClaim", (ev) => {
      const key = nsKey(ev.object.metadata.namespace, ev.object.metadata.name);
      if (ev.type === "DELETED") this.reclaim(ev.object);
      else this.enqueue(key);
    });
    // pv-protection: 지우는 중인 PV 의 PVC 가 이미 없으면 finalizer 를 빼서 정말 지운다
    ctx.api.watch("PersistentVolume", (ev) => {
      const pv = ev.object;
      if (ev.type === "DELETED" || pv.metadata.deletionTimestamp === undefined) return;
      const claim = pv.spec.claimRef;
      if (claim && this.api.get("PersistentVolumeClaim", claim.name, claim.namespace)) return;
      this.release(pv.metadata.name);
    });
  }

  /** finalizer 를 빼고 (지우는 중이 아니면) 지운다 — PV 와 데이터가 사라진다 */
  private release(pvName: string): void {
    const pv = this.api.get("PersistentVolume", pvName);
    if (!pv) return;
    const deleting = pv.metadata.deletionTimestamp !== undefined;
    this.api.patch("PersistentVolume", pvName, undefined, this.name, (o) => (o.metadata.finalizers = (o.metadata.finalizers ?? []).filter((f) => f !== PV_PROTECTION)));
    if (!deleting && this.api.get("PersistentVolume", pvName)) this.api.delete("PersistentVolume", pvName, undefined, this.name);
    this.data.delete(pvName);
  }

  /** 기본 StorageClass 를 둔다 (k3s 가 설치할 때 만드는 것) */
  static install(ctx: ComponentContext): void {
    if (ctx.api.get("StorageClass", LOCAL_PATH)) return;
    ctx.api.create<"StorageClass">(
      {
        apiVersion: "storage.k8s.io/v1",
        kind: "StorageClass",
        metadata: { name: LOCAL_PATH, annotations: { [DEFAULT_SC_ANNOTATION]: "true" } },
        provisioner: LOCAL_PATH_PROVISIONER,
        reclaimPolicy: "Delete",
        volumeBindingMode: "WaitForFirstConsumer",
      },
      "k3s",
    );
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const pvc = this.api.get("PersistentVolumeClaim", name, ns);
    if (!pvc || pvc.status.phase === "Bound" || (pvc.spec.storageClassName ?? LOCAL_PATH) !== LOCAL_PATH) return;
    const node = pvc.metadata.annotations?.[SELECTED_NODE];
    if (!node) {
      if (!this.waitedFor.has(pvc.metadata.uid)) {
        this.waitedFor.add(pvc.metadata.uid);
        this.api.recordEvent(pvc, "Normal", "WaitForFirstConsumer", "waiting for first consumer to be created before binding", "persistentvolume-controller");
        this.ctx.trace.add(this.name, "storage", `PVC ${name} — StorageClass ${LOCAL_PATH} 는 WaitForFirstConsumer → 이 PVC 를 쓰는 Pod 가 노드에 정해질 때까지 Pending (디스크를 어느 노드에 만들지 모름)`, refOf(pvc));
      }
      return;
    }
    const pvName = `pvc-${pvc.metadata.uid.slice(-12)}`;
    const path = `/var/lib/rancher/k3s/storage/${pvName}_${ns}_${name}`;
    this.api.recordEvent(pvc, "Normal", "Provisioning", `External provisioner is provisioning volume for claim "${ns}/${name}"`, `${LOCAL_PATH_PROVISIONER}_${ACTOR}`);
    this.api.create<"PersistentVolume">(
      {
        apiVersion: "v1",
        kind: "PersistentVolume",
        metadata: { name: pvName, annotations: { "pv.kubernetes.io/provisioned-by": LOCAL_PATH_PROVISIONER }, finalizers: [PV_PROTECTION] },
        spec: {
          capacity: { storage: pvc.spec.resources.requests.storage },
          accessModes: [...pvc.spec.accessModes],
          persistentVolumeReclaimPolicy: "Delete",
          storageClassName: LOCAL_PATH,
          claimRef: { name, namespace: ns, uid: pvc.metadata.uid },
          hostPath: { path },
          nodeAffinity: { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: "kubernetes.io/hostname", operator: "In", values: [node] }] }] } },
        },
        status: { phase: "Bound" },
      },
      this.name,
    );
    this.api.patch("PersistentVolumeClaim", name, ns, "persistentvolume-controller", (o) => {
      o.spec.volumeName = pvName;
      o.status = { phase: "Bound", capacity: { storage: o.spec.resources.requests.storage }, accessModes: [...o.spec.accessModes] };
    });
    this.data.set(pvName, {});
    this.api.recordEvent(pvc, "Normal", "ProvisioningSucceeded", `Successfully provisioned volume ${pvName}`, `${LOCAL_PATH_PROVISIONER}_${ACTOR}`);
    this.ctx.trace.add(
      this.name,
      "storage",
      `PVC ${name} 를 쓰는 Pod 가 ${node} 에 정해짐 (selected-node) → ${node} 의 ${path} 로 PV ${pvName} 생성·Bound — 이 디스크는 ${node} 에 묶여(nodeAffinity) 이 PVC 를 쓰는 Pod 는 앞으로 ${node} 에만 갈 수 있다`,
      refOf(pvc),
    );
  }

  /** PVC 가 지워짐 → reclaimPolicy Delete: PV 와 노드의 디렉터리(데이터)도 지운다 */
  private reclaim(pvc: PersistentVolumeClaim): void {
    const pvName = pvc.spec.volumeName;
    if (!pvName) return;
    const pv = this.api.get("PersistentVolume", pvName);
    if (!pv || pv.spec.persistentVolumeReclaimPolicy !== "Delete") return;
    this.release(pvName);
    this.ctx.trace.add(this.name, "storage", `PVC ${pvc.metadata.name} 삭제 → reclaimPolicy Delete → PV ${pvName} 와 ${pv.spec.hostPath.path} 의 데이터 삭제`, { kind: "PersistentVolume", name: pvName });
  }
}
