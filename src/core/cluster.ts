// 클러스터 한 벌: 시계 + 트레이스 + API 서버 + 컨트롤 플레인(스케줄러·컨트롤러) + 노드마다 kubelet.
// 바깥(모델·kubectl·UI)은 여기 메서드로만 클러스터를 바꾼다.
import { ApiServer, WATCH_DELAY_MS, type Draft } from "./api/server";
import type { Application, Deployment, Ingress, Pod, PodDisruptionBudget, PodSpec, Probe, Service, ServiceType, EnvFromSource, EnvVar, NetworkPolicy } from "./api/types";
import { Clock } from "./clock";
import type { ComponentContext } from "./controllers/base";
import { DeploymentController } from "./controllers/deployment";
import { DisruptionController } from "./controllers/disruption";
import { DrainJob } from "./drain";
import { EndpointSliceController } from "./controllers/endpointslice";
import { NodeLifecycleController, TaintEvictionController } from "./controllers/nodelifecycle";
import { ReplicaSetController } from "./controllers/replicaset";
import { Kubelet, type ContainerConfig, type CpuState, type NodeDef } from "./kubelet";
import { ARGO, ArgoCD } from "./gitops/argocd";
import { GitRepo, type Commit } from "./gitops/git";
import { IngressNginxStatus, MetalLB, TailscaleOperator } from "./net/ingress";
import { KubeProxy } from "./net/kubeproxy";
import { simulateExternal, simulateFromPod, simulateNodePort, type NetResult, type StepKind, type Tool } from "./net/request";
import { Traffic } from "./net/traffic";
import { Rng, stableJson } from "./rng";
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

export interface PdbManifest {
  apiVersion: "policy/v1";
  kind: "PodDisruptionBudget";
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
  spec: PodDisruptionBudget["spec"];
}

export interface IngressManifest {
  apiVersion: "networking.k8s.io/v1";
  kind: "Ingress";
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: Ingress["spec"];
}

export interface ApplicationManifest {
  apiVersion: "argoproj.io/v1alpha1";
  kind: "Application";
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: Application["spec"];
}

export interface ConfigMapManifest {
  apiVersion: "v1";
  kind: "ConfigMap";
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  data: Record<string, string>;
}

/** Secret 매니페스트는 평문 stringData 로 적는다 (API 서버가 base64 data 로 바꿔 저장) */
export interface SecretManifest {
  apiVersion: "v1";
  kind: "Secret";
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  type?: "Opaque";
  stringData?: Record<string, string>;
  data?: Record<string, string>;
}

export interface NetworkPolicyManifest {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec: NetworkPolicy["spec"];
}

