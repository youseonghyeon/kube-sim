// 화면에 그릴 모양을 클러스터에서 뽑는다 (순수 함수 — 테스트 가능).
import { controllerOf, isNodeReady, isPodReady, limitOf, NODE_LEASE_NS, SERVICE_NAME_LABEL, type Application, type Deployment, type Ingress, type Node, type Pod, type ReplicaSet, type Service, type PersistentVolumeClaim, type StatefulSet } from "../core/api/types";
import type { Cluster } from "../core/cluster";
import { nodeStatusText, podReadyText, podStatusText } from "../core/kubectl";
import { DEFAULT_TOLERATION_SECONDS } from "../core/api/server";
import { deploymentHash, HASH_LABEL, revisionOf } from "../core/controllers/deployment";
import { NODE_MONITOR_GRACE_MS } from "../core/controllers/nodelifecycle";
import { nodeUsage } from "../core/scheduler";
import { isolation } from "../core/net/netpol";
import { pvNode } from "../core/storage";
import { claimName, ordinalOf } from "../core/controllers/statefulset";
import type { ObjRef, TraceEvent } from "../core/trace";

export type Tone = "ok" | "wait" | "bad" | "gone";

export interface PodView {
  pod: Pod;
  name: string;
  status: string;
  ready: string;
  tone: Tone;
  restarts: number;
  /** 사용자가 앱을 고장 낸 Pod */
  sick: boolean;
  /** 실사용 (kubectl top) — 컨테이너가 돌 때만 */
  usage?: { cpu: number; memory: number };
  /** 메모리 사용 / limits.memory (limit 이 있을 때, 0~1) */
  memOfLimit?: number;
  /** CPU 를 원하는 만큼 못 받음: limit = throttling, node = 노드 CPU 부족 */
  cpuShort?: "limit" | "node";
  /** 이 Pod 를 고른 NetworkPolicy (방향별 이름) — 하나라도 있으면 그 방향은 기본 차단 */
  netpol?: { ingress: string[]; egress: string[] };
  /** 주인 Deployment (없으면 ReplicaSet, 그것도 없으면 undefined) */
  owner?: string;
  rs?: string;
  /** ReplicaSet 리비전 — 주인 Deployment 의 Pod 가 여러 RS 에 걸쳐 있을 때(롤아웃 중)만 */
  revision?: number;
  /** 이 Pod 의 RS 가 지금 템플릿의 것인가 (롤아웃 중 새/옛 구분) */
  isNew?: boolean;
  colorIndex: number;
}

export interface NodeView {
  node: Node;
  name: string;
  ip: string;
  status: string;
  ready: boolean;
  cordoned: boolean;
  /** kubelet(전원)이 켜져 있는지 — API 는 모르는 사실이라 화면에만 */
  powered: boolean;
  /** Lease 를 마지막으로 갱신한 시각 */
  renewTime?: number;
  /** unreachable:NoExecute taint 가 붙은 시각 (NotReady 가 된 시각) */
  unreachableSince?: number;
  /** used = requests 합 (스케줄러가 보는 것), actual = 실사용 합 (kubectl top) */
  cpu: { used: number; total: number; actual: number };
  memory: { used: number; total: number; actual: number };
  pods: PodView[];
  /** 이 노드에 묶인 PV (local-path) */
  disks: DiskView[];
}

export interface DeploymentView {
  d: Deployment;
  name: string;
  colorIndex: number;
  replicaSets: ReplicaSet[];
}

export interface ServiceView {
  svc: Service;
  name: string;
  /** ready 인 엔드포인트의 Pod 이름 */
  ready: string[];
  notReady: string[];
  /** LoadBalancer IP 와 그 IP 를 ARP 로 맡은 노드 */
  lbIP?: string;
  announcer?: string;
}

export interface IngressView {
  ing: Ingress;
  name: string;
  address?: string;
  /** "host/path → service:port" */
  routes: string[];
}

export interface AppView {
  app: Application;
  name: string;
  /** Argo CD 가 지금 비교하는 리비전 / Git 의 최신 */
  seen?: string;
  head?: string;
}

export interface GitView {
  url: string;
  head?: { sha: string; message: string; author: string };
  commits: number;
}

