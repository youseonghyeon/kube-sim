// 쿠버네티스 오브젝트 모양 (축소판 — 학습에 쓰이는 필드만).
// 단위: cpu 는 millicore(1000 = 1 CPU), memory 는 MiB.

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller: boolean;
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid: string;
  resourceVersion: number;
  generation: number;
  creationTimestamp: number;
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  ownerReferences: OwnerReference[];
  deletionTimestamp?: number;
  deletionGracePeriodSeconds?: number;
}

export interface Resources {
  cpu: number;
  memory: number;
}

export interface Probe {
  httpGet: { path: string; port: number };
  initialDelaySeconds?: number;
  /** 기본 10 */
  periodSeconds?: number;
  /** 기본 3 — 이만큼 연속 실패하면 Ready=False */
  failureThreshold?: number;
  /** 기본 1 — 응답이 이보다 늦으면 실패 */
  timeoutSeconds?: number;
}

export interface Container {
  name: string;
  image: string;
  /** requests: 스케줄러가 보는 예약 (0 = 적지 않음). limits: cgroup 이 거는 상한 (없으면 상한 없음) */
  resources: { requests: Resources; limits?: Partial<Resources> };
  ports?: { containerPort: number; protocol?: "TCP" }[];
  readinessProbe?: Probe;
  /** 실패하면 kubelet 이 컨테이너를 죽이고 다시 띄운다 */
  livenessProbe?: Probe;
  /** 종료 전에 실행 — SIGTERM 보다 먼저 (유예 시간에 포함) */
  lifecycle?: { preStop?: { sleep: { seconds: number } } };
}

export interface Toleration {
  key: string;
  operator?: "Exists" | "Equal";
  value?: string;
  effect?: "NoSchedule" | "NoExecute";
  tolerationSeconds?: number;
}

export interface PodSpec {
  nodeName?: string;
  nodeSelector?: Record<string, string>;
  containers: Container[];
  restartPolicy: "Always";
  terminationGracePeriodSeconds: number;
  tolerations?: Toleration[];
}

export type ContainerState =
  | { waiting: { reason: string; message?: string } }
  | { running: { startedAt: number } }
  | { terminated: { reason: string; exitCode: number; startedAt?: number; finishedAt: number } };

export interface ContainerStatus {
  name: string;
  image: string;
  ready: boolean;
  started: boolean;
  restartCount: number;
  state: ContainerState;
  lastState?: ContainerState;
}

export type ConditionStatus = "True" | "False" | "Unknown";

export interface Condition {
  type: string;
  status: ConditionStatus;
  reason?: string;
  message?: string;
  lastTransitionTime: number;
  /** Deployment 조건: 마지막으로 진전이 있던 때 */
  lastUpdateTime?: number;
}

export type PodPhase = "Pending" | "Running" | "Succeeded" | "Failed";

export interface PodStatus {
  phase: PodPhase;
  conditions: Condition[];
  hostIP?: string;
  podIP?: string;
  startTime?: number;
  containerStatuses: ContainerStatus[];
}

export interface Pod {
  apiVersion: "v1";
  kind: "Pod";
  metadata: ObjectMeta;
  spec: PodSpec;
  status: PodStatus;
}

export interface PodTemplate {
  metadata: { labels: Record<string, string>; annotations?: Record<string, string> };
  spec: PodSpec;
}

/** 25% 같은 퍼센트 문자열 또는 개수 */
export type IntOrPercent = number | string;

export interface DeploymentStrategy {
  type: "RollingUpdate" | "Recreate";
  rollingUpdate?: { maxSurge: IntOrPercent; maxUnavailable: IntOrPercent };
}

export interface LabelSelector {
  matchLabels: Record<string, string>;
}

export interface ReplicaSet {
  apiVersion: "apps/v1";
  kind: "ReplicaSet";
  metadata: ObjectMeta;
  spec: { replicas: number; selector: LabelSelector; template: PodTemplate };
  status: { replicas: number; readyReplicas: number; availableReplicas: number; observedGeneration: number };
}