export type Manifest = DeploymentManifest | ServiceManifest | PdbManifest | IngressManifest | ApplicationManifest | ConfigMapManifest | SecretManifest | NetworkPolicyManifest;

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
  /** LoadBalancer IP 를 주고 어느 노드가 맡는지 정한다 */
  readonly metallb: MetalLB;
  /** Git 저장소들 (URL → 저장소) */
  readonly git = new Map<string, GitRepo>();
  /** Argo CD application-controller */
  readonly argocd: ArgoCD;
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
    new DisruptionController(this.ctx);
    this.metallb = new MetalLB(this.ctx, (n) => this.nodePowered(n));
    new IngressNginxStatus(this.ctx);
    new TailscaleOperator(this.ctx);
    this.argocd = new ArgoCD(
      this.ctx,
      (url) => this.git.get(url),
      (m) => this.apply(m, ARGO),
    );
    new Scheduler(this.ctx);
    new NodeLifecycleController(this.ctx);
    new TaintEvictionController(this.ctx);
    // pod-garbage-collector: 사라진 노드에 바인딩돼 있던 Pod 는 강제로 지운다
    this.api.watch("Node", (ev) => {
      if (ev.type !== "DELETED") return;
      // 같은 이름의 노드가 이미 다시 생겼으면 그 노드의 Pod 는 건드리지 않는다 (늦게 온 DELETED)
      if (this.api.get("Node", ev.object.metadata.name)) return;
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
    this.metallb.all();
  }

  nodePowered(name: string): boolean {
    return this.kubelets.get(name)?.isPowered ?? false;
  }

  resizeNode(name: string, cpu: number, memory: number): void {
    this.kubelets.get(name)?.resize(cpu, memory);
  }

  /** Git 저장소에 커밋 (없으면 만든다) */
  gitCommit(url: string, files: Record<string, Manifest>, message: string, author = "you"): Commit {
    let repo = this.git.get(url);
    if (!repo) {
      repo = new GitRepo(url);
      this.git.set(url, repo);
    }
    const c = repo.commit(files, message, author, this.clock.now);
    this.trace.add(author, "git.commit", `git push → ${url.replace(/^https:\/\//, "")} main ${c.sha.slice(0, 7)} "${message}" (Argo CD 는 다음 폴링이나 Refresh 때 알게 된다)`);
    return c;
  }

  /** kubectl drain: 노드를 cordon 하고 Pod 를 Eviction API 로 내보낸다 (시간이 지나며 진행) */
  drain(node: string): DrainJob {
    return new DrainJob(this, node);
  }

  /** 지금 돌고 있는 부하 발생기 (하나만) */
  traffic?: Traffic;

  /** fromPod 에서 intervalMs 마다 curl target */
  startTraffic(fromPod: string, target: string, intervalMs = 200): Traffic {
    this.traffic?.stop();
    this.trace.add("user", "user", `부하 시작: ${fromPod} 에서 ${intervalMs}ms 마다 curl ${target}`, { kind: "Pod", namespace: "default", name: fromPod });
    this.traffic = new Traffic(this, fromPod, target, intervalMs);
    return this.traffic;
  }

  stopTraffic(): void {
    if (!this.traffic) return;
    this.trace.add("user", "user", `부하 멈춤 (성공 ${this.traffic.ok} · 실패 ${this.traffic.fail})`);
    this.traffic.stop();
    this.traffic = undefined;
  }

  /** 앱 고장 흉내 (readiness 와 요청이 503) — kubelet 이 아는 사실 */
  setPodHealth(podName: string, healthy: boolean): boolean {
    const p = this.api.get("Pod", podName, "default");
    if (!p?.spec.nodeName) return false;
    const ok = this.kubelets.get(p.spec.nodeName)?.setSick(p.metadata.uid, !healthy) ?? false;
    if (ok) this.trace.add("user", "user", `${podName} 의 앱을 ${healthy ? "고침" : "고장 냄 (DB 연결이 끊긴 것처럼 /ready 와 요청이 503)"}`, { kind: "Pod", namespace: "default", name: podName });
    return ok;
  }

  /**
   * metrics-server 흉내: Pod 의 실사용 (kubectl top). 컨테이너가 돌지 않으면 undefined.
   * 축소판: 실제 metrics-server 는 15초마다 긁어 와 늦게 보이지만 여기서는 바로 보인다.
   */
  podMetrics(p: Pod): { cpu: number; memory: number; cpuState: CpuState } | undefined {
    const k = p.spec.nodeName ? this.kubelets.get(p.spec.nodeName) : undefined;
    const u = k?.usage(p.metadata.uid);
    return u && k ? { ...u, cpuState: k.cpuState(p.metadata.uid) } : undefined;
  }

  /** 컨테이너가 본 설정 (kubectl exec -- env · cat). 컨테이너가 돌지 않으면 undefined */
  containerConfig(p: Pod): ContainerConfig | undefined {
    return p.spec.nodeName ? this.kubelets.get(p.spec.nodeName)?.containerConfig(p.metadata.uid) : undefined;
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

  /** 클러스터 밖에서 URL 로 curl (Ingress 호스트 · LoadBalancer IP · 노드IP:NodePort · *.ts.net) */
  requestExternal(url: string): NetResult {
    const r = simulateExternal(this, url);
    this.traceRequest(`바깥에서 curl ${url}`, r);
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
      // 종류마다 모양은 다르지만 만드는 방법은 같다 (서버가 메타데이터·상태를 채운다)
      const draft = {
        apiVersion: m.apiVersion,
        kind: m.kind,
        metadata: { ...m.metadata, namespace: ns, annotations: { ...((m.metadata as { annotations?: Record<string, string> }).annotations ?? {}), [LAST_APPLIED]: stableJson(m) } },
        // ConfigMap·Secret 은 spec 이 아니라 data(·stringData·type)를 가진다
        ...(m.kind === "ConfigMap" || m.kind === "Secret" ? structuredClone({ data: m.data, ...(m.kind === "Secret" ? { type: m.type, stringData: m.stringData } : {}) }) : { spec: structuredClone(m.spec) }),
      };
      this.api.create(draft as unknown as Draft<typeof m.kind>, actor);
      return "created";
    }
    const rv = cur.metadata.resourceVersion;
    const next = this.api.patch(m.kind, m.metadata.name, ns, actor, (o) => {
      if ((o.kind === "ConfigMap" && m.kind === "ConfigMap") || (o.kind === "Secret" && m.kind === "Secret")) {
        // 3-way merge (kubectl apply 처럼): 지난번 apply 에 있었고 이번 매니페스트에 없는 키만 지우고, 다른 도구가 더한 키(kubectl patch)는 남긴다.
        // Secret 은 stringData 를 API 서버가 data 로 바꾼다
        const next = { ...o.data };
        const want = configKeys(m);
        for (const k of configKeys(parseApplied(o.metadata.annotations?.[LAST_APPLIED]) as ConfigMapManifest | SecretManifest | undefined)) if (!want.has(k)) delete next[k];
        o.data = { ...next, ...structuredClone(m.data ?? {}) };
        if (o.kind === "Secret" && m.kind === "Secret" && m.stringData) o.stringData = { ...m.stringData };
        o.metadata.labels = { ...(m.metadata.labels ?? {}) };
        o.metadata.annotations = { ...(o.metadata.annotations ?? {}), [LAST_APPLIED]: stableJson(m) };
        return;
      }
      if (m.kind === "ConfigMap" || m.kind === "Secret") return;
      const spec = structuredClone(m.spec);
      const prevApplied = parseApplied(o.metadata.annotations?.[LAST_APPLIED]);
      if (o.kind === "Deployment" && m.kind === "Deployment") {
        // 3-way merge (kubectl apply 처럼): 템플릿 주석 중 지난번 apply 가 넣었고 이번 매니페스트에 없는 것만 지운다.
        // 그래서 kubectl rollout restart 가 붙인 restartedAt 은 apply 해도 남는다
        const live = o.spec.template.metadata.annotations ?? {};
        const prev = (prevApplied as DeploymentManifest | undefined)?.spec.template.metadata.annotations ?? {};
        const want = m.spec.template.metadata.annotations ?? {};
        const merged: Record<string, string> = { ...live };
        for (const k of Object.keys(prev)) if (!(k in want)) delete merged[k];
        Object.assign(merged, want);
        const tmpl = (spec as Deployment["spec"]).template;
        if (Object.keys(merged).length) tmpl.metadata = { ...tmpl.metadata, annotations: merged };
        else delete tmpl.metadata.annotations;
      }
      if (o.kind === "Service" && m.kind === "Service") {
        // 서버가 정한 값(clusterIP·nodePort)은 매니페스트에 없으면 지킨다 (apply 의 3-way merge 처럼)
        const s = spec as Service["spec"];
        s.clusterIP ??= o.spec.clusterIP;
        s.ports.forEach((p, i) => {
          // 매니페스트에 nodePort 가 없으면 지금 것을 이어받는다 (포트 번호가 바뀌었으면 같은 자리의 것). 없으면 API 서버가 새로 정한다
          if (s.type !== "ClusterIP") p.nodePort ??= (o.spec.ports.find((x) => x.port === p.port) ?? o.spec.ports[i])?.nodePort;
          else delete p.nodePort;
        });
      }
      (o as { spec: unknown }).spec = spec;
      o.metadata.labels = { ...(m.metadata.labels ?? {}) };
      if (m.kind === "Ingress" || m.kind === "Application") o.metadata.annotations = { ...(m.metadata.annotations ?? {}) };
      o.metadata.annotations = { ...(o.metadata.annotations ?? {}), [LAST_APPLIED]: stableJson(m) };
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

/** kubectl apply 가 남기는 "지난번에 적용한 매니페스트" — 다음 apply 의 3-way merge 에 쓴다 */
export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** ConfigMap·Secret 매니페스트가 적은 키 (Secret 은 data 와 stringData 둘 다) */
export function configKeys(m: ConfigMapManifest | SecretManifest | undefined): Set<string> {
  if (!m) return new Set();
  return new Set([...Object.keys(m.data ?? {}), ...Object.keys((m.kind === "Secret" && m.stringData) || {})]);
}

/** 주석 값은 사용자가 고칠 수 있는 입력이라 깨져 있을 수 있다 — 그러면 "지난번 apply 없음" 으로 본다 (kubectl 도 경고 뒤 2-way 로 진행) */
function parseApplied(s: string | undefined): Manifest | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as Manifest;
  } catch {
    return undefined;
  }
}

/** 예제에서 쓰는 Argo CD Application (argocd 네임스페이스) */
export function application(name: string, opts: { repoURL: string; path: string; automated?: { prune: boolean; selfHeal: boolean } }): ApplicationManifest {
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name, namespace: "argocd" },
    spec: {
      project: "default",
      source: { repoURL: opts.repoURL, path: opts.path, targetRevision: "main" },
      destination: { server: "https://kubernetes.default.svc", namespace: "default" },
      ...(opts.automated ? { syncPolicy: { automated: { ...opts.automated } } } : {}),
    },
  };
}

