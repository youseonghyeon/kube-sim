// 클러스터 한 벌: 시계 + 트레이스 + API 서버 + 컨트롤 플레인(스케줄러·컨트롤러) + 노드마다 kubelet.
// 바깥(모델·kubectl·UI)은 여기 메서드로만 클러스터를 바꾼다.
import { ApiServer, WATCH_DELAY_MS } from "./api/server";
import type { Deployment, PodSpec } from "./api/types";
import { Clock } from "./clock";
import type { ComponentContext } from "./controllers/base";
import { DeploymentController } from "./controllers/deployment";
import { NodeLifecycleController, TaintEvictionController } from "./controllers/nodelifecycle";
import { ReplicaSetController } from "./controllers/replicaset";
import { Kubelet, type NodeDef } from "./kubelet";
import { Rng } from "./rng";
import { Scheduler } from "./scheduler";
import { Trace } from "./trace";

/** 사용자가 쓰는 Deployment 매니페스트 (status·uid 같은 서버 몫 필드 없음) */
export interface DeploymentManifest {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec: Deployment["spec"];
}

export type Manifest = DeploymentManifest;

export interface ClusterOptions {
  seed?: number;
  watchDelay?: number;
}

export class Cluster {
  readonly clock = new Clock();
  readonly trace = new Trace(() => this.clock.now);
  readonly api: ApiServer;
  readonly rng: Rng;
  readonly kubelets = new Map<string, Kubelet>();
  private nodeIndex = 0;
  private readonly ctx: ComponentContext;

  constructor(opts: ClusterOptions = {}) {
    this.rng = new Rng(opts.seed);
    this.api = new ApiServer(this.clock, this.trace, opts.watchDelay ?? WATCH_DELAY_MS);
    this.ctx = { clock: this.clock, api: this.api, trace: this.trace };
    new DeploymentController(this.ctx);
    new ReplicaSetController(this.ctx, this.rng);
    new Scheduler(this.ctx);
    new NodeLifecycleController(this.ctx);
    new TaintEvictionController(this.ctx);
    // pod-garbage-collector: 사라진 노드에 바인딩돼 있던 Pod 는 강제로 지운다
    this.api.watch("Node", (ev) => {
      if (ev.type !== "DELETED") return;
      for (const p of this.api.list("Pod")) {
        if (p.spec.nodeName !== ev.object.metadata.name) continue;
        this.trace.add("pod-garbage-collector", "gc.delete", `${p.metadata.name} 이(가) 바인딩된 노드 ${ev.object.metadata.name} 이(가) 없음 → 강제 삭제`, { kind: "Pod", namespace: p.metadata.namespace, name: p.metadata.name });
        this.api.delete("Pod", p.metadata.name, p.metadata.namespace, "pod-garbage-collector", { gracePeriodSeconds: 0 });
      }
    });
  }

  get now(): number {
    return this.clock.now;
  }

  addNode(def: NodeDef): Kubelet {
    if (this.kubelets.has(def.name)) throw new Error(`노드 ${def.name} 이(가) 이미 있습니다`);
    const k = new Kubelet(this.ctx, def, ++this.nodeIndex);
    this.kubelets.set(def.name, k);
    k.register();
    return k;
  }

  removeNode(name: string, actor = "user"): void {
    const k = this.kubelets.get(name);
    if (!k) return;
    k.stop();
    this.kubelets.delete(name);
    if (this.api.get("Node", name)) this.api.delete("Node", name, undefined, actor);
  }

  /** 노드 전원 끄기·켜기 (kubelet 이 멈추거나 다시 뜸). 노드는 클러스터에 남는다 */
  setNodePower(name: string, on: boolean): void {
    const k = this.kubelets.get(name);
    if (!k || k.isPowered === on) return;
    this.trace.add("user", "user", `노드 ${name} ${on ? "다시 켜기" : "끄기 (전원·kubelet 멈춤)"}`, { kind: "Node", name });
    if (on) k.powerOn();
    else k.powerOff();
  }

  nodePowered(name: string): boolean {
    return this.kubelets.get(name)?.isPowered ?? false;
  }

  resizeNode(name: string, cpu: number, memory: number): void {
    this.kubelets.get(name)?.resize(cpu, memory);
  }

  /** kubectl apply: 없으면 만들고 있으면 spec·labels 를 바꾼다 */
  apply(m: Manifest, actor = "kubectl"): "created" | "configured" | "unchanged" {
    const ns = m.metadata.namespace ?? "default";
    const cur = this.api.get(m.kind, m.metadata.name, ns);
    if (!cur) {
      this.api.create<"Deployment">({ apiVersion: m.apiVersion, kind: m.kind, metadata: { ...m.metadata, namespace: ns }, spec: structuredClone(m.spec) }, actor);
      return "created";
    }
    const rv = cur.metadata.resourceVersion;
    const next = this.api.patch(m.kind, m.metadata.name, ns, actor, (o) => {
      o.spec = structuredClone(m.spec);
      o.metadata.labels = { ...(m.metadata.labels ?? {}) };
    });
    return next && next.metadata.resourceVersion !== rv ? "configured" : "unchanged";
  }

  /** 일반 이벤트가 없을 때까지 */
  runToIdle(maxEvents?: number): number {
    return this.clock.runToIdle(maxEvents);
  }

  runFor(ms: number, maxEvents?: number): number {
    return this.clock.runUntil(this.clock.now + ms, maxEvents);
  }
}

/** 예제·폼에서 쓰는 단순 Deployment */
export function deployment(name: string, opts: { replicas: number; image: string; cpu: number; memory: number; labels?: Record<string, string>; nodeSelector?: Record<string, string> }): DeploymentManifest {
  const labels = opts.labels ?? { app: name };
  const spec: PodSpec = {
    containers: [{ name, image: opts.image, resources: { requests: { cpu: opts.cpu, memory: opts.memory } } }],
    restartPolicy: "Always",
    terminationGracePeriodSeconds: 30,
  };
  if (opts.nodeSelector) spec.nodeSelector = opts.nodeSelector;
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, labels: { ...labels } },
    spec: { replicas: opts.replicas, selector: { matchLabels: { ...labels } }, template: { metadata: { labels: { ...labels } }, spec } },
  };
}
