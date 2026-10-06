# kube-sim 로드맵

기준: **새 학습 포인트**가 생기는 순서. 각 단계는 "배우는 것 → 만들 것 → 예제 → 완료 기준" 으로 적고, 단계를 시작할 때 범위를 사용자와 한 번 맞춘다(AGENTS.md "사용자와 일하는 방식").
단계가 끝나면 ✅ 와 날짜, 줄인 것(축소판)을 적는다.

## 정한 것 (2026-10-02, 사용자가 권장안 승인)
| 결정 | 선택지 | 권장 |
|---|---|---|
| 편집 방식 | ① 매니페스트(YAML) 편집 중심 ② 캔버스에서 리소스 끌어 놓기 ③ 혼합 | ③ 캔버스는 "노드 안의 Pod 배치·트래픽" 을 보여 주고, 리소스는 인스펙터 폼으로 고치며 "YAML 보기" 를 곁들인다 |
| kubectl 입력창 | 둘지 말지 | 둔다 (1단계부터 `get`·`describe`·`scale`·`delete`·`rollout`·`cordon`·`drain` 흉내). 실무 손버릇과 화면을 잇는 학습 효과가 크다 |
| 캔버스 표현 | 노드 = 큰 상자, Pod = 노드 안 칩, Service = 가상(점선) | 그려서 보여 주고 확인받음 (2026-10-02, DESIGN.md "캔버스") |
| 네트워크 깊이 | 요청 단위 / 패킷 단위 | 요청 단위로 시작 (ARCHITECTURE.md) |

## 0. 골격 ✅ 2026-10-02
- 결과: 캔버스(컨트롤 플레인 · 스케줄 대기 · 노드 안 Pod 칩), 인스펙터, 로그·kubectl 서랍, 예제 5개. 네 가지 검증 통과. 캔버스 표현은 이 결과물로 사용자 확인을 받았다(2026-10-02).
- 축소판: 자리 배치는 자동(끌어 놓지 않음), 되돌리기 없음, 네임스페이스는 default 하나.
- 배우는 것: (없음 — 토대)
- 만들 것
  - Vite + Preact + TypeScript + vitest + Playwright 프로젝트 (net-sim 의 `package.json`·`tsconfig`·`vite.config` 를 출발점으로), `npm run typecheck/test/ui-check/perf-check`
  - 코어: 시계·이벤트 큐(일반·배경 타이머, 취소 가능한 핸들), 트레이스, `runToIdle`·`runUntil`
  - 앱 틀: 상단바(재생·일시정지·속도·"+10초"·파일 메뉴), 캔버스, 인스펙터, 로그 서랍 — DESIGN.md 토큰
  - 최소 예제: 노드 2대 + Pod 하나가 Pending → Running 이 되는 것까지(스케줄러·kubelet 은 가장 단순하게)
- 완료 기준: 네 가지 검증 통과, 로그에 Pod 수명주기 트레이스가 보이고 스크린샷이 DESIGN.md 를 따른다. **사용자에게 화면을 보여 주고 방향을 확인받는다.**

## 1. 오브젝트와 컨트롤 루프 ✅ 2026-10-02
- 된 것 (2026-10-02): API 저장소·watch·resourceVersion·Conflict·GC, Deployment·ReplicaSet 컨트롤러, 스케줄러(requests·nodeSelector·taint·cordon, FailedScheduling), kubelet(pull·ErrImagePull/ImagePullBackOff·CrashLoopBackOff·SIGTERM 정리), pod-garbage-collector, kubectl 흉내(get·describe·create·scale·set image/resources·delete·cordon), 이벤트, 예제 5개
- 노드 장애 (2026-10-02): Lease heartbeat → 40초 → NotReady·unreachable taint → toleration 300초 → eviction → Terminating 에 멈춤, 다시 켜면 정리. 예제 "노드 하나 죽이기". `kubectl get leases -n kube-node-lease`
- 남은 것(작음): `kubectl get pods -w`
- 축소판: (1단계 당시 템플릿 변경은 Recreate 식 — 3단계에서 롤링 업데이트로 바뀜), 컨테이너는 Pod 마다 첫 번째만 돌림, ReplicaSet slow start·expectations 없음, 스케줄러 점수는 LeastAllocated 하나·preemption 없음
- 배우는 것
  - 선언과 reconcile: Pod 를 지워도 ReplicaSet 이 다시 만든다, replicas 를 바꾸면 무엇이 무엇을 만드는가(Deployment → ReplicaSet → Pod, ownerReferences)
  - 스케줄러: requests 로 자리를 찾고, 없으면 `FailedScheduling` (`0/3 nodes are available: 3 Insufficient cpu.`)
  - kubelet: 이미지 pull(ImagePullBackOff), 컨테이너 크래시와 CrashLoopBackOff 백오프(10s·20s·40s… 최대 300s)
  - 노드 장애: heartbeat 가 끊기면 NotReady → `node.kubernetes.io/unreachable` taint → toleration 300초 뒤 eviction → 다른 노드에 다시 (그래서 "5분" 이 걸린다)
