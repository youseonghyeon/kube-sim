# 문제 해결 — 화면·로그에 보이는 실패 문구

사용자가 보는 실패 문구 → 원인 → 고치는 법. 새 실패 문구를 코드에 넣으면 여기도 같이 갱신한다(문구는 실제 kubectl 출력과 같게).
기능이 생기는 대로 단계별 절로 나눈다. 

## 스케줄링·Pod 수명주기 (1단계)

| 증상 / 로그 문구 | 원인 | 고치는 법 |
|---|---|---|
| Pod 가 `Pending`, 이벤트 `FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu.` | requests 를 채울 자리가 있는 노드가 없음 | requests 를 줄이거나 노드를 늘리거나 다른 Pod 를 줄인다 |
| `ImagePullBackOff` / `ErrImagePull` | 이미지 이름·태그가 틀렸거나 레지스트리에 없음 | 이미지 이름·태그를 고친다 (kubelet 은 백오프하며 다시 시도) |
| `CrashLoopBackOff`, 이벤트 `Back-off restarting failed container` | 컨테이너가 시작 직후 계속 종료됨 — 재시작 간격이 10초부터 두 배씩(최대 5분) 늘어난다 | 앱의 시작 실패 원인을 고친다. 고친 뒤에도 남은 백오프 시간만큼 기다린다 |
| 노드를 끊었는데 Pod 가 5분 동안 그대로 `Running` 으로 보임 | Lease 가 40초 넘게 끊겨야 NotReady·taint, 그 뒤 Pod 의 기본 toleration(300초)이 끝나야 eviction 된다 | 정상. 빨리 옮기려면 Pod 의 `tolerationSeconds` 를 줄이거나, 미리 아는 작업이면 `kubectl drain` |
| 노드가 꺼진 뒤 Pod 가 `Terminating` 에서 안 사라짐 | 컨테이너를 멈추고 확인해 줄 kubelet 이 없다. 새 Pod 는 이미 다른 노드에 생겼다 | 노드를 다시 켜면 kubelet 이 정리한다. 노드가 영영 안 돌아오면 Node 를 지운다(pod-garbage-collector 가 강제 삭제) |
| `node(s) had untolerated taint {node.kubernetes.io/unreachable: }` | 응답 없는 노드에는 새 Pod 를 두지 않는다 (NoSchedule) | 노드가 돌아오면 taint 가 빠진다 |
| `0/3 nodes are available: 3 node(s) were unschedulable.` | 모든 노드가 cordon 됨 | `kubectl uncordon <노드>` |
| Pod 가 지운 뒤에도 잠깐 `Terminating` | 노드에 있는 Pod 는 kubelet 이 SIGTERM 을 보내고 컨테이너가 끝난 뒤에야 사라진다 (유예 30초) | 정상. 기다리지 않으려면 `--force --grace-period=0` (컨테이너가 계속 돌 수 있어 실무에선 조심) |
| 인스펙터에 "라이브가 매니페스트와 다릅니다" | kubectl 로 replicas·이미지를 바꿔 매니페스트(왼쪽·설정 탭)와 달라짐 | "매니페스트 다시 적용" 또는 그대로 두기 |

## Service·네트워크 (2단계)

| 증상 / 출력 | 원인 | 고치는 법 |
|---|---|---|
| `curl: (6) Could not resolve host: wbe` | 그런 Service 가 없다 (search 도메인을 다 붙여 봐도 NXDOMAIN) | Service 이름·네임스페이스를 확인 (`kubectl get svc`) |
| ClusterIP 로 `ping` 이 100% packet loss | ClusterIP 는 어떤 장치에도 없는 가상 주소이고 kube-proxy 규칙은 TCP 포트에만 있다 | 정상. TCP 로 접속해 확인 (`curl`) |
| `curl: (7) … Couldn't connect to server` (Service 로) | ready 인 엔드포인트가 없어 REJECT, 또는 targetPort 가 앱 포트와 다름 | `kubectl get endpoints <svc>`, Service 의 targetPort 와 컨테이너 포트 비교 |
| `curl: (28) … Connection timed out` | Service 에 없는 포트로 보냄, 또는 꺼진 노드의 Pod 로 DNAT 됨(NotReady 전까지 엔드포인트가 남음) | 포트 확인. 노드 장애면 40초 뒤 엔드포인트에서 빠진다 |
| Pod 가 `0/1 Running` 이고 트래픽을 안 받음 | readiness probe 가 아직(또는 계속) 실패 — `Readiness probe failed: HTTP probe failed with statuscode: 503` | 앱 준비 시간·상태 확인. Running ≠ Ready |