/** StatefulSet 과 번호마다의 Pod·PVC */
export interface StatefulSetView {
  sts: StatefulSet;
  name: string;
  colorIndex: number;
  ordinals: { i: number; pod?: Pod; pvcs: PersistentVolumeClaim[] }[];
}

/** 노드에 묶인 디스크 (local-path PV) */
export interface DiskView {
  pv: string;
  claim?: string;
  size: number;
  /** 지금 이 디스크를 쓰는 Pod */
  pod?: string;
}

export interface ClusterView {
  statefulSets: StatefulSetView[];
  gits: GitView[];
  apps: AppView[];
  ingresses: IngressView[];
  services: ServiceView[];
  nodes: NodeView[];
  pending: PodView[];
  deployments: DeploymentView[];
  replicaSets: ReplicaSet[];
  pods: PodView[];
}

export const OWNER_COLORS = 6;

/** 노드 상자 아래에 띄울 "지금 무슨 일이 진행 중인가" 한 줄 (노드 장애 시계) */
export function nodeStory(n: NodeView, now: number): { tone: Tone; text: string } | undefined {
  const sec = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
  const mmss = (ms: number) => {
    const s = sec(ms);
    return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
  };
  if (n.unreachableSince !== undefined && n.powered) {
    return { tone: "wait", text: "다시 켜짐 — kubelet 이 Ready 를 보고함. node-lifecycle-controller 가 다음 확인(5초 주기) 때 taint 를 뗍니다" };
  }
  if (n.unreachableSince !== undefined) {
    const left = n.unreachableSince + DEFAULT_TOLERATION_SECONDS * 1000 - now;
    const stuck = n.pods.filter((p) => p.pod.metadata.deletionTimestamp !== undefined).length;
    if (left > 0) return { tone: "bad", text: `NotReady — ${mmss(left)} 뒤 이 노드의 Pod 를 eviction (기본 toleration ${DEFAULT_TOLERATION_SECONDS}초)` };
    if (!n.powered && stuck) return { tone: "bad", text: `Pod ${stuck}개가 Terminating 에 멈춤 — 컨테이너를 멈추고 확인해 줄 kubelet 이 없음` };
    return { tone: "bad", text: "NotReady — 이 노드의 Pod 는 다른 노드로 옮겨졌습니다" };
  }
  if (!n.powered) {
    const since = n.renewTime ?? 0;
    const left = since + NODE_MONITOR_GRACE_MS - now;
    return {
      tone: "wait",
      text: left > 0 ? `꺼짐 — 마지막 heartbeat ${sec(now - since)}초 전. API 는 아직 모름, 약 ${sec(left)}초 뒤 NotReady` : "꺼짐 — 곧 node-lifecycle-controller 가 알아챔 (5초 주기)",
    };
  }
  return undefined;
}

const BAD = new Set(["CrashLoopBackOff", "Error", "ErrImagePull", "ImagePullBackOff", "OOMKilled", "InvalidImageName", "CreateContainerConfigError"]);

export function toneOf(p: Pod, status: string): Tone {
  if (p.metadata.deletionTimestamp !== undefined) return "gone";
  if (BAD.has(status) || status.startsWith("ExitCode:")) return "bad";
  if (status === "Running" && isPodReady(p)) return "ok";
  return "wait";
}

