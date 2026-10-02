// 클러스터 한 벌: 시계 + 트레이스 + API 서버 + 컨트롤 플레인(스케줄러·컨트롤러) + 노드마다 kubelet.
// 바깥(모델·kubectl·UI)은 여기 메서드로만 클러스터를 바꾼다.
import { ApiServer, WATCH_DELAY_MS } from "./api/server";
import type { Deployment, PodSpec, Probe, Service } from "./api/types";
import { Clock } from "./clock";
import type { ComponentContext } from "./controllers/base";
import { DeploymentController } from "./controllers/deployment";
import { EndpointSliceController } from "./controllers/endpointslice";
import { NodeLifecycleController, TaintEvictionController } from "./controllers/nodelifecycle";
import { ReplicaSetController } from "./controllers/replicaset";
import { Kubelet, type NodeDef } from "./kubelet";
import { KubeProxy } from "./net/kubeproxy";
import { simulateFromPod, simulateNodePort, type NetResult, type StepKind, type Tool } from "./net/request";
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

export interface ServiceManifest {
  apiVersion: "v1";
  kind: "Service";
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec: Service["spec"];
}

export type Manifest = DeploymentManifest | ServiceManifest;

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
  readonly kubeProxies = new Map<string, KubeProxy>();
  /** 요청 흉내 전용 난수 (kube-proxy 의 확률 분배) — Pod 이름 난수와 분리해 요청을 보내도 이후 이름이 바뀌지 않게 */
  readonly netRng: Rng;
  private nodeIndex = 0;
  private readonly ctx: ComponentContext;

  constructor(opts: ClusterOptions = {}) {
    this.rng = new Rng(opts.seed);
    this.netRng = new Rng((opts.seed ?? 0x2545f491) ^ 0x9e3779b9);
    this.api = new ApiServer(this.clock, this.trace, opts.watchDelay ?? WATCH_DELAY_MS);
    this.ctx = { clock: this.clock, api: this.api, trace: this.trace };
    new DeploymentController(this.ctx);
    new ReplicaSetController(this.ctx, this.rng);
    new EndpointSliceController(this.ctx, this.rng);
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
    this.kubeProxies.set(def.name, new KubeProxy(this.ctx, def.name));
    return k;
  }

  removeNode(name: string, actor = "user"): void {
    const k = this.kubelets.get(name);
    if (!k) return;
    k.stop();
    this.kubelets.delete(name);
    this.kubeProxies.get(name)?.stop();
    this.kubeProxies.delete(name);
    if (this.api.get("Node", name)) this.api.delete("Node", name, undefined, actor);
  }

  /** 노드 전원 끄기·켜기 (kubelet 이 멈추거나 다시 뜸). 노드는 클러스터에 남는다 */
  setNodePower(name: string, on: boolean): void {
    const k = this.kubelets.get(name);
    if (!k || k.isPowered === on) return;
    this.trace.add("user", "user", `노드 ${name} ${on ? "다시 켜기" : "끄기 (전원·kubelet 멈춤)"}`, { kind: "Node", name });
    if (on) k.powerOn();
    else k.powerOff();
    this.kubeProxies.get(name)?.setPower(on);
  }

  nodePowered(name: string): boolean {
    return this.kubelets.get(name)?.isPowered ?? false;
  }

  resizeNode(name: string, cpu: number, memory: number): void {
    this.kubelets.get(name)?.resize(cpu, memory);
  }

  /** 앱 고장 흉내 (readiness 와 요청이 503) — kubelet 이 아는 사실 */
  setPodHealth(podName: string, healthy: boolean): boolean {
    const p = this.api.get("Pod", podName, "default");
    if (!p?.spec.nodeName) return false;
    const ok = this.kubelets.get(p.spec.nodeName)?.setSick(p.metadata.uid, !healthy) ?? false;
    if (ok) this.trace.add("user", "user", `${podName} 의 앱을 ${healthy ? "고침" : "고장 냄 (DB 연결이 끊긴 것처럼 /ready 와 요청이 503)"}`, { kind: "Pod", namespace: "default", name: podName });
    return ok;
  }

  podSick(podName: string): boolean {
    const p = this.api.peekList("Pod").find((x) => x.metadata.name === podName);
    if (!p?.spec.nodeName) return false;
    return this.kubelets.get(p.spec.nodeName)?.appState(p.metadata.uid)?.sick ?? false;
  }

  /** Pod 안에서 curl·ping·nslookup (kubectl exec). 단계를 트레이스에 남긴다 */
  requestFromPod(podName: string, tool: Tool, target: string): NetResult {
    const p = this.api.get("Pod", podName, "default")!;
    const r = simulateFromPod(this, p, tool, target);
    this.traceRequest(`${podName} 에서 ${tool} ${target}`, r);
    return r;
  }

  /** 클러스터 밖에서 노드IP:NodePort 로 curl */
  requestNodePort(nodeName: string, nodePort: number): NetResult {
    const r = simulateNodePort(this, nodeName, nodePort);
    this.traceRequest(`바깥에서 curl ${nodeName}:${nodePort}`, r);
    return r;
  }

  private traceRequest(what: string, r: NetResult): void {
    this.trace.add("user", "net.request", `요청: ${what}`);
    const kindOf: Record<StepKind, "net.dns" | "net.dnat" | "net.route" | "net.response" | "net.fail"> = { dns: "net.dns", dnat: "net.dnat", route: "net.route", response: "net.response", fail: "net.fail" };
    for (const s of r.steps) {
      const ref = s.at?.pod ? { kind: "Pod", namespace: "default", name: s.at.pod } : s.at?.service ? { kind: "Service", namespace: "default", name: s.at.service } : undefined;
      this.trace.add(s.actor, kindOf[s.kind], s.text, ref);
    }
  }

  /** kubectl apply: 없으면 만들고 있으면 spec·labels 를 바꾼다 */
  apply(m: Manifest, actor = "kubectl"): "created" | "configured" | "unchanged" {
    const ns = m.metadata.namespace ?? "default";
    const cur = this.api.get(m.kind, m.metadata.name, ns);
    if (!cur) {
      if (m.kind === "Deployment") this.api.create<"Deployment">({ apiVersion: m.apiVersion, kind: m.kind, metadata: { ...m.metadata, namespace: ns }, spec: structuredClone(m.spec) }, actor);
      else this.api.create<"Service">({ apiVersion: m.apiVersion, kind: m.kind, metadata: { ...m.metadata, namespace: ns }, spec: structuredClone(m.spec) }, actor);
      return "created";
    }
    const rv = cur.metadata.resourceVersion;
    const next = this.api.patch(m.kind, m.metadata.name, ns, actor, (o) => {
      const spec = structuredClone(m.spec);
      if (o.kind === "Service" && m.kind === "Service") {
        // 서버가 정한 값(clusterIP·nodePort)은 매니페스트에 없으면 지킨다 (apply 의 3-way merge 처럼)
        const s = spec as Service["spec"];
        s.clusterIP ??= o.spec.clusterIP;
        for (const p of s.ports) {
          if (s.type === "NodePort") p.nodePort ??= o.spec.ports.find((x) => x.port === p.port)?.nodePort;
          else delete p.nodePort;
        }
      }
      (o as { spec: unknown }).spec = spec;
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

/** 예제·폼에서 쓰는 단순 Service */
export function service(name: string, opts: { selector: Record<string, string>; port: number; targetPort?: number; type?: "ClusterIP" | "NodePort"; nodePort?: number }): ServiceManifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name },
    spec: {
      type: opts.type ?? "ClusterIP",
      selector: { ...opts.selector },
      ports: [{ protocol: "TCP", port: opts.port, targetPort: opts.targetPort ?? opts.port, ...(opts.nodePort ? { nodePort: opts.nodePort } : {}) }],
    },
  };
}

/** 예제·폼에서 쓰는 단순 Deployment */
export function deployment(
  name: string,
  opts: { replicas: number; image: string; cpu: number; memory: number; labels?: Record<string, string>; nodeSelector?: Record<string, string>; port?: number; readiness?: Probe },
): DeploymentManifest {
  const labels = opts.labels ?? { app: name };
  const spec: PodSpec = {
    containers: [
      {
        name,
        image: opts.image,
        resources: { requests: { cpu: opts.cpu, memory: opts.memory } },
        ...(opts.port ? { ports: [{ containerPort: opts.port }] } : {}),
        ...(opts.readiness ? { readinessProbe: opts.readiness } : {}),
      },
    ],
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
