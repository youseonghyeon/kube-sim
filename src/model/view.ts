// 화면에 그릴 모양을 클러스터에서 뽑는다 (순수 함수 — 테스트 가능).
import { controllerOf, isNodeReady, isPodReady, type Deployment, type Node, type Pod, type ReplicaSet } from "../core/api/types";
import type { Cluster } from "../core/cluster";
import { nodeStatusText, podReadyText, podStatusText } from "../core/kubectl";
import { nodeUsage } from "../core/scheduler";
import type { ObjRef, TraceEvent } from "../core/trace";

export type Tone = "ok" | "wait" | "bad" | "gone";

export interface PodView {
  pod: Pod;
  name: string;
  status: string;
  ready: string;
  tone: Tone;
  restarts: number;
  /** 주인 Deployment (없으면 ReplicaSet, 그것도 없으면 undefined) */
  owner?: string;
  rs?: string;
  colorIndex: number;
}

export interface NodeView {
  node: Node;
  name: string;
  ip: string;
  status: string;
  ready: boolean;
  cordoned: boolean;
  cpu: { used: number; total: number };
  memory: { used: number; total: number };
  pods: PodView[];
}

export interface DeploymentView {
  d: Deployment;
  name: string;
  colorIndex: number;
  replicaSets: ReplicaSet[];
}

export interface ClusterView {
  nodes: NodeView[];
  pending: PodView[];
  deployments: DeploymentView[];
  replicaSets: ReplicaSet[];
  pods: PodView[];
}

export const OWNER_COLORS = 6;

const BAD = new Set(["CrashLoopBackOff", "Error", "ErrImagePull", "ImagePullBackOff", "OOMKilled", "InvalidImageName", "CreateContainerConfigError"]);

export function toneOf(p: Pod, status: string): Tone {
  if (p.metadata.deletionTimestamp !== undefined) return "gone";
  if (BAD.has(status) || status.startsWith("ExitCode:")) return "bad";
  if (status === "Running" && isPodReady(p)) return "ok";
  return "wait";
}

export function buildView(c: Cluster): ClusterView {
  const deps = c.api.list("Deployment", "default");
  const rss = c.api.list("ReplicaSet", "default");
  const colorOf = new Map(deps.map((d, i) => [d.metadata.name, i % OWNER_COLORS]));
  const rsOwner = new Map(rss.map((r) => [r.metadata.uid, controllerOf(r.metadata)?.name]));
  const rsName = new Map(rss.map((r) => [r.metadata.uid, r.metadata.name]));
  const allPods = c.api.list("Pod");
  const pods: PodView[] = allPods.map((p) => {
    const status = podStatusText(p);
    const ref = controllerOf(p.metadata);
    const owner = ref ? (rsOwner.get(ref.uid) ?? ref.name) : undefined;
    return {
      pod: p,
      name: p.metadata.name,
      status,
      ready: podReadyText(p),
      tone: toneOf(p, status),
      restarts: p.status.containerStatuses.reduce((n, s) => n + s.restartCount, 0),
      owner,
      rs: ref ? rsName.get(ref.uid) : undefined,
      colorIndex: owner !== undefined ? (colorOf.get(owner) ?? hashIndex(owner)) : 0,
    };
  });
  const nodes: NodeView[] = c.api.list("Node").map((n) => {
    const u = nodeUsage(allPods, n.metadata.name);
    return {
      node: n,
      name: n.metadata.name,
      ip: n.status.addresses.find((a) => a.type === "InternalIP")?.address ?? "",
      status: nodeStatusText(n),
      ready: isNodeReady(n),
      cordoned: !!n.spec.unschedulable,
      cpu: { used: u.requested.cpu, total: n.status.allocatable.cpu },
      memory: { used: u.requested.memory, total: n.status.allocatable.memory },
      pods: pods.filter((p) => p.pod.spec.nodeName === n.metadata.name).sort(byCreation),
    };
  });
  return {
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
    actors: ["deployment-controller", "replicaset-controller", "garbage-collector", "pod-garbage-collector"],
  },
] as const;

export function lastByActor(events: TraceEvent[], actors: readonly string[], skipKinds: (k: string) => boolean = () => false): TraceEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (actors.includes(e.actor) && !skipKinds(e.kind)) return e;
  }
  return undefined;
}