export interface Deployment {
  apiVersion: "apps/v1";
  kind: "Deployment";
  metadata: ObjectMeta;
  spec: {
    replicas: number;
    selector: LabelSelector;
    template: PodTemplate;
    /** 비우면 API 서버가 RollingUpdate 25%/25% 로 채운다 */
    strategy?: DeploymentStrategy;
    /** 이만큼 진전이 없으면 Progressing=False (ProgressDeadlineExceeded). 기본 600 */
    progressDeadlineSeconds?: number;
    /** 남겨 둘 옛 ReplicaSet 수. 기본 10 */
    revisionHistoryLimit?: number;
  };
  status: {
    replicas: number;
    updatedReplicas: number;
    unavailableReplicas?: number;
    conditions?: Condition[];
    readyReplicas: number;
    availableReplicas: number;
    observedGeneration: number;
    /** 새 ReplicaSet 이름이 남아 있는 다른 것과 겹치면 올려서 해시를 바꾼다 */
    collisionCount?: number;
  };
}

export interface Taint {
  key: string;
  value?: string;
  effect: "NoSchedule" | "NoExecute" | "PreferNoSchedule";
  /** NoExecute taint 가 붙은 시각 — tolerationSeconds 를 여기서부터 센다 */
  timeAdded?: number;
}

export interface Node {
  apiVersion: "v1";
  kind: "Node";
  metadata: ObjectMeta;
  spec: { podCIDR: string; unschedulable?: boolean; taints?: Taint[] };
  status: {
    capacity: Resources & { pods: number };
    allocatable: Resources & { pods: number };
    conditions: Condition[];
    addresses: { type: "InternalIP" | "Hostname"; address: string }[];
    /** 노드에 이미 받아 둔 이미지 */
    images: string[];
  };
}

export interface ServicePort {
  name?: string;
  protocol: "TCP";
  port: number;
  targetPort: number;
  nodePort?: number;
}