- 만들 것: API 저장소 + watch + resourceVersion, Deployment·ReplicaSet 컨트롤러, 스케줄러(requests·nodeSelector), kubelet(Pod phase·컨테이너 상태·재시작 백오프), Node lifecycle 컨트롤러, kubectl 흉내(`get pods -w`, `describe`, `scale`, `delete`), 이벤트(`kubectl get events`)
- 예제: "Deployment 하나 (replicas 3)", "자리가 모자란 클러스터 (Pending)", "크래시하는 앱 (CrashLoopBackOff)", "노드 하나 죽이기"
- 완료 기준: 각 예제의 학습 포인트가 트레이스·kubectl 출력으로 재현되고 vitest 로 고정된다

## 2. Service 와 Pod 네트워킹 (대부분 됨 2026-10-02)
- 된 것: Service(ClusterIP·NodePort, API 서버가 주소 할당), EndpointSlice 컨트롤러(ready·terminating), 노드마다 kube-proxy(iptables 규칙 — `iptables-save` 모양, 확률 1/n), CoreDNS(search 도메인·ndots:5), 요청 흉내(`kubectl exec <pod> -- curl|ping|nslookup`, 바깥에서 NodePort), readiness probe(앱 준비 시간·"앱 고장"), 캔버스의 Service 상자·엔드포인트 선·요청 경로 점, 예제 "Service 로 나누기"·"readiness"
- 결정: 노드 간 Pod 트래픽은 flannel VXLAN(k3s 기본)으로 문구만 보여 준다(패킷 단위 캡슐화는 그리지 않음), kube-proxy 는 iptables 모드만, 요청은 시뮬레이션 시간을 쓰지 않는 즉시 계산(지연·재전송 없음)
- 남은 것: conntrack(같은 연결은 같은 대상) 표시, headless Service, `externalTrafficPolicy`(4단계로 넘김)
- 배우는 것
  - Pod IP 는 노드별 PodCIDR 에서, Pod 가 다시 생기면 IP 가 바뀐다 → 그래서 Service
  - ClusterIP 는 어디에도 없는 가상 주소: kube-proxy 가 각 노드에 깐 규칙(KUBE-SERVICES → KUBE-SVC-* → KUBE-SEP-*)으로 DNAT — 그래서 ping 은 안 되고 TCP 는 된다
  - readiness 실패 Pod 는 EndpointSlice 에서 빠져 트래픽을 받지 않는다 (Running ≠ Ready)
  - CoreDNS: `<svc>.<ns>.svc.cluster.local`, 같은 네임스페이스는 짧은 이름, search 도메인
  - 요청이 다른 노드의 Pod 로 갈 때의 경로(노드 간 라우팅 / 오버레이), NodePort 로 바깥에서 들어오기
- 만들 것: CNI(PodCIDR·IP 할당), Service·EndpointSlice 컨트롤러, kube-proxy 규칙(시드 고정 확률 분배), CoreDNS, "요청 보내기" 진단(경로를 단계별로 보여 줌), `iptables-save` 흉내 출력
- 예제: "Service 로 Pod 3개에 나누기", "readiness 가 실패하는 Pod 하나", "다른 노드의 Pod 로 가는 요청"

