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

/** 환경 변수: 값을 바로 쓰거나 ConfigMap·Secret 의 한 키에서 (컨테이너가 시작할 때 한 번 읽는다) */
export interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { configMapKeyRef?: { name: string; key: string }; secretKeyRef?: { name: string; key: string } };
}

/** ConfigMap·Secret 의 모든 키를 환경 변수로 */
export interface EnvFromSource {
  configMapRef?: { name: string };
  secretRef?: { name: string };
}

/** Pod 의 volume 을 컨테이너 안 경로에. subPath 면 키 하나를 파일 하나로 (그 파일은 나중에 갱신되지 않는다) */
export interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
}

/** ConfigMap·Secret 을 파일로 (키마다 파일 하나). kubelet 이 바뀐 내용을 잠시 뒤 파일에 반영한다 */
export interface Volume {
  name: string;
  configMap?: { name: string };
  secret?: { secretName: string };
  /** PVC 로 받은 디스크 (Pod 가 바뀌어도 남는다) */
  persistentVolumeClaim?: { claimName: string };
}

export interface Container {
  name: string;
  image: string;
  env?: EnvVar[];
  envFrom?: EnvFromSource[];
  volumeMounts?: VolumeMount[];
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
  volumes?: Volume[];
  /** StatefulSet Pod: hostname 과 subdomain(= headless Service 이름) 으로 <hostname>.<subdomain> DNS 이름이 생긴다 */
  hostname?: string;
  subdomain?: string;
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

/** 설정 값 묶음 (평문). 컨테이너가 env·파일로 읽는다 */
export interface ConfigMap {
  apiVersion: "v1";
  kind: "ConfigMap";
  metadata: ObjectMeta;
  data: Record<string, string>;
  spec?: undefined;
  status: Record<string, never>;
}

/** ConfigMap 과 같지만 값이 base64 (암호화 아님). 쓸 때 stringData 로 평문을 주면 API 서버가 data 로 바꿔 저장한다 */
export interface Secret {
  apiVersion: "v1";
  kind: "Secret";
  metadata: ObjectMeta;
  type: "Opaque";
  data: Record<string, string>;
  stringData?: Record<string, string>;
  spec?: undefined;
  status: Record<string, never>;
}

/** NetworkPolicy 의 셀렉터: 비우면({}) 모두 */
export interface Selector {
  matchLabels?: Record<string, string>;
}

/** 상대: 같은 네임스페이스의 Pod(podSelector), 네임스페이스(namespaceSelector — 둘 다면 그 네임스페이스의 그 Pod), 또는 IP 대역 */
export interface NetworkPolicyPeer {
  podSelector?: Selector;
  namespaceSelector?: Selector;
  ipBlock?: { cidr: string; except?: string[] };
}

/** 포트를 비우면 그 프로토콜의 모든 포트, ports 자체를 비우면 모든 프로토콜·포트 */
export interface NetworkPolicyPort {
  protocol?: "TCP" | "UDP";
  port?: number;
}

/** 고른 Pod 의 방향(ingress·egress)을 격리하고, 규칙에 맞는 것만 허용한다. 여러 정책의 허용은 더해진다 */
export interface NetworkPolicy {
  apiVersion: "networking.k8s.io/v1";
  kind: "NetworkPolicy";
  metadata: ObjectMeta;
  spec: {
    podSelector: Selector;
    /** 비우면 API 서버가 Ingress (+ egress 규칙이 있으면 Egress) 로 채운다 */
    policyTypes?: ("Ingress" | "Egress")[];
    ingress?: { from?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] }[];
    egress?: { to?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] }[];
  };
  status: Record<string, never>;
}

export type AccessMode = "ReadWriteOnce" | "ReadOnlyMany" | "ReadWriteMany" | "ReadWriteOncePod";

export interface PvcSpec {
  accessModes: AccessMode[];
  /** storage 는 MiB */
  resources: { requests: { storage: number } };
  storageClassName?: string;
  /** 묶인 PV 이름 (프로비저너·바인더가 채운다) */
  volumeName?: string;
}

/** 디스크 요청. StorageClass 의 프로비저너가 맞는 PV 를 만들어 묶는다 (Bound) */
export interface PersistentVolumeClaim {
  apiVersion: "v1";
  kind: "PersistentVolumeClaim";
  metadata: ObjectMeta;
  spec: PvcSpec;
  status: { phase: "Pending" | "Bound" | "Lost"; capacity?: { storage: number }; accessModes?: AccessMode[] };
}