/** 예제에서 쓰는 Ingress */
export function ingress(
  name: string,
  opts: { className?: string; rules?: Ingress["spec"]["rules"]; defaultBackend?: Ingress["spec"]["defaultBackend"]; tls?: string[]; annotations?: Record<string, string> },
): IngressManifest {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "Ingress",
    metadata: { name, ...(opts.annotations ? { annotations: { ...opts.annotations } } : {}) },
    spec: {
      ...(opts.className ? { ingressClassName: opts.className } : {}),
      ...(opts.defaultBackend ? { defaultBackend: opts.defaultBackend } : {}),
      ...(opts.rules?.length ? { rules: opts.rules } : {}),
      ...(opts.tls ? { tls: [{ hosts: opts.tls }] } : {}),
    },
  };
}

/** NetworkPolicy 매니페스트 (podSelector 는 app=… 하나, 비우면 모든 Pod) */
export function networkPolicy(name: string, spec: NetworkPolicy["spec"]): NetworkPolicyManifest {
  return { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name }, spec: structuredClone(spec) };
}

export function configMap(name: string, data: Record<string, string>): ConfigMapManifest {
  return { apiVersion: "v1", kind: "ConfigMap", metadata: { name }, data: { ...data } };
}

export function secret(name: string, stringData: Record<string, string>): SecretManifest {
  return { apiVersion: "v1", kind: "Secret", metadata: { name }, type: "Opaque", stringData: { ...stringData } };
}

