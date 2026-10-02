// 예제: 노드 + 매니페스트 + "해 볼 것"(학습 포인트를 직접 확인하는 행동).
import { deployment, service, type Manifest } from "../core/cluster";
import type { Pod } from "../core/api/types";
import type { NodeDef } from "../core/kubelet";

export interface ClusterDef {
  nodes: NodeDef[];
  manifests: Manifest[];
}

export interface TryStep {
  /** 무엇을 해 보나 */
  title: string;
  /** kubectl 이 아닌 동작 */
  action?:
    | { type: "power"; node: string; on: boolean }
    /** 클러스터 밖에서 그 노드의 NodePort 로 curl */
    | { type: "nodeport"; node: string; service: string }
    /** Deployment 의 첫 Pod 의 앱을 고장 내거나 고침 */
    | { type: "sick"; deployment: string; healthy: boolean };
  /** 무엇을 보게 되나 (학습 포인트) */
  expect: string;
  /** 실패하는 것이 학습 포인트인 명령 (예: ClusterIP 로 ping) */
  expectFail?: boolean;
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
        title: "replicas 줄이기",
        command: "kubectl scale deployment/api --replicas=3",
        expect: "ReplicaSet 은 지울 Pod 로 아직 안 뜬 것(Pending)부터 고릅니다 — Running 3개는 그대로입니다.",
      },
      {
        title: "다시 4 로 늘리고 노드 하나 더",
        command: "kubectl scale deployment/api --replicas=4",
        expect: "새 Pod 는 다시 Pending 입니다. 왼쪽 '노드' 의 + 로 노드를 더하면 스케줄러가 클러스터 변화를 보고 기다리던 Pod 를 다시 시도합니다.",
      },
      {
        title: "requests 줄이기",
        command: "kubectl set resources deployment/api --requests=cpu=400m",
        expect: "템플릿이 바뀌어 새 ReplicaSet 이 생깁니다. 옛 Pod 가 Terminating 으로 자리를 비우는 대로 400m Pod 가 들어갑니다.",
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
    id: "node-down",
    title: "노드 하나 죽이기 (왜 5분이 걸리나)",
    summary: "노드가 꺼져도 Pod 가 바로 옮겨지지 않는 이유 — Lease 40초, NotReady·taint, toleration 300초, 그리고 Terminating 에 멈추는 Pod.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2"), node("worker-3")],
      manifests: [deployment("web", { replicas: 6, image: "nginx:1.27", cpu: 250, memory: 128 })],
    }),
    tries: [
      {
        title: "heartbeat 보기",
        command: "kubectl get leases -n kube-node-lease",
        expect: "kubelet 은 10초마다 자기 노드의 Lease 를 갱신합니다. RENEWED 가 10초를 넘지 않습니다.",
      },
      {
        title: "worker-2 끄기",
        action: { type: "power", node: "worker-2", on: false },
        expect: "컨테이너는 이미 멈췄지만 API 는 아직 모릅니다. 40초 동안 노드는 Ready, Pod 는 Running 으로 보입니다. 속도를 10× 로 올려 보세요.",
      },
      {
        title: "NotReady 확인",
        command: "kubectl describe node worker-2",
        expect: "Lease 가 40초 넘게 끊기면 node-lifecycle-controller 가 Ready=Unknown 과 taint node.kubernetes.io/unreachable 을 붙입니다. Pod 는 Ready=False 가 되지만 STATUS 는 여전히 Running 입니다.",
      },
      {
        title: "5분 기다리기",
        expect: "Pod 마다 붙은 기본 toleration(unreachable 300초)이 끝나야 taint-eviction-controller 가 지웁니다. 그제야 ReplicaSet 이 다른 노드에 새 Pod 를 만듭니다. 옛 Pod 는 정리해 줄 kubelet 이 없어 Terminating 에 멈춥니다.",
      },
      {
        title: "worker-2 다시 켜기",
        action: { type: "power", node: "worker-2", on: true },
        expect: "kubelet 이 돌아와 Ready 를 보고하고, Terminating 이던 Pod 를 정리합니다. taint 가 빠지면 새 Pod 가 다시 갈 수 있습니다 (옮겨 간 Pod 가 돌아오지는 않습니다).",
      },
    ],
  },
  {
    id: "service",
    title: "Service 로 Pod 3개에 나누기",
    summary: "Pod IP 는 바뀌므로 Service 의 고정 주소(ClusterIP)로 부릅니다. 요청 하나가 DNS → iptables DNAT → 노드 간 경로 → Pod 로 가는 길을 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 250, memory: 128, port: 80 }),
        deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }),
        service("web", { selector: { app: "web" }, port: 80 }),
      ],
    }),
    tries: [
      {
        title: "엔드포인트 보기",
        command: "kubectl get endpoints web",
        expect: "EndpointSlice 컨트롤러가 app=web 이고 Ready 인 Pod 의 IP 를 모았습니다. Service 는 이 목록을 가리키는 이름표입니다.",
      },
      {
        title: "client 에서 curl (여러 번)",
        command: "kubectl exec {pod:client} -- curl http://web",
        expect: "DNS 가 web → ClusterIP 로 풀고, client 가 있는 노드의 iptables 규칙(kube-proxy 가 써 둔 것)이 엔드포인트 하나를 골라 DNAT 합니다. 여러 번 누르면 응답하는 Pod 가 바뀌고, 다른 노드의 Pod 면 flannel VXLAN 단계가 보입니다.",
      },
      {
        title: "ClusterIP 로 ping",
        command: "kubectl exec {pod:client} -- ping web",
        expectFail: true,
        expect: "실패합니다. ClusterIP 는 어떤 장치에도 없는 가상 주소이고, 규칙은 TCP 포트에만 있어 ICMP 에 답할 곳이 없습니다.",
      },
      {
        title: "nslookup 으로 이름 풀기",
        command: "kubectl exec {pod:client} -- nslookup web",
        expect: "web 은 web.default.svc.cluster.local 로 풀립니다. Pod 의 resolv.conf 에 search 도메인이 있어서입니다 (짧은 이름은 search 를 먼저 붙여 봄 — ndots:5).",
      },
      {
        title: "web Pod 하나 지우기",
        command: "kubectl delete pod {pod:web}",
        expect: "지운 Pod 는 엔드포인트에서 곧 빠지고, 새 Pod 가 Ready 가 되면 새 IP 로 들어갑니다. Service 주소는 그대로라 client 는 몰라도 됩니다.",
      },
      {
        title: "NodePort 로 바깥에 열기",
        command: "kubectl expose deployment web --port=80 --type=NodePort --name=web-np",
        expect: "모든 노드의 30000-32767 중 한 포트가 열립니다.",
      },
      {
        title: "바깥에서 worker-1 의 NodePort 로",
        action: { type: "nodeport", node: "worker-1", service: "web-np" },
        expect: "worker-1 의 규칙이 아무 노드의 Pod 로 보냅니다 (externalTrafficPolicy: Cluster). 이때 출발지 IP 가 노드 IP 로 바뀌어(SNAT) Pod 는 원래 클라이언트 IP 를 모릅니다 — 같은 노드의 Pod 로 가도 그렇습니다.",
      },
    ],
  },
  {
    id: "readiness",
    title: "readiness: Running 인데 왜 트래픽이 안 가나",
    summary: "Running 은 컨테이너가 돈다는 뜻일 뿐입니다. readiness probe 를 통과해 Ready 가 돼야 EndpointSlice 에 들어가 트래픽을 받습니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("api", { replicas: 3, image: "example/api:1.0", cpu: 200, memory: 128, port: 8080, readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 5 } }),
        deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }),
        service("api", { selector: { app: "api" }, port: 80, targetPort: 8080 }),
      ],
    }),
    tries: [
      {
        title: "준비 시간 지켜보기",
        command: "kubectl get pods",
        expect: "api Pod 는 15초 동안 캐시를 데우느라 /ready 가 503 입니다. 그동안 READY 0/1 · STATUS Running 입니다. 이때 curl 하면 has no endpoints 로 거부됩니다.",
      },
      {
        title: "Ready 뒤 curl",
        command: "kubectl exec {pod:client} -- curl http://api",
        expect: "Ready 가 된 Pod 만 엔드포인트에 있어 요청을 받습니다.",
      },
      {
        title: "api Pod 하나 고장 내기",
        action: { type: "sick", deployment: "api", healthy: false },
        expect: "DB 연결이 끊긴 것처럼 /ready 가 503 이 됩니다. probe 가 3번 연속 실패하면(5초 주기) Ready=False → EndpointSlice 에서 빠집니다. 컨테이너는 계속 Running 이고 재시작도 하지 않습니다 (그건 liveness 의 일).",
      },
      {
        title: "엔드포인트 확인",
        command: "kubectl get endpointslices",
        expect: "고장 난 Pod 의 IP 는 목록에는 있지만 ready=false 입니다 (인스펙터의 Service 개요에서 보입니다). curl 을 여러 번 보내도 그 Pod 는 받지 않습니다.",
      },
      {
        title: "고치기",
        action: { type: "sick", deployment: "api", healthy: true },
        expect: "다음 probe 가 통과하면 바로 Ready=True → 다시 엔드포인트에 들어갑니다.",
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

export type TryAction = NonNullable<TryStep["action"]>;

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
