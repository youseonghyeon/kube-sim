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
}

export interface Container {
  name: string;
  image: string;
  resources: { requests: Resources };
  ports?: { containerPort: number; protocol?: "TCP" }[];
  readinessProbe?: Probe;
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
  metadata: { labels: Record<string, string> };
  spec: PodSpec;
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
  spec: { replicas: number; selector: LabelSelector; template: PodTemplate };
  status: {
    replicas: number;
    updatedReplicas: number;
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
  spec: { type: "ClusterIP" | "NodePort"; selector: Record<string, string>; ports: ServicePort[]; clusterIP?: string };
  status: Record<string, never>;
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

/** kubelet 의 heartbeat: kube-node-lease 네임스페이스에 노드마다 하나, 10초마다 renewTime 을 갱신한다 */
export interface Lease {
  apiVersion: "coordination.k8s.io/v1";
  kind: "Lease";
  metadata: ObjectMeta;
  spec: { holderIdentity: string; leaseDurationSeconds: number; renewTime: number };
  status: Record<string, never>;
}

export const NODE_LEASE_NS = "kube-node-lease";

export type KObject = Pod | ReplicaSet | Deployment | Node | Lease | Service | EndpointSlice;
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

/** 끝난 Pod (재시작 정책 Always 라 축소판에서는 거의 없음) */
export function isPodTerminal(p: Pod): boolean {
  return p.status.phase === "Succeeded" || p.status.phase === "Failed";
}