## 3. 배포 전략과 헬스 ✅ 2026-10-02
- 된 것: RollingUpdate(maxSurge·maxUnavailable, 기본 25%/25%)·Recreate, 리비전(`deployment.kubernetes.io/revision`)·revisionHistoryLimit, Progressing/Available 조건과 progressDeadlineSeconds, `kubectl rollout status|history|undo|restart`, liveness probe(죽이고 재시작), preStop sleep, SIGTERM 뒤 새 연결 거부 + kube-proxy 규칙 반영 1초 → Pod 삭제·롤아웃 중 요청 실패, 부하 발생기(0.1초마다 curl, 성공·실패 막대), PodDisruptionBudget·disruption 컨트롤러·Eviction API·`kubectl drain`(5초 재시도), 예제 5개(rolling·rollout-stuck·graceful·liveness·drain)
- 축소판: minReadySeconds·paused·비례 스케일링 없음, drain 은 10분 뒤 포기(실제는 무한 대기), DaemonSet 없음
- 배우는 것: rolling update(maxSurge·maxUnavailable)와 readiness 가 롤아웃을 멈추는 방식, `kubectl rollout undo`, liveness 실패 → 재시작, 종료 순서(EndpointSlice 에서 빠지는 것과 SIGTERM 의 경합 → 요청 실패, preStop 으로 해결), PodDisruptionBudget 과 `kubectl drain`
- 예제: "새 버전 롤아웃 (중간에 readiness 실패)", "graceful shutdown 없는 앱의 502", "drain 과 PDB"

## 4. 바깥에서 들어오는 트래픽 ✅ 2026-10-02
- 된 것: LoadBalancer Service(MetalLB L2 — 풀 192.168.0.240~250, 노드 하나가 ARP 로 맡음, 꺼지면 다른 노드가 이어받음), externalTrafficPolicy(Cluster: SNAT·아무 노드 / Local: 출발지 보존·Pod 없는 노드는 버림·Pod 있는 노드만 IP 를 맡음), Ingress(ingress-nginx: Host·경로 규칙, Pod 로 직접 프록시, 404/503 / Tailscale 오퍼레이터: 프록시 Pod·tailnet 이름·funnel), 출발지 IP·X-Forwarded-For 추적, `curl` 을 kubectl 창에 치면 클러스터 밖에서 보냄, `kubectl get/describe/create ingress`·`patch svc`, 예제 3개(ingress·source-ip·tailscale — 사용자의 net-sim 배포 모양)
- 축소판: MetalLB·Tailscale 오퍼레이터는 Pod 없는 부가 기능(speaker 는 노드 전원으로 산다고 봄, 장애 감지 즉시), 프록시는 StatefulSet 대신 Deployment, 바깥 DNS 는 Ingress 규칙의 host 가 ADDRESS 로 등록됐다고 가정, TLS 는 단계 문구로만, tailnet 이름은 가짜
- 배우는 것: Ingress(호스트·경로 규칙, nginx 식), LoadBalancer Service(MetalLB 식 L2), `externalTrafficPolicy: Local` vs `Cluster`(출발지 IP 보존·추가 홉·노드에 Pod 가 없을 때)
- 예제: "도메인 둘을 Ingress 하나로", "출발지 IP 가 사라지는 이유"
- 메모: 사용자의 실제 구성(Tailscale funnel → Ingress → Service)을 예제로 만들 수 있다

## 5. 운영 (후보 — 시작할 때 고른다)
- 후보: requests/limits 와 OOMKilled·CPU throttling(5a 로 시작), HPA(메트릭 흉내로 replicas 조정), NetworkPolicy(기본 허용 → 정책이 하나라도 걸리면 기본 차단), ConfigMap/Secret 변경과 재시작, StatefulSet + PVC(순서·고정 이름·고정 볼륨)