export function buildView(c: Cluster): ClusterView {
  // api.list 와 같은 이름순 (색·자리가 만든 순서에 따라 바뀌지 않게)
  const deps = [...c.api.peekList("Deployment", "default")].sort(byName);
  const rss = [...c.api.peekList("ReplicaSet", "default")].sort(byName);
  const stss = [...c.api.peekList("StatefulSet", "default")].sort(byName);
  // 색은 Deployment·StatefulSet 을 함께 이름순으로 (Pod 칩의 왼쪽 띠 — 주인이 같으면 같은 색)
  const colorOf = new Map([...deps, ...stss].map((d) => d.metadata.name).sort().map((n, i) => [n, i % OWNER_COLORS]));
  const pvcs = [...c.api.peekList("PersistentVolumeClaim", "default")].sort(byName);
  const pvs = [...c.api.peekList("PersistentVolume")].sort(byName);
  const rsOwner = new Map(rss.map((r) => [r.metadata.uid, controllerOf(r.metadata)?.name]));
  const rsName = new Map(rss.map((r) => [r.metadata.uid, r.metadata.name]));
  const rsRev = new Map(rss.map((r) => [r.metadata.uid, revisionOf(r)]));
  const depByName = new Map(deps.map((d) => [d.metadata.name, d]));
  // 저장소의 오브젝트는 바뀔 때 통째로 바뀌므로(제자리 수정 없음) 복사 없이 읽는다 — 화면은 이것을 고치지 않는다
  const allPods = [...c.api.peekList("Pod")];
  const netpols = c.api.peekList("NetworkPolicy").length > 0;
  const pods: PodView[] = allPods.map((p) => {
    const status = podStatusText(p);
    const ref = controllerOf(p.metadata);
    const owner = ref ? (rsOwner.get(ref.uid) ?? ref.name) : undefined;
    const m = c.podMetrics(p);
    const memLimit = p.spec.containers[0] ? limitOf(p.spec.containers[0], "memory") : undefined;
    const iso = netpols ? isolation(c, p) : undefined;
    return {
      netpol: iso && (iso.ingress.length || iso.egress.length) ? { ingress: iso.ingress.map((n) => n.metadata.name), egress: iso.egress.map((n) => n.metadata.name) } : undefined,
      usage: m ? { cpu: m.cpu, memory: m.memory } : undefined,
      memOfLimit: m && memLimit ? m.memory / memLimit : undefined,
      cpuShort: m?.cpuState.reason,
      pod: p,
      name: p.metadata.name,
      status,
      ready: podReadyText(p),
      tone: toneOf(p, status),
      restarts: p.status.containerStatuses.reduce((n, s) => n + s.restartCount, 0),
      sick: c.podSick(p.metadata.name),
      owner,
      rs: ref ? rsName.get(ref.uid) : undefined,
      colorIndex: owner !== undefined ? (colorOf.get(owner) ?? hashIndex(owner)) : 0,
    };
  });
  const nodes: NodeView[] = [...c.api.peekList("Node")].sort(byName).map((n) => {
    const u = nodeUsage(allPods, n.metadata.name);
    const mine = pods.filter((p) => p.pod.spec.nodeName === n.metadata.name);
    const actual = mine.reduce((a, p) => ({ cpu: a.cpu + (p.usage?.cpu ?? 0), memory: a.memory + (p.usage?.memory ?? 0) }), { cpu: 0, memory: 0 });
    const lease = c.api.get("Lease", n.metadata.name, NODE_LEASE_NS);
    const noExec = (n.spec.taints ?? []).find((t) => t.key === "node.kubernetes.io/unreachable" && t.effect === "NoExecute");
    return {
      node: n,
      powered: c.nodePowered(n.metadata.name),
      renewTime: lease?.spec.renewTime,
      unreachableSince: noExec?.timeAdded,
      name: n.metadata.name,
      ip: n.status.addresses.find((a) => a.type === "InternalIP")?.address ?? "",
      status: nodeStatusText(n),
      ready: isNodeReady(n),
      cordoned: !!n.spec.unschedulable,
      cpu: { used: u.requested.cpu, total: n.status.allocatable.cpu, actual: actual.cpu },
      memory: { used: u.requested.memory, total: n.status.allocatable.memory, actual: actual.memory },
      pods: mine.sort(byCreation),
      disks: pvs
        .filter((v) => pvNode(v) === n.metadata.name)
        .map((v) => ({
          pv: v.metadata.name,
          claim: v.spec.claimRef?.name,
          size: v.spec.capacity.storage,
          pod: allPods.find((p) => p.metadata.deletionTimestamp === undefined && (p.spec.volumes ?? []).some((x) => x.persistentVolumeClaim?.claimName === v.spec.claimRef?.name))?.metadata.name,
        })),
    };
  });
  const slices = c.api.list("EndpointSlice", "default");
  const services: ServiceView[] = c.api.list("Service", "default").map((svc) => {
    const eps = slices.filter((s) => s.metadata.labels[SERVICE_NAME_LABEL] === svc.metadata.name).flatMap((s) => s.endpoints);
    const ip = svc.status.loadBalancer?.ingress?.[0]?.ip;
    return {
      svc,
      name: svc.metadata.name,
      ready: eps.filter((e) => e.conditions.ready).map((e) => e.targetRef.name),
      notReady: eps.filter((e) => !e.conditions.ready).map((e) => e.targetRef.name),
      lbIP: ip,
      announcer: ip ? c.metallb.announcer(svc.metadata.namespace ?? "default", svc.metadata.name) : undefined,
    };
  });
  const ingresses: IngressView[] = c.api.list("Ingress", "default").map((ing) => ({
    ing,
    name: ing.metadata.name,
    address: ing.status.loadBalancer.ingress?.[0]?.ip ?? ing.status.loadBalancer.ingress?.[0]?.hostname,
    routes: [
      ...(ing.spec.rules ?? []).flatMap((r) => r.http.paths.map((p) => `${r.host ?? "*"}${p.path}${p.pathType === "Prefix" && p.path !== "/" ? "*" : ""} → ${p.backend.service.name}:${p.backend.service.port.number}`)),
      ...(ing.spec.defaultBackend ? [`(기본) → ${ing.spec.defaultBackend.service.name}:${ing.spec.defaultBackend.service.port.number}`] : []),
    ],
  }));
  // 롤아웃 중인 Deployment (Pod 가 둘 이상의 RS 에 걸쳐 있음) 의 Pod 에만 리비전 표시
  const rsPerOwner = new Map<string, Set<string>>();
  for (const p of pods) if (p.owner && p.rs) (rsPerOwner.get(p.owner) ?? rsPerOwner.set(p.owner, new Set()).get(p.owner)!).add(p.rs);
  for (const p of pods) {
    if (!p.owner || (rsPerOwner.get(p.owner)?.size ?? 0) < 2) continue;
    const ref = controllerOf(p.pod.metadata);
    p.revision = ref ? rsRev.get(ref.uid) : undefined;
    const d = depByName.get(p.owner);
    p.isNew = !!d && p.pod.metadata.labels[HASH_LABEL] === deploymentHash(d);
  }
  const gits: GitView[] = [...c.git.values()].map((r) => ({ url: r.url, head: r.head ? { sha: r.head.sha, message: r.head.message, author: r.head.author } : undefined, commits: r.commits.length }));
  const apps: AppView[] = c.api.list("Application", "argocd").map((app) => ({ app, name: app.metadata.name, seen: c.argocd.fetchedRevision(app.metadata.name), head: c.git.get(app.spec.source.repoURL)?.head?.sha }));
  const statefulSets: StatefulSetView[] = stss.map((s) => {
    const name = s.metadata.name;
    const owned = allPods.filter((p) => controllerOf(p.metadata)?.uid === s.metadata.uid);
    // 보일 번호: 원하는 수까지 + 아직 남은 Pod + 남아 있는 PVC (줄였을 때 디스크가 남은 것을 보이려고)
    const nums = new Set(Array.from({ length: s.spec.replicas }, (_, i) => i));
    for (const p of owned) {
      const i = ordinalOf(name, p.metadata.name);
      if (i !== undefined) nums.add(i);
    }
    for (const t of s.spec.volumeClaimTemplates ?? []) for (const v of pvcs) if (v.metadata.name.startsWith(`${t.metadata.name}-${name}-`)) nums.add(Number(v.metadata.name.slice(`${t.metadata.name}-${name}-`.length)));
    return {
      sts: s,
      name,
      colorIndex: colorOf.get(name) ?? 0,
      ordinals: [...nums]
        .filter((i) => Number.isInteger(i))
        .sort((a, b) => a - b)
        .map((i) => ({
          i,
          pod: owned.find((p) => p.metadata.name === `${name}-${i}`),
          pvcs: (s.spec.volumeClaimTemplates ?? []).flatMap((t) => pvcs.filter((v) => v.metadata.name === claimName(t.metadata.name, name, i))),
        })),
    };
  });
  return {
    statefulSets,
    gits,
    apps,
    ingresses,
    services,
    nodes,
    pending: pods.filter((p) => !p.pod.spec.nodeName).sort(byCreation),
    deployments: deps.map((d) => ({
      d,
      name: d.metadata.name,
      colorIndex: colorOf.get(d.metadata.name) ?? 0,
      replicaSets: rss.filter((r) => controllerOf(r.metadata)?.uid === d.metadata.uid),
    })),
    replicaSets: rss,
    pods,
  };
}