/** 예제에서 쓰는 PodDisruptionBudget */
export function pdb(name: string, selector: Record<string, string>, opts: { minAvailable?: number | string; maxUnavailable?: number | string }): PdbManifest {
  return { apiVersion: "policy/v1", kind: "PodDisruptionBudget", metadata: { name }, spec: { selector: { matchLabels: { ...selector } }, ...opts } };
}

/** 예제·폼에서 쓰는 단순 Service */
export function service(
  name: string,
  opts: { selector: Record<string, string>; port: number; targetPort?: number; type?: ServiceType; nodePort?: number; externalTrafficPolicy?: "Cluster" | "Local" },
): ServiceManifest {
  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name },
    spec: {
      type: opts.type ?? "ClusterIP",
      ...(opts.externalTrafficPolicy ? { externalTrafficPolicy: opts.externalTrafficPolicy } : {}),
      selector: { ...opts.selector },
      ports: [{ protocol: "TCP", port: opts.port, targetPort: opts.targetPort ?? opts.port, ...(opts.nodePort ? { nodePort: opts.nodePort } : {}) }],
    },
  };
}

/** 예제·폼에서 쓰는 단순 Deployment */
export function deployment(
  name: string,
  opts: {
    replicas: number;
    image: string;
    cpu: number;
    memory: number;
    labels?: Record<string, string>;
    nodeSelector?: Record<string, string>;
    port?: number;
    readiness?: Probe;
    liveness?: Probe;
    /** preStop sleep 초 */
    preStop?: number;
    /** resources.limits (없으면 상한 없음) */
    limits?: { cpu?: number; memory?: number };
    env?: EnvVar[];
    envFrom?: EnvFromSource[];
    /** ConfigMap·Secret 을 파일로: volume 과 volumeMount 를 한 번에 */
    mounts?: { name: string; configMap?: string; secret?: string; mountPath: string; subPath?: string }[];
    /** Pod 템플릿 주석 (Helm 의 checksum/config 같은 것) */
    podAnnotations?: Record<string, string>;
  },
): DeploymentManifest {
  const labels = opts.labels ?? { app: name };
  const spec: PodSpec = {
    containers: [
      {
        name,
        image: opts.image,
        resources: { requests: { cpu: opts.cpu, memory: opts.memory }, ...(opts.limits ? { limits: { ...opts.limits } } : {}) },
        ...(opts.port ? { ports: [{ containerPort: opts.port }] } : {}),
        ...(opts.readiness ? { readinessProbe: opts.readiness } : {}),
        ...(opts.liveness ? { livenessProbe: opts.liveness } : {}),
        ...(opts.preStop ? { lifecycle: { preStop: { sleep: { seconds: opts.preStop } } } } : {}),
        ...(opts.env ? { env: structuredClone(opts.env) } : {}),
        ...(opts.envFrom ? { envFrom: structuredClone(opts.envFrom) } : {}),
        ...(opts.mounts?.length ? { volumeMounts: opts.mounts.map((m) => ({ name: m.name, mountPath: m.mountPath, ...(m.subPath ? { subPath: m.subPath } : {}) })) } : {}),
      },
    ],
    ...(opts.mounts?.length
      ? { volumes: [...new Map(opts.mounts.map((m) => [m.name, m.configMap ? { name: m.name, configMap: { name: m.configMap } } : { name: m.name, secret: { secretName: m.secret! } }])).values()] }
      : {}),
    restartPolicy: "Always",
    terminationGracePeriodSeconds: 30,
  };
  if (opts.nodeSelector) spec.nodeSelector = opts.nodeSelector;
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, labels: { ...labels } },
    spec: { replicas: opts.replicas, selector: { matchLabels: { ...labels } }, template: { metadata: { labels: { ...labels }, ...(opts.podAnnotations ? { annotations: { ...opts.podAnnotations } } : {}) }, spec } },
  };
}