export interface Service {
  apiVersion: "v1";
  kind: "Service";
  metadata: ObjectMeta;
  spec: {
    type: ServiceType;
    selector: Record<string, string>;
    ports: ServicePort[];
    clusterIP?: string;
    /** NodePort·LoadBalancer 로 바깥에서 들어온 트래픽: Cluster(아무 노드의 Pod, 출발지 SNAT) · Local(그 노드의 Pod 만, 출발지 보존) */
    externalTrafficPolicy?: "Cluster" | "Local";
  };
  status: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

export type ServiceType = "ClusterIP" | "NodePort" | "LoadBalancer";

export interface IngressBackend {
  service: { name: string; port: { number: number } };
}

export interface IngressPath {
  path: string;
  pathType: "Prefix" | "Exact";
  backend: IngressBackend;
}

/** 바깥 HTTP 요청을 호스트·경로로 나눠 Service 로 보내는 규칙. 실제로 처리하는 것은 Ingress 컨트롤러(ingressClassName 이 고름) */
export interface Ingress {
  apiVersion: "networking.k8s.io/v1";
  kind: "Ingress";
  metadata: ObjectMeta;
  spec: {
    ingressClassName?: string;
    defaultBackend?: IngressBackend;
    rules?: { host?: string; http: { paths: IngressPath[] } }[];
    tls?: { hosts: string[] }[];
  };
  status: { loadBalancer: { ingress?: { ip?: string; hostname?: string }[] } };
}

export interface Endpoint {
  addresses: string[];
  conditions: { ready: boolean; serving: boolean; terminating: boolean };
  nodeName?: string;
  targetRef: { kind: "Pod"; name: string; uid: string };
}

/** EndpointSlice 컨트롤러가 Service 셀렉터에 맞는 Pod 의 IP 를 모아 둔 것 (kube-proxy 가 이것을 본다) */
export interface EndpointSlice {
  apiVersion: "discovery.k8s.io/v1";
  kind: "EndpointSlice";
  metadata: ObjectMeta;
  addressType: "IPv4";
  endpoints: Endpoint[];
  ports: { name?: string; port: number; protocol: "TCP" }[];
  spec?: undefined;
  status: Record<string, never>;
}

export const SERVICE_NAME_LABEL = "kubernetes.io/service-name";

/** 자발적 중단(drain·eviction) 때 최소한 남겨 둘 Pod 수 */
export interface PodDisruptionBudget {
  apiVersion: "policy/v1";
  kind: "PodDisruptionBudget";
  metadata: ObjectMeta;
  spec: { selector: LabelSelector; minAvailable?: IntOrPercent; maxUnavailable?: IntOrPercent };
  status: { currentHealthy: number; desiredHealthy: number; disruptionsAllowed: number; expectedPods: number; observedGeneration: number };
}

/** kubelet 의 heartbeat: kube-node-lease 네임스페이스에 노드마다 하나, 10초마다 renewTime 을 갱신한다 */
export interface Lease {
  apiVersion: "coordination.k8s.io/v1";
  kind: "Lease";
  metadata: ObjectMeta;
  spec: { holderIdentity: string; leaseDurationSeconds: number; renewTime: number };
  status: Record<string, never>;
}

export const NODE_LEASE_NS = "kube-node-lease";

export type SyncStatus = "Synced" | "OutOfSync" | "Unknown";
export type HealthStatus = "Healthy" | "Progressing" | "Degraded" | "Missing" | "Unknown";

/** Argo CD 의 Application: Git 저장소의 한 경로를 클러스터의 한 네임스페이스에 맞춰 둔다 */
export interface Application {
  apiVersion: "argoproj.io/v1alpha1";
  kind: "Application";
  metadata: ObjectMeta;
  spec: {
    project: string;
    source: { repoURL: string; path: string; targetRevision: string };
    destination: { server: string; namespace: string };
    syncPolicy?: { automated?: { prune?: boolean; selfHeal?: boolean } };
  };
  status: {
    sync: { status: SyncStatus; revision?: string };
    health: { status: HealthStatus };
    resources: { kind: string; name: string; status: SyncStatus; health?: HealthStatus; requiresPruning?: boolean }[];
    operationState?: { phase: "Running" | "Succeeded" | "Failed"; message: string; syncResult?: { revision: string; source?: string }; startedAt: number; finishedAt?: number };
    history: { id: number; revision: string; deployedAt: number }[];
    reconciledAt?: number;
  };
}

export type KObject = Pod | ReplicaSet | Deployment | Node | Lease | Service | EndpointSlice | PodDisruptionBudget | Ingress | Application;
export type Kind = KObject["kind"];

export type ObjectOf<K extends Kind> = Extract<KObject, { kind: K }>;

/** 클러스터 범위 오브젝트(네임스페이스 없음) */
export const CLUSTER_SCOPED: ReadonlySet<Kind> = new Set<Kind>(["Node"]);

/** 쿠버네티스 이벤트 (kubectl get events) */
export interface KEvent {
  /** 같은 (대상, reason, message) 이 되풀이되면 한 줄로 모으고 count 를 늘린다 */
  key: string;
  type: "Normal" | "Warning";
  reason: string;
  message: string;
  source: string;
  involvedObject: { kind: Kind; namespace?: string; name: string; uid: string };
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export function condition(obj: { status: { conditions: Condition[] } }, type: string): Condition | undefined {
  return obj.status.conditions.find((c) => c.type === type);
}

export function isPodReady(p: Pod): boolean {
  return condition(p, "Ready")?.status === "True";
}

export function isNodeReady(n: Node): boolean {
  return condition(n, "Ready")?.status === "True";
}

export function matchesSelector(labels: Record<string, string>, sel: LabelSelector): boolean {
  return Object.entries(sel.matchLabels).every(([k, v]) => labels[k] === v);
}

export function controllerOf(meta: ObjectMeta): OwnerReference | undefined {
  return meta.ownerReferences.find((o) => o.controller);
}

export function podRequests(spec: PodSpec): Resources {
  let cpu = 0;
  let memory = 0;
  for (const c of spec.containers) {
    cpu += c.resources.requests.cpu;
    memory += c.resources.requests.memory;
  }
  return { cpu, memory };
}

export type QosClass = "Guaranteed" | "Burstable" | "BestEffort";

/**
 * QoS 클래스: 모든 컨테이너가 cpu·memory limits 를 갖고 requests == limits 면 Guaranteed,
 * requests·limits 가 하나도 없으면 BestEffort, 나머지는 Burstable. (requests 0 = 적지 않음)
 */
export function qosClass(spec: PodSpec): QosClass {
  let any = false;
  let guaranteed = true;
  for (const c of spec.containers) {
    const r = c.resources.requests;
    const l = c.resources.limits ?? {};
    if (r.cpu || r.memory || l.cpu !== undefined || l.memory !== undefined) any = true;
    if (l.cpu === undefined || l.memory === undefined || r.cpu !== l.cpu || r.memory !== l.memory) guaranteed = false;
  }
  return !any ? "BestEffort" : guaranteed ? "Guaranteed" : "Burstable";
}

/** 끝난 Pod (재시작 정책 Always 라 축소판에서는 거의 없음) */
export function isPodTerminal(p: Pod): boolean {
  return p.status.phase === "Succeeded" || p.status.phase === "Failed";
}