function byName(a: { metadata: { name: string } }, b: { metadata: { name: string } }): number {
  return a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0;
}

function byCreation(a: PodView, b: PodView): number {
  return a.pod.metadata.creationTimestamp - b.pod.metadata.creationTimestamp || (a.name < b.name ? -1 : 1);
}

function hashIndex(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % OWNER_COLORS;
}

// ---------- 최근 결정 (캔버스의 짧은 이름표) ----------

/** 트레이스 한 줄을 Pod 위 짧은 이름표로. 이름표가 없는 종류는 undefined */
export function flashLabel(e: TraceEvent): string | undefined {
  switch (e.kind) {
    case "api.create":
      return e.ref?.kind === "Pod" ? `생성 · ${requester(e)}` : undefined;
    case "scheduler.bind":
      return `바인딩 · kube-scheduler`;
    case "scheduler.fail":
      return "자리 없음 · kube-scheduler";
    case "kubelet.sandbox":
      return "IP 할당 · kubelet";
    case "kubelet.pull":
      return "이미지 pull · kubelet";
    case "kubelet.pull.fail":
      return "pull 실패 · kubelet";
    case "kubelet.start":
      return "시작 · kubelet";
    case "kubelet.exit":
      return "종료 · kubelet";
    case "kubelet.oom":
      return "OOMKilled · 커널";
    case "kubelet.backoff":
      return "백오프 · kubelet";
    case "kubelet.kill":
      return "SIGTERM · kubelet";
    case "gc.delete":
      return `삭제 · ${e.actor}`;
    case "api.update":
      return e.ref?.kind === "Pod" && e.msg.includes("deletionTimestamp") ? `삭제 요청 · ${requester(e)}` : undefined;
    default:
      return undefined;
  }
}

