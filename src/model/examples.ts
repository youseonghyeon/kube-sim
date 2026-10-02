// 예제: 노드 + 매니페스트 + "해 볼 것"(학습 포인트를 직접 확인하는 행동).
import { deployment, type DeploymentManifest } from "../core/cluster";
import type { Pod } from "../core/api/types";
import type { NodeDef } from "../core/kubelet";

export interface ClusterDef {
  nodes: NodeDef[];
  manifests: DeploymentManifest[];
}

export interface TryStep {
  /** 무엇을 해 보나 */
  title: string;
  /** 무엇을 보게 되나 (학습 포인트) */
  expect: string;
  /** 눌러서 실행할 kubectl 명령. {pod:<deploy>} 는 그 Deployment 의 첫 Pod 이름, {node:<n>} 는 n 번째 노드 이름으로 바뀐다 */
  command?: string;
}

export interface Example {
  id: string;
  title: string;
  summary: string;
  build: () => ClusterDef;
  tries: TryStep[];
}

const node = (name: string, cpu = 2000, memory = 4096): NodeDef => ({ name, cpu, memory });

export const EXAMPLES: Example[] = [
  {
    id: "basics",
    title: "Deployment 하나 (replicas 3)",
    summary: "Deployment → ReplicaSet → Pod 가 어떻게 생기고, 지운 Pod 가 왜 다시 생기는지 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 250, memory: 128 })],
    }),
    tries: [
      {
        title: "Pod 하나 지우기",
        command: "kubectl delete pod {pod:web}",
        expect: "지운 Pod 는 Terminating 으로 남고, ReplicaSet 이 '원하는 3 · 있는 2' 를 보고 곧바로 새 Pod 를 만듭니다. 새 Pod 는 이름도 IP 도 다릅니다.",
      },
      {
        title: "replicas 를 5 로",
        command: "kubectl scale deployment/web --replicas=5",
        expect: "Deployment → ReplicaSet 의 replicas 가 바뀌고, ReplicaSet 이 Pod 2개를 더 만듭니다. 스케줄러는 더 비어 있는 노드에 둡니다.",
      },
      {
        title: "이미지 바꾸기",
        command: "kubectl set image deployment/web web=nginx:1.28",
        expect: "템플릿이 바뀌면 해시가 다른 새 ReplicaSet 이 생기고 옛 ReplicaSet 은 0 으로 줄어듭니다 (축소판: 롤링 업데이트는 3단계).",
      },
      {
        title: "Deployment 지우기",
        command: "kubectl delete deployment web",
        expect: "가비지 컬렉터가 ownerReferences 를 따라 ReplicaSet 을, 그다음 Pod 를 지웁니다.",
      },
    ],
  },
  {
    id: "pending",
    title: "자리가 모자란 클러스터 (Pending)",
    summary: "requests 를 채울 노드가 없으면 Pod 는 Pending 에서 멈춥니다. 스케줄러가 남기는 이유를 읽어 봅니다.",
    build: () => ({
      nodes: [node("worker-1", 1000, 2048), node("worker-2", 1000, 2048), node("worker-3", 1000, 2048)],
      manifests: [deployment("api", { replicas: 4, image: "nginx:1.27", cpu: 600, memory: 256 })],
    }),
    tries: [
      {
        title: "왜 Pending 인지 보기",
        command: "kubectl get events",
        expect: "FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu. — 노드마다 cpu 1 중 600m 가 이미 찼고, 600m 를 더 넣을 곳이 없습니다.",
      },
      {
        title: "requests 줄이기",
        command: "kubectl set resources deployment/api --requests=cpu=400m",
        expect: "새 템플릿의 ReplicaSet 이 생기고, 400m × 4 는 노드 3대(각 1 cpu)에 들어갑니다. 옛 Pod 가 사라지며 자리가 나는 순서도 보세요.",
      },
      {
        title: "replicas 줄이기",
        command: "kubectl scale deployment/api --replicas=3",
        expect: "ReplicaSet 은 지울 Pod 로 아직 안 뜬 것(Pending)부터 고릅니다.",
      },
      {
        title: "노드 하나 더",
        expect: "왼쪽 '노드' 의 + 로 노드를 더하면 스케줄러가 클러스터 변화를 보고 기다리던 Pod 를 다시 시도합니다.",
      },
    ],
  },
  {
    id: "crashloop",
    title: "크래시하는 앱 (CrashLoopBackOff)",
    summary: "시작하자마자 죽는 컨테이너를 kubelet 이 어떻게 다시 띄우는지, 왜 간격이 점점 길어지는지 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 250, memory: 128 }),
        deployment("worker", { replicas: 1, image: "example/worker:1.0", cpu: 100, memory: 64 }),
      ],
    }),
    tries: [
      {
        title: "백오프 지켜보기",
        expect: "첫 재시작은 바로, 그다음은 10초 · 20초 · 40초 … 최대 5분 간격입니다. 상단 속도를 10× 로 올려 보세요. Pod 상태는 Running ↔ Error ↔ CrashLoopBackOff 를 오갑니다.",
      },
      {
        title: "describe 로 이유 보기",
        command: "kubectl describe pod {pod:worker}",
        expect: "Last State: Terminated · Exit Code 1, Events 의 BackOff (xN over …) 가 몇 번째 재시작인지 알려 줍니다.",
      },
      {
        title: "고친 이미지로 바꾸기",
        command: "kubectl set image deployment/worker worker=example/worker:1.1",
        expect: "새 ReplicaSet 의 Pod 는 정상으로 뜹니다. 백오프는 Pod 마다라서 새 Pod 는 처음부터 시작합니다.",
      },
    ],
  },
  {
    id: "imagepull",
    title: "이미지 이름 오타 (ImagePullBackOff)",
    summary: "레지스트리에 없는 이미지를 받으려 할 때 kubelet 이 어떻게 재시도하는지 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [deployment("web", { replicas: 2, image: "ngnix:1.27", cpu: 250, memory: 128 })],
    }),
    tries: [
      {
        title: "오류 문구 읽기",
        command: "kubectl describe pod {pod:web}",
        expect: "Failed to pull image \"ngnix:1.27\" … not found → ErrImagePull → ImagePullBackOff. 이미지 이름이 nginx 가 아니라 ngnix 입니다.",
      },
      {
        title: "이미지 이름 고치기",
        command: "kubectl set image deployment/web web=nginx:1.27",
        expect: "새 ReplicaSet 의 Pod 가 이미지를 받아 Running 이 됩니다.",
      },
    ],
  },
  {
    id: "nodes",
    title: "노드 비우기와 빼기",
    summary: "cordon 으로 새 Pod 를 막고, 노드를 빼면 그 위의 Pod 가 다른 노드로 다시 생기는 것을 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2"), node("worker-3")],
      manifests: [deployment("web", { replicas: 6, image: "nginx:1.27", cpu: 250, memory: 128 })],
    }),
    tries: [
      {
        title: "worker-3 cordon",
        command: "kubectl cordon worker-3",
        expect: "노드가 SchedulingDisabled 가 됩니다. 이미 있는 Pod 는 그대로입니다.",
      },
      {
        title: "worker-3 의 Pod 지우기",
        command: "kubectl delete pod {pod-on:worker-3}",
        expect: "새 Pod 는 worker-3 에 가지 않습니다 — 스케줄러가 node(s) were unschedulable 로 거릅니다.",
      },
      {
        title: "노드 빼기",
        expect: "왼쪽 '노드' 목록에서 worker-1 을 빼 보세요. pod-garbage-collector 가 사라진 노드의 Pod 를 지우고, ReplicaSet 이 다른 노드에 다시 만듭니다 (실제 노드 장애의 5분 대기는 다음 단계).",
      },
    ],
  },
];

export const DEFAULT_EXAMPLE = "basics";

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/**
 * "해 볼 것" 명령의 자리표시자를 지금 클러스터의 이름으로 바꾼다.
 * {pod:web} → app=web 인 살아 있는 Pod 중 첫째, {pod-on:worker-3} → 그 노드의 첫 Pod. 못 찾으면 undefined (버튼을 끈다)
 */
export function resolveCommand(pods: Pod[], cmd: string): string | undefined {
  const alive = pods.filter((p) => p.metadata.deletionTimestamp === undefined);
  let missing = false;
  const out = cmd
    .replace(/\{pod:([\w-]+)\}/g, (_, d: string) => alive.find((p) => p.metadata.labels.app === d)?.metadata.name ?? ((missing = true), ""))
    .replace(/\{pod-on:([\w-]+)\}/g, (_, n: string) => alive.find((p) => p.spec.nodeName === n)?.metadata.name ?? ((missing = true), ""));
  return missing ? undefined : out;
}