/** 실제 디스크 (클러스터 범위). local-path 는 노드의 디렉터리라 그 노드에 묶인다 (nodeAffinity) */
export interface PersistentVolume {
  apiVersion: "v1";
  kind: "PersistentVolume";
  metadata: ObjectMeta;
  spec: {
    capacity: { storage: number };
    accessModes: AccessMode[];
    persistentVolumeReclaimPolicy: "Delete" | "Retain";
    storageClassName: string;
    claimRef?: { name: string; namespace: string; uid: string };
    hostPath: { path: string };
    nodeAffinity?: { required: { nodeSelectorTerms: { matchExpressions: { key: string; operator: "In"; values: string[] }[] }[] } };
  };
  status: { phase: "Available" | "Bound" | "Released" };
}

/** 어떤 프로비저너가 디스크를 만들고, 언제 묶을지 (WaitForFirstConsumer = Pod 가 노드에 정해진 뒤) */
export interface StorageClass {
  apiVersion: "storage.k8s.io/v1";
  kind: "StorageClass";
  metadata: ObjectMeta;
  provisioner: string;
  reclaimPolicy: "Delete" | "Retain";
  volumeBindingMode: "WaitForFirstConsumer" | "Immediate";
  spec?: undefined;
  status: Record<string, never>;
}

/** 고정 이름(<이름>-0, -1 …)·순서·Pod 마다 자기 PVC 를 가진 Pod 묶음 */
export interface StatefulSet {
  apiVersion: "apps/v1";
  kind: "StatefulSet";
  metadata: ObjectMeta;
  spec: {
    replicas: number;
    selector: LabelSelector;
    /** Pod 마다 DNS 이름을 주는 headless Service */
    serviceName: string;
    template: PodTemplate;
    volumeClaimTemplates?: { metadata: { name: string }; spec: PvcSpec }[];
    podManagementPolicy?: "OrderedReady" | "Parallel";
    updateStrategy?: { type: "RollingUpdate" | "OnDelete" };
  };
  status: {
    replicas: number;
    readyReplicas: number;
    availableReplicas: number;
    currentReplicas: number;
    updatedReplicas: number;
    currentRevision?: string;
    updateRevision?: string;
    observedGeneration: number;
  };
}

export type KObject =
  | Pod
  | ReplicaSet
  | Deployment
  | Node
  | Lease
  | Service
  | EndpointSlice
  | PodDisruptionBudget
  | Ingress
  | Application
  | ConfigMap
  | Secret
  | NetworkPolicy
  | PersistentVolumeClaim
  | PersistentVolume
  | StorageClass
  | StatefulSet;
export type Kind = KObject["kind"];

export type ObjectOf<K extends Kind> = Extract<KObject, { kind: K }>;

/** 클러스터 범위 오브젝트(네임스페이스 없음) */
export const CLUSTER_SCOPED: ReadonlySet<Kind> = new Set<Kind>(["Node", "PersistentVolume", "StorageClass"]);

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

/** 컨테이너의 실제 상한: limits 를 적지 않았거나 0 이면 상한 없음 (kubelet 은 0 을 쿼터 없음으로 본다) */
export function limitOf(c: Container, key: "cpu" | "memory"): number | undefined {
  const v = c.resources.limits?.[key];
  return v ? v : undefined;
}

/**
 * QoS 클래스: 모든 컨테이너가 cpu·memory limits 를 갖고 requests == limits 면 Guaranteed,
 * requests·limits 가 하나도 없으면 BestEffort, 나머지는 Burstable. (requests 0 = 적지 않음)
 */
export function qosClass(spec: PodSpec): QosClass {
  let any = false;
  let guaranteed = true;
  for (const c of spec.containers) {
    const r = c.resources.requests;
    const lc = limitOf(c, "cpu");
    const lm = limitOf(c, "memory");
    if (r.cpu || r.memory || lc !== undefined || lm !== undefined) any = true;
    if (lc === undefined || lm === undefined || r.cpu !== lc || r.memory !== lm) guaranteed = false;
  }
  return !any ? "BestEffort" : guaranteed ? "Guaranteed" : "Burstable";
}

/** 끝난 Pod (재시작 정책 Always 라 축소판에서는 거의 없음) */
export function isPodTerminal(p: Pod): boolean {
  return p.status.phase === "Succeeded" || p.status.phase === "Failed";
}