## 배포·종료 (3단계)

| 증상 / 출력 | 원인 | 고치는 법 |
|---|---|---|
| `Waiting for deployment "api" rollout to finish: 2 out of 4 new replicas have been updated...` 에서 멈춤 | 새 Pod 가 Ready 가 안 돼 옛 Pod 를 더 줄일 수 없음 (maxUnavailable) | 새 Pod 의 readiness 이벤트를 본다. 고치거나 `kubectl rollout undo` |
| `error: deployment "api" exceeded its progress deadline` | progressDeadlineSeconds(600초) 동안 진전 없음 — 알림일 뿐 되돌리지 않음 | `kubectl rollout undo` |
| Pod 를 지우거나 롤아웃할 때 요청 일부가 연결 거부 | SIGTERM 으로 앱이 먼저 멈추고, 모든 노드의 규칙에서 빠지기까지 틈이 있음 | `lifecycle.preStop` 에 sleep 몇 초 |
| `Container api failed liveness probe, will be restarted` · RESTARTS 증가 | liveness probe 연속 실패 | 앱이 정말 멈췄는지, 아니면 probe 포트·경로가 틀렸는지 (틀리면 계속 재시작 → CrashLoopBackOff) |
| `error when evicting pods/"web-…" -n "default" (will retry after 5s): Cannot evict pod as it would violate the pod's disruption budget.` | PDB 의 허용 수가 0 — 대체 Pod 가 Ready 가 될 때까지 기다리는 중 | 정상. 끝나지 않으면 minAvailable 이 replicas 와 같은지 확인 (`kubectl get pdb`) |

## 바깥에서 들어오기 (4단계)

| 증상 / 출력 | 원인 | 고치는 법 |
|---|---|---|
| `EXTERNAL-IP <pending>` | MetalLB 주소 풀이 다 찼음 (192.168.0.240~250) | 안 쓰는 LoadBalancer Service 를 지우거나 ClusterIP 로 |
| 앱 로그의 클라이언트 IP 가 노드 IP | externalTrafficPolicy: Cluster 의 SNAT | `kubectl patch svc … -p '{"spec":{"externalTrafficPolicy":"Local"}}'` (Ingress 컨트롤러의 Service 에) |
| Local 로 바꾼 뒤 어떤 노드의 NodePort 로는 시간 초과 | 그 노드에 Pod 가 없으면 Local 은 버린다 | 앞단(LB)이 Pod 있는 노드로만 보내게 — MetalLB 는 자동으로 그렇게 한다 |
| `kubectl get ingress` 의 ADDRESS 가 비어 있음 (nginx 클래스) | 그 class 를 처리할 컨트롤러(ingress-nginx)가 없다 — Ingress 는 규칙일 뿐 | ingress-nginx 설치 (인스펙터의 "ingress-nginx 설치" = 컨트롤러 Deployment + LoadBalancer Service) 또는 tailscale 클래스 |
| 막 만든 LoadBalancer IP 로 curl 이 `Couldn't connect` ("규칙을 쓰기 전") | kube-proxy 가 노드에 규칙을 쓰기 전 (반영 1초) | 잠깐 뒤 다시 |
| ingress-nginx 의 `404 Not Found` | Host·경로에 맞는 Ingress 규칙이 없음 (IP 로 접속하면 Host 가 IP) | 도메인으로 접속하거나 규칙·defaultBackend 추가 |
| ingress-nginx 의 `503 Service Temporarily Unavailable` | 규칙의 Service 에 ready 엔드포인트가 없음 | `kubectl get endpoints <svc>` |
| `*.ts.net` 이 공인 인터넷에서 `Could not resolve host` | Ingress 에 `tailscale.com/funnel: "true"` 가 없음 (tailnet 안에서만) | annotation 추가 (tailnet 정책에 funnel 허용도 필요) |

## 자원 (5a)

