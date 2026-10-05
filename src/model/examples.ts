// 예제: 노드 + 매니페스트 + "해 볼 것"(학습 포인트를 직접 확인하는 행동).
import { application, deployment, ingress, pdb, service, type Manifest } from "../core/cluster";

const NET_SIM_REPO = "https://github.com/youseonghyeon/net-sim.git";
import type { Pod } from "../core/api/types";
import type { NodeDef } from "../core/kubelet";

export interface ClusterDef {
  nodes: NodeDef[];
  manifests: Manifest[];
  /** 처음부터 있는 Git 저장소 (GitOps 예제) — 첫 커밋 */
  git?: { url: string; message: string; files: Record<string, Manifest> }[];
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
    | { type: "sick"; deployment: string; healthy: boolean }
    /** client Pod 에서 Service 로 계속 요청 보내기 / 멈추기 */
    | { type: "traffic"; service: string; on: boolean }
    /** 매니페스트에 preStop sleep 을 넣는다 (kubectl apply 와 같음) */
    | { type: "prestop"; deployment: string; seconds: number }
    /** CI: 새 이미지를 빌드해 Git 의 그 파일 image 태그를 바꿔 커밋 (github-actions) */
    | { type: "ci-bump"; repo: string; file: string }
    /** Git 에서 파일을 지우고 커밋 */
    | { type: "git-rm"; repo: string; file: string };
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
    id: "rolling",
    title: "롤링 업데이트 (maxSurge · maxUnavailable)",
    summary: "이미지를 바꾸면 새 ReplicaSet 이 늘고 옛 ReplicaSet 이 줄어듭니다. 그동안 Pod 수와 Ready 수가 어디까지 움직이는지 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("web", { replicas: 4, image: "nginx:1.27", cpu: 200, memory: 128, port: 80, preStop: 5 }),
        deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }),
        service("web", { selector: { app: "web" }, port: 80 }),
      ],
    }),
    tries: [
      { title: "부하 보내기", action: { type: "traffic", service: "web", on: true }, expect: "client 에서 0.1초마다 web 으로 curl 을 보냅니다. 위쪽 '부하' 막대에 성공·실패가 쌓입니다." },
      {
        title: "이미지 바꾸기",
        command: "kubectl set image deployment/web web=nginx:1.28",
        expect: "replicas 4, 기본 25%/25% → maxSurge 1 · maxUnavailable 1. Terminating 을 빼면 전체 Pod 는 5개를 넘지 않고 Ready 는 3개 밑으로 내려가지 않습니다 (preStop 5초 동안 Terminating 인 옛 Pod 는 maxSurge 에 세지 않아 화면에는 더 보입니다). Pod 칩의 r1·r2 가 옛·새 리비전입니다. 이 Deployment 는 preStop 이 있어 요청 실패가 없습니다.",
      },
      { title: "진행 보기", command: "kubectl rollout status deployment/web", expect: "새 Pod 몇 개가 바뀌었는지, 옛 Pod 가 몇 개 남았는지 한 줄로 알려 줍니다." },
      { title: "이력 보기", command: "kubectl rollout history deployment/web", expect: "리비전마다 ReplicaSet 이 하나씩 남아 있습니다 (그래서 되돌릴 수 있습니다)." },
      { title: "되돌리기", command: "kubectl rollout undo deployment/web", expect: "옛 ReplicaSet 을 다시 늘리고 리비전 번호를 맨 위(3)로 올립니다. 새 RS 를 만들지 않습니다." },
    ],
  },
  {
    id: "rollout-stuck",
    title: "새 버전이 안 뜨면 롤아웃이 멈춘다",
    summary: "readiness 를 통과하지 못하는 새 버전을 배포합니다. 옛 Pod 를 maxUnavailable 만큼만 줄이고 멈춰, 서비스는 옛 버전으로 계속 됩니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("api", { replicas: 4, image: "example/api:1.1", cpu: 200, memory: 128, port: 8080, readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 3 }, preStop: 3 }),
        deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }),
        service("api", { selector: { app: "api" }, port: 80, targetPort: 8080 }),
      ],
    }),
    tries: [
      { title: "부하 보내기", action: { type: "traffic", service: "api", on: true }, expect: "api 로 계속 요청을 보냅니다." },
      {
        title: "망가진 2.0 배포",
        command: "kubectl set image deployment/api api=example/api:2.0",
        expect: "새 Pod 2개가 생기지만 /ready 가 계속 503 이라 Ready 가 안 됩니다. 옛 Pod 는 1개만 줄고(3개 남음) 거기서 멈춥니다. 요청은 Ready 인 옛 Pod 로만 가서 실패가 없습니다.",
      },
      { title: "왜 멈췄나", command: "kubectl rollout status deployment/api", expect: "2 out of 4 new replicas have been updated... 에서 더 나아가지 않습니다. 600초(progressDeadlineSeconds)가 지나면 ProgressDeadlineExceeded 로 바뀝니다 — 속도를 30× 로 올려 보세요." },
      { title: "조건 보기", command: "kubectl describe deployment api", expect: "Conditions 의 Available·Progressing 과 OldReplicaSets·NewReplicaSet 이 지금 상태를 말해 줍니다." },
      { title: "되돌리기", command: "kubectl rollout undo deployment/api", expect: "옛 템플릿으로 돌아가 망가진 Pod 를 지우고 4개로 회복합니다. 쿠버네티스는 스스로 되돌리지 않습니다 — 사람(또는 Argo Rollouts 같은 도구)의 몫." },
    ],
  },
  {
    id: "graceful",
    title: "Pod 를 지울 때 왜 요청이 실패하나 (preStop)",
    summary: "Pod 를 지우면 SIGTERM 과 엔드포인트 제거가 동시에 시작됩니다. 앱이 먼저 멈추면, 아직 규칙이 안 바뀐 노드에서 온 요청이 실패합니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 200, memory: 128, port: 80 }),
        deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }),
        service("web", { selector: { app: "web" }, port: 80 }),
      ],
    }),
    tries: [
      { title: "부하 보내기", action: { type: "traffic", service: "web", on: true }, expect: "0.1초마다 curl. 처음에는 모두 성공합니다." },
      {
        title: "Pod 하나 지우기",
        command: "kubectl delete pod {pod:web}",
        expect: "SIGTERM 을 받은 nginx 는 바로 새 연결을 받지 않는데, kube-proxy 가 규칙을 바꾸기까지 1초쯤 걸려 그사이 그 Pod 로 간 요청이 연결 거부됩니다 (부하 막대의 빨간 칸).",
      },
      {
        title: "preStop sleep 5초 넣기",
        action: { type: "prestop", deployment: "web", seconds: 5 },
        expect: "템플릿이 바뀌어 롤링 업데이트가 일어납니다 — 옛 Pod 는 preStop 이 없으니 이번에도 실패가 조금 생깁니다. 끝나면 부하 막대의 '0 으로' 를 누르세요.",
      },
      {
        title: "다시 Pod 하나 지우기",
        command: "kubectl delete pod {pod:web}",
        expect: "이번에는 SIGTERM 전에 5초 기다립니다. 그사이 엔드포인트에서 빠지고 모든 노드의 규칙이 바뀌어, 그 Pod 로 가는 요청이 없어진 뒤에 앱이 멈춥니다. 실패 0.",
      },
    ],
  },
  {
    id: "liveness",
    title: "liveness: 멈춘 앱은 재시작으로 살린다",
    summary: "readiness 는 트래픽을 빼고, liveness 는 컨테이너를 죽였다 다시 띄웁니다. 재시작하면 풀리는 고장(교착)에 쓰는 것입니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("api", {
          replicas: 2,
          image: "example/api:1.1",
          cpu: 200,
          memory: 128,
          port: 8080,
          readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 3 },
          liveness: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 5 },
        }),
        deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }),
        service("api", { selector: { app: "api" }, port: 80, targetPort: 8080 }),
      ],
    }),
    tries: [
      {
        title: "api Pod 하나 멈추게 하기",
        action: { type: "sick", deployment: "api", healthy: false },
        expect: "readiness 가 먼저 실패해 엔드포인트에서 빠지고(3초 주기 × 3번), liveness 도 3번 실패하면(5초 주기) kubelet 이 컨테이너를 죽이고 다시 띄웁니다. 새 프로세스는 멀쩡해 다시 Ready 가 됩니다. RESTARTS 가 1 오릅니다.",
      },
      { title: "이벤트 보기", command: "kubectl describe pod {pod:api}", expect: "Unhealthy (Readiness/Liveness probe failed) 와 Killing: Container api failed liveness probe, will be restarted 가 보입니다." },
    ],
  },
  {
    id: "drain",
    title: "drain 과 PodDisruptionBudget",
    summary: "노드 점검 전에 drain 으로 Pod 를 내보냅니다. PDB(minAvailable 2)가 있으면 Ready 가 2개 밑으로 떨어지는 내보내기는 거절되고, 5초 뒤 다시 시도합니다.",
    build: () => ({
      // 노드 2대에 3개 → worker-1 에 2개가 가서, 두 번째 내보내기가 PDB 에 막히는 것이 보인다
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 300, memory: 128, port: 80 }),
        pdb("web-pdb", { app: "web" }, { minAvailable: 2 }),
      ],
    }),
    tries: [
      { title: "PDB 보기", command: "kubectl get pdb", expect: "Ready 3, 최소 2 → 지금 허용되는 중단 1개 (ALLOWED DISRUPTIONS)." },
      {
        title: "worker-1 비우기",
        command: "kubectl drain worker-1 --ignore-daemonsets",
        expect: "노드를 cordon 하고 Pod 를 Eviction API 로 내보냅니다. 허용 수가 0 이면 'Cannot evict pod as it would violate the pod's disruption budget.' 으로 거절되고 5초 뒤 다시 시도합니다. 대체 Pod 가 Ready 가 되면 다음 것을 내보냅니다.",
      },
      { title: "다시 쓰기", command: "kubectl uncordon worker-1", expect: "점검이 끝나면 uncordon 해야 새 Pod 가 다시 갑니다 (옮겨 간 Pod 가 돌아오지는 않습니다)." },
    ],
  },
  {
    id: "ingress",
    title: "도메인 둘을 Ingress 하나로 (ingress-nginx)",
    summary: "바깥 요청은 ingress-nginx 의 LoadBalancer IP 로 들어와, Host 와 경로에 따라 서로 다른 Service 의 Pod 로 갑니다. 그동안 클라이언트 IP 가 어떻게 되는지도 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("ingress-nginx-controller", { replicas: 1, image: "registry.k8s.io/ingress-nginx/controller:v1.11.2", cpu: 100, memory: 128, port: 80 }),
        service("ingress-nginx-controller", { selector: { app: "ingress-nginx-controller" }, port: 80, type: "LoadBalancer" }),
        deployment("shop", { replicas: 2, image: "traefik/whoami:v1.10", cpu: 100, memory: 64, port: 80 }),
        service("shop", { selector: { app: "shop" }, port: 80 }),
        deployment("api", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }),
        service("api", { selector: { app: "api" }, port: 80 }),
        ingress("shop", {
          className: "nginx",
          rules: [
            { host: "shop.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "shop", port: { number: 80 } } } }] } },
            { host: "api.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } },
          ],
        }),
      ],
    }),
    tries: [
      { title: "LoadBalancer IP 보기", command: "kubectl get svc ingress-nginx-controller", expect: "MetalLB 가 192.168.0.240 을 주고(EXTERNAL-IP), 노드 하나가 그 IP 를 ARP 로 맡습니다. 캔버스의 Service 상자에 어느 노드가 맡았는지 보입니다." },
      { title: "Ingress 보기", command: "kubectl get ingress", expect: "호스트 두 개가 같은 ADDRESS(컨트롤러의 LoadBalancer IP)를 씁니다." },
      {
        title: "shop.example.com 으로",
        command: "curl http://shop.example.com/",
        expect: "바깥 DNS → LB IP → 맡은 노드 → kube-proxy 가 ingress-nginx Pod 로 → nginx 가 Host 를 보고 shop 의 Pod 로 직접 프록시. whoami 응답의 X-Forwarded-For 가 클라이언트(203.0.113.7)가 아니라 노드 IP 입니다 — externalTrafficPolicy: Cluster 의 SNAT 때문.",
      },
      { title: "api.example.com 으로", command: "curl http://api.example.com/", expect: "같은 IP·같은 nginx 지만 Host 가 달라 api 의 Pod 로 갑니다." },
      { title: "Host 없이 IP 로", command: "curl http://192.168.0.240/", expect: "Host 가 IP 라 맞는 규칙이 없어 ingress-nginx 의 404 를 받습니다.", expectFail: true },
      {
        title: "클라이언트 IP 지키기",
        command: `kubectl patch svc ingress-nginx-controller -p '{"spec":{"externalTrafficPolicy":"Local"}}'`,
        expect: "Local 이면 SNAT 하지 않고, ingress-nginx Pod 가 있는 노드만 IP 를 맡습니다. 다시 shop 으로 curl 하면 X-Forwarded-For 가 203.0.113.7 입니다.",
      },
      { title: "다시 shop 으로", command: "curl http://shop.example.com/", expect: "X-Forwarded-For: 203.0.113.7 — 앱이 진짜 클라이언트를 압니다." },
    ],
  },
  {
    id: "source-ip",
    title: "출발지 IP 가 사라지는 이유 (externalTrafficPolicy)",
    summary: "whoami 는 받은 요청의 출발지(RemoteAddr)를 그대로 보여 줍니다. Cluster 와 Local 에서 무엇이 다른지, 왜 Local 은 Pod 가 없는 노드로 오면 버리는지 봅니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("who", { replicas: 1, image: "traefik/whoami:v1.10", cpu: 100, memory: 64, port: 80, nodeSelector: { "kubernetes.io/hostname": "worker-2" } }),
        service("who", { selector: { app: "who" }, port: 80, type: "LoadBalancer", nodePort: 30080 }),
      ],
    }),
    tries: [
      { title: "LoadBalancer 로", command: "curl http://192.168.0.240/", expect: "RemoteAddr 가 노드 IP 입니다 (Cluster: 들어온 노드가 출발지를 자기 IP 로 바꿔 응답이 자기에게 돌아오게 함)." },
      { title: "Pod 없는 노드의 NodePort 로", command: "curl http://192.168.0.11:30080/", expect: "worker-1 에는 Pod 가 없지만 Cluster 라 worker-2 의 Pod 로 넘겨 줍니다 (한 홉 더, 출발지는 worker-1 IP)." },
      { title: "Local 로 바꾸기", command: `kubectl patch svc who -p '{"spec":{"externalTrafficPolicy":"Local"}}'`, expect: "이제 들어온 노드의 Pod 로만 보내고 SNAT 하지 않습니다. MetalLB 는 Pod 가 있는 worker-2 만 IP 를 맡게 합니다." },
      { title: "다시 LoadBalancer 로", command: "curl http://192.168.0.240/", expect: "RemoteAddr 가 203.0.113.7 — 클라이언트 IP 가 보존됩니다." },
      { title: "Pod 없는 노드의 NodePort 로", command: "curl http://192.168.0.11:30080/", expect: "worker-1 에는 Pod 가 없어 버립니다 (시간 초과). 그래서 Local 은 앞단(LB)이 Pod 있는 노드로만 보내야 합니다.", expectFail: true },
    ],
  },
  {
    id: "tailscale",
    title: "내 구성: Tailscale Funnel → Ingress → Service",
    summary: "net-sim 배포(deploy/ 차트)와 같은 모양입니다. ingressClassName tailscale 이면 오퍼레이터가 프록시 Pod 를 tailnet 기기로 붙이고, funnel 이 공인 인터넷 요청을 그 기기로 넘깁니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      manifests: [
        deployment("net-sim", {
          replicas: 1,
          image: "ghcr.io/youseonghyeon/net-sim:latest",
          cpu: 10,
          memory: 16,
          port: 8080,
          readiness: { httpGet: { path: "/", port: 8080 }, periodSeconds: 10 },
          liveness: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10 },
        }),
        service("net-sim", { selector: { app: "net-sim" }, port: 8080 }),
        ingress("net-sim", { className: "tailscale", defaultBackend: { service: { name: "net-sim", port: { number: 8080 } } }, tls: ["net-sim"], annotations: { "tailscale.com/funnel": "true" } }),
      ],
    }),
    tries: [
      { title: "Ingress 주소", command: "kubectl get ingress", expect: "ADDRESS 가 IP 가 아니라 net-sim.<tailnet>.ts.net 입니다 (tailnet 이름은 가짜 — 계정마다 다름)." },
      { title: "프록시 Pod", command: "kubectl get pods -o wide", expect: "오퍼레이터가 만든 ts-net-sim-… Pod 가 보입니다 (실제는 tailscale 네임스페이스의 StatefulSet — 축소판)." },
      {
        title: "인터넷에서 접속",
        command: "curl https://net-sim.tailnet-1234.ts.net/",
        expect: "공인 DNS → Funnel 중계 서버 → WireGuard 로 프록시 Pod → TLS 종료 → Service ClusterIP → (그 노드의 kube-proxy 규칙) → net-sim Pod. NodePort·LoadBalancer 가 하나도 없습니다.",
      },
      { title: "Ingress 자세히", command: "kubectl describe ingress net-sim", expect: "Default backend 가 net-sim:8080, Annotations 에 tailscale.com/funnel: true." },
    ],
  },
  {
    id: "gitops",
    title: "GitOps: Argo CD 가 Git 을 맞추는 방식 (내 배포 파이프라인)",
    summary: "net-sim 의 실제 흐름입니다: CI 가 이미지 태그를 Git 에 커밋 → Argo CD 가 (3분 폴링으로) 알아채 자동 sync → 롤아웃. kubectl 로 손대면 selfHeal 이 되돌리고, Git 에서 지우면 prune 이 지웁니다.",
    build: () => ({
      nodes: [node("worker-1"), node("worker-2")],
      git: [
        {
          url: NET_SIM_REPO,
          message: "deploy: net-sim chart",
          files: {
            "deploy/deployment.yaml": deployment("net-sim", {
              replicas: 1,
              image: "ghcr.io/youseonghyeon/net-sim:bdfd45b",
              cpu: 10,
              memory: 16,
              port: 8080,
              readiness: { httpGet: { path: "/", port: 8080 }, periodSeconds: 10 },
              liveness: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 10 },
            }),
            "deploy/service.yaml": service("net-sim", { selector: { app: "net-sim" }, port: 8080 }),
            "deploy/ingress.yaml": ingress("net-sim", { className: "tailscale", defaultBackend: { service: { name: "net-sim", port: { number: 8080 } } }, tls: ["net-sim"], annotations: { "tailscale.com/funnel": "true" } }),
          },
        },
      ],
      manifests: [application("net-sim", { repoURL: NET_SIM_REPO, path: "deploy", automated: { prune: true, selfHeal: true } })],
    }),
    tries: [
      { title: "앱 상태", command: "argocd app get net-sim", expect: "Git(deploy/) 의 매니페스트 3개가 클러스터에 있고 Synced · Healthy 입니다. Sync Policy 는 net-sim 의 argocd/application.yaml 처럼 Automated (Prune) + selfHeal." },
      {
        title: "kubectl 로 손대기",
        command: "kubectl scale deployment/net-sim --replicas=3",
        expect: "곧 OutOfSync 가 되고, selfHeal 이 5초 뒤 Git 의 replicas 1 로 되돌립니다. 클러스터를 바꾸려면 Git 을 바꿔야 한다는 뜻입니다.",
      },
      {
        title: "CI: 새 이미지 → Git 커밋",
        action: { type: "ci-bump", repo: NET_SIM_REPO, file: "deploy/deployment.yaml" },
        expect: "github-actions 가 values.yaml 의 tag 를 바꿔 커밋한 것과 같습니다. 그런데 Argo CD 는 아직 옛 리비전을 봅니다 — 3분마다 Git 을 확인하기 때문 (GitOps 상자에 '아직 모름').",
      },
      {
        title: "기다리지 않고 Refresh",
        command: "argocd app get net-sim --refresh",
        expect: "새 리비전을 보자마자 OutOfSync → 자동 sync → 새 이미지로 롤링 업데이트. 30× 로 3분을 기다려 봐도 같습니다.",
      },
      {
        title: "Git 에서 ingress.yaml 지우기",
        action: { type: "git-rm", repo: NET_SIM_REPO, file: "deploy/ingress.yaml" },
        expect: "prune 이 켜져 있으니 다음 sync 때 Ingress(와 Tailscale 프록시)가 지워집니다.",
      },
      { title: "다시 Refresh", command: "argocd app get net-sim --refresh", expect: "새 리비전을 보고 자동 sync — prune 으로 Ingress 가 지워지고, 오퍼레이터가 만든 프록시는 ownerReferences 로 따라 지워집니다." },
      { title: "selfHeal 끄기", command: "argocd app set net-sim --self-heal=false", expect: "이제 kubectl 로 바꾼 것은 OutOfSync 로 남습니다 (자동 sync 는 새 커밋에만 돈다)." },
      { title: "다시 손대기", command: "kubectl scale deployment/net-sim --replicas=2", expect: "이번에는 되돌리지 않습니다." },
      { title: "무엇이 다른지", command: "argocd app diff net-sim", expect: "< 는 라이브, > 는 Git. 차이가 있어 실패(종료 코드 1)로 끝납니다.", expectFail: true },
      { title: "손으로 sync", command: "argocd app sync net-sim", expect: "Git 대로 되돌리고 Synced 가 됩니다." },
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


/**
 * 예제 메뉴 묶음. 위에서 아래, 왼쪽에서 오른쪽이 학습 순서(ROADMAP 단계 순)다.
 * 새 예제는 여기에도 넣는다 — 빠지거나 겹치면 tests/model.test.ts 가 잡는다.
 */
export const EXAMPLE_GROUPS: { label: string; ids: string[] }[] = [
  { label: "기본", ids: ["basics", "pending"] },
  { label: "Pod 고장", ids: ["crashloop", "imagepull"] },
  { label: "노드", ids: ["node-down", "nodes", "drain"] },
  { label: "Service", ids: ["service", "readiness"] },
  { label: "배포·헬스", ids: ["rolling", "rollout-stuck", "graceful", "liveness"] },
  { label: "바깥 트래픽", ids: ["ingress", "source-ip", "tailscale"] },
  { label: "GitOps", ids: ["gitops"] },
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