### 5a. requests/limits · OOMKilled · CPU throttling ✅ 2026-10-06 (사용자 선택)
- 된 것: `resources.limits`(requests > limits 거절, limits 만 적으면 requests = limits), QoS 클래스, 이미지별 메모리(램프·누수)·CPU(수요·요청당 일) 모양, cgroup OOM·노드 OOM(oom_score·SystemOOM 이벤트), CPU 나눠 받기(requests 비율)·throttling → 응답 시간·probe timeout, `kubectl top pods|nodes`·`set resources --limits`·describe 의 Limits/QoS/OOMKilled·describe node 의 Limits·overcommit, 인스펙터(limits 편집·Pod 자원 막대·OOMKilled 이유), 노드 칸의 요청·사용, Pod 칩 배지(mem %·throttled), 예제 묶음 "자원" 3개
- 축소판: node-pressure eviction·시스템 예약·페이지 캐시 없음, CPU 는 CFS 주기 없이 비율로만, 요청 수가 CPU 사용을 늘리지 않음, metrics-server 지연 없음 (ARCHITECTURE 5-1)
- 왜: 사용자의 차트(`deploy/values.yaml`)에 `limits.memory: 64Mi` 가 실제로 있다. "왜 재시작됐지(OOMKilled · exit 137)", "왜 느리지(throttling)", "노드가 꽉 찼는데 왜 스케줄은 되지(requests ≠ 실사용)" 를 추측하지 않고 보게 한다.
- 배우는 것
  - requests 는 스케줄러가 보는 **예약**, limits 는 커널(cgroup)이 거는 **상한**. 실사용(`kubectl top`)은 둘과 따로 움직인다
  - memory limit 을 넘으면 cgroup OOM killer 가 컨테이너를 죽인다 → `OOMKilled` · exit 137 → 재시작 → 되풀이되면 CrashLoopBackOff (describe 의 Last State)
  - cpu limit 은 죽이지 않는다 — CFS 쿼터로 **느려질 뿐**(throttling). 너무 낮으면 probe 가 시간 초과로 실패해 liveness 가 재시작시킨다
  - limits 가 없으면 노드 메모리가 넘칠 수 있다(overcommit) → 노드 OOM killer 가 oom_score(QoS·requests 대비 사용량)로 **다른 Pod** 를 고를 수 있다. 노드 CPU 가 모자라면 requests 비율로 나눠 받는다
  - QoS 클래스(Guaranteed · Burstable · BestEffort)가 어떻게 정해지고 무엇을 바꾸나. limits < requests 는 API 가 거절
- 만들 것: `resources.limits`(검증 포함), 이미지별 메모리·CPU 사용 모양(시작 램프·누수·CPU 수요), kubelet 의 cgroup OOM·노드 OOM(oom_score)·CPU 분배와 throttling, 응답 시간·probe timeout, `kubectl top pods|nodes`, `kubectl set resources --limits`, describe 의 Limits·QoS·OOMKilled, 인스펙터(limits 편집, Pod 실사용 막대), 노드 칸의 실사용 표시, 예제 묶음 "자원"
- 예제: "메모리 limit 을 넘으면 (OOMKilled)", "limits 없는 메모리 누수와 이웃 Pod (노드 OOM)", "CPU limit 은 느리게 할 뿐 (throttling)"
- 완료 기준: 예제마다 "해 볼 것" 이 위 학습 포인트를 화면·kubectl 출력으로 보여 주고, 코어 동작이 트레이스 테스트로 고정된다. 네 가지 검증 통과

## 6. GitOps (ArgoCD 식) ✅ 2026-10-02
- 된 것: Git 저장소(커밋 이력, 경로별 매니페스트), Argo CD application-controller(3분 폴링·Refresh, Git 에 적은 필드 기준 비교 → Synced/OutOfSync, 리소스 Health, 자동 sync 는 새 리비전마다 한 번, selfHeal 5초, prune, 이력), `argocd app list/get/diff/sync/history/set`·`git log` 흉내, `kubectl get applications -n argocd`, 캔버스 GitOps 칸(Git → Application, '아직 모름' 표시·폴링 카운트다운), Application 인스펙터(정책 토글·리소스·차이), Git 인스펙터(작업 사본 편집 → 커밋), 예제 '내 배포 파이프라인'(CI 태그 커밋 → 폴링 → 자동 sync → 롤아웃)
- 축소판: Argo CD 는 Pod 없는 부가 기능, Helm 렌더링 결과를 Git 에 있다고 봄, 대상 네임스페이스 default, sync 즉시 완료, 훅·sync wave·finalizer·webhook 없음
- 배우는 것: Git(원하는 매니페스트) vs 라이브 비교 → Synced/OutOfSync, 수동·자동 sync, self-heal(누가 kubectl 로 고친 것을 되돌림), prune(Git 에서 지운 리소스 삭제), 이미지 태그 봇 커밋 → sync 흐름(사용자의 net-sim 배포 파이프라인과 같은 모양)
- 예제: "kubectl edit 로 replicas 를 바꾸면 ArgoCD 가 되돌린다", "values.yaml 태그 하나 바꾸기 = 롤아웃"

## 나중 / 하지 않기로 한 것
- 실제 클러스터 연결은 하지 않는다 (net-sim 과 같은 결정 — 학습·결정론 우선)
- 컨트롤 플레인 고가용성(etcd Raft)은 별도 주제로 남겨 둔다