| 증상 / 출력 | 원인 | 고치는 법 |
|---|---|---|
| `Last State: Terminated · Reason: OOMKilled · Exit Code: 137` | 메모리 사용이 limits.memory 에 닿아 커널(cgroup)이 죽임 | limit 올리기(`kubectl set resources ... --limits=memory=512Mi`) 또는 앱 메모리(힙·누수) 줄이기 |
| limits 를 안 걸었는데 OOMKilled, 노드에 `SystemOOM` 이벤트 | 노드 메모리가 넘쳐 노드 OOM killer 가 oom_score 로 골랐다 (이웃의 누수일 수 있음) | `kubectl top pods` 로 많이 쓰는 Pod 를 찾아 limits 를 건다. 중요한 Pod 는 requests 를 실사용만큼(또는 Guaranteed) |
| 죽지는 않는데 응답이 느림, `kubectl top` 의 CPU 가 limit 과 같음 | CPU throttling — limits.cpu 가 천장 | limits.cpu 를 올리거나 없앤다 (requests 는 그대로 두어도 됨) |
| `Liveness probe failed: ... context deadline exceeded (Client.Timeout exceeded while awaiting headers)` 뒤 재시작 반복 | CPU 를 너무 적게 받아 probe 응답이 timeoutSeconds(기본 1초)를 넘음. 재시작해도 낫지 않는다 | CPU limit 을 올리거나 probe 의 timeoutSeconds 를 늘린다 |
| `Invalid value: "250m": must be less than or equal to cpu limit of 100m` | requests 가 limits 보다 큼 | `--requests` 와 `--limits` 를 함께 바꾼다 |
| 노드 메모리가 꽉 찼는데 새 Pod 가 계속 스케줄됨 | 스케줄러는 requests 합만 본다 (실사용은 안 봄) | requests 를 실사용에 맞춘다. `kubectl describe node` 의 Allocated resources 와 `kubectl top nodes` 를 비교 |
| `error: Metrics not available for pod` | 컨테이너가 돌고 있지 않음 (크래시 백오프 중 등) | 컨테이너가 뜬 뒤 다시 |

## 설정 (5b)

| 증상 / 출력 | 원인 | 고치는 법 |
|---|---|---|
| ConfigMap 을 바꿨는데(Argo CD 도 Synced) 앱이 옛 값 | env 는 컨테이너가 시작할 때 한 번 읽는다. 템플릿이 그대로라 롤아웃도 없다 | `kubectl rollout restart deployment/<이름>`, 또는 차트에 `checksum/config` 주석 |
| 마운트한 파일은 바뀌었는데 앱이 그대로 | 앱이 시작할 때만 파일을 읽는다 | 앱이 파일을 다시 읽게(감시·SIGHUP) 하거나 재시작 |
| 마운트한 파일이 영영 안 바뀜 | `subPath` 마운트는 갱신되지 않는다 | 디렉터리째 마운트하거나 재시작 |
| `CreateContainerConfigError` · `configmap "x" not found` / `couldn't find key K in ConfigMap default/x` | env 가 가리키는 ConfigMap·Secret·키가 없다 | 만들면 kubelet 이 10초 안에 다시 시도한다 (이름·키 오타 확인) |
| `ContainerCreating` 에서 멈춤 · `FailedMount … secret "x" not found` | volume 이 가리키는 Secret·ConfigMap 이 없다 (이미지 pull 도 안 한다) | 만들면 다음 재시도(최대 2분 간격) 때 뜬다 |
| `illegal base64 data` | Secret 의 data 에 평문을 넣었다 | 평문은 `stringData` 로, data 는 base64 로 |

## GitOps (6단계)

| 증상 / 출력 | 원인 | 고치는 법 |
|---|---|---|
| Git 에 push 했는데 Argo CD 가 그대로 (Synced to 옛 리비전) | Argo CD 는 Git 을 3분마다 확인한다 | `argocd app get <앱> --refresh` 또는 GitHub webhook |
| kubectl 로 바꾼 것이 몇 초 뒤 되돌아감 | selfHeal 이 켜져 있다 — Git 이 원하는 상태 | Git 을 바꾼다 (또는 selfHeal 끄기) |
| `OutOfSync` 인데 자동 sync 가 안 됨 | 자동 sync 는 새 리비전에만 돈다. 드리프트는 selfHeal 이 꺼져 있으면 그대로 | `argocd app sync <앱>` 또는 selfHeal 켜기 |
| Git 에서 지운 리소스가 남아 있음 (`ignored (requires pruning)`) | prune 이 꺼져 있다 | `argocd app sync <앱> --prune` 또는 `--auto-prune` |

## 화면

| 증상 | 원인 | 고치는 법 |
|---|---|---|
| 상단 시계가 멈춤 | 남은 할 일이 없음 (정상) — 시계는 일이 있을 때만 흐른다 | 무언가를 바꾸면 다시 흐른다 |
| "이벤트가 폭주해 일시정지했습니다" | 한 프레임에 이벤트 4000개 초과 — 컨트롤러가 서로를 계속 고치는 구성 | 로그에서 같은 줄이 되풀이되는 컴포넌트를 찾는다 (`src/model/simClock.ts`) |
