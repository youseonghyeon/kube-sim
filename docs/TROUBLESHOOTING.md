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

## 화면

| 증상 | 원인 | 고치는 법 |
|---|---|---|
| 상단 시계가 멈춤 | 남은 할 일이 없음 (정상) — 시계는 일이 있을 때만 흐른다 | 무언가를 바꾸면 다시 흐른다 |
| "이벤트가 폭주해 일시정지했습니다" | 한 프레임에 이벤트 4000개 초과 — 컨트롤러가 서로를 계속 고치는 구성 | 로그에서 같은 줄이 되풀이되는 컴포넌트를 찾는다 (`src/model/simClock.ts`) |