/** "replicaset-controller 의 요청 → …" 에서 요청한 컴포넌트 */
export function requester(e: TraceEvent): string {
  const i = e.msg.indexOf(" 의 ");
  return i > 0 ? e.msg.slice(0, i) : e.actor;
}

/** 오브젝트마다 window 안의 마지막 이름표 */
export function recentFlashes(events: TraceEvent[], now: number, windowMs: number): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (now - e.t > windowMs) break;
    if (!e.ref) continue;
    const key = refKey(e.ref);
    if (out.has(key)) continue;
    const label = flashLabel(e);
    if (label) out.set(key, label);
  }
  return out;
}

export function refKey(r: ObjRef): string {
  return `${r.kind}/${r.name}`;
}

/** 컨트롤 플레인 구성 요소별 묶음 */
export const CONTROL_PLANE = [
  { id: "kube-apiserver", title: "kube-apiserver", role: "모든 오브젝트를 저장하고 watch 로 알림 (etcd 포함)", actors: ["kube-apiserver"] },
  { id: "kube-scheduler", title: "kube-scheduler", role: "노드가 없는 Pod 에 노드를 정함", actors: ["kube-scheduler"] },
  {
    id: "controller-manager",
    title: "kube-controller-manager",
    role: "원하는 상태와 지금 상태를 맞추는 컨트롤러들",
    actors: ["deployment-controller", "replicaset-controller", "endpointslice-controller", "garbage-collector", "pod-garbage-collector", "node-lifecycle-controller", "taint-eviction-controller"],
  },
  { id: "coredns", title: "CoreDNS", role: "Service 이름 → ClusterIP (kube-dns 10.96.0.10). 실제로는 kube-system 의 Pod — 축소판", actors: ["coredns"] },
] as const;

export function lastByActor(events: TraceEvent[], actors: readonly string[], skipKinds: (k: string) => boolean = () => false): TraceEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (actors.includes(e.actor) && !skipKinds(e.kind)) return e;
  }
  return undefined;
}
