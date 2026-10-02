# kube-sim 코어 설계

0·1단계를 만들며 고친 설계다. 바뀌면 이 문서를 먼저 고친다. "열린 결정" 은 그 단계를 시작할 때 정한다.

## 1. 시계와 이벤트 큐
- 이벤트 = `{ at(ms), seq, actor, run() }`. `at` 다음 `seq`(넣은 순서) 로 정렬 → 결정론.
- 일반 타이머: 시계를 그 시각으로 점프시킬 수 있다. 끝이 있는 기다림(이미지 pull 3초, 재시작 백오프)에 쓴다. 핸들로 취소한다 — 끝난 일의 타이머가 남으면 시계가 엉뚱하게 뛴다(net-sim LESSONS 1).
- 배경 타이머: 그 자체로는 시계를 움직이지 않고, 다른 일로 시간이 그 시각을 지날 때만 발화한다. 끝나지 않는 주기 동작(probe 주기, 노드 heartbeat, 컨트롤러 resync)은 반드시 이것으로. 일반 이벤트가 없으면 `runToIdle` 은 멈춘다.
- `runToIdle(maxEvents)`, `runUntil(t)`, `step()`.
- **화면 시계 (결정 2026-10-02, 같은 날 고침)**: 타이머(일반 또는 배경)가 하나라도 걸려 있으면 재생 속도(1× = 실제 시간)로 흐르고, 하나도 없으면 멈춘다. 노드가 있으면 kubelet heartbeat(배경)가 늘 있으므로 실제 클러스터처럼 시간이 계속 흐른다 — 노드 장애의 40초·300초가 저절로 지나가야 해서다(처음 안은 "일반 이벤트가 있을 때만" 이었는데, 그러면 노드를 끈 뒤 아무 일도 일어나지 않는다). net-sim 처럼 다음 이벤트로 **점프하지 않는다** — 기다림 자체가 배울 거리. 긴 기다림은 속도(최대 30×)와 "+10초"·"+1분". 테스트의 `runToIdle` 은 여전히 일반 이벤트만 본다(배경은 끝이 없으므로). (`src/model/simClock.ts`)
- **끝없는 일반 타이머 사슬 (결정)**: 크래시·이미지 pull 재시도는 실제 kubelet 처럼 영원히 계속된다. 간격이 10초부터 최대 300초라 폭주하지 않으므로 배경 타이머가 아니라 일반 타이머로 둔다(배경이면 화면 시계가 멈춰 재시작이 안 보인다). 대신 크래시 루프가 있는 구성에서는 `runToIdle` 이 끝나지 않는다 → 테스트는 `runFor(ms)` 를 쓴다.
- 같은 순간의 여러 변화(노드를 지워 Pod 여럿이 동시에 사라짐)를 보고 판단해야 하는 곳은 0ms 타이머로 미뤄 모두 본 뒤 정한다(net-sim LESSONS 4v).

## 2. API 서버 흉내
- 오브젝트 = `{ apiVersion, kind, metadata: { namespace, name, uid, resourceVersion, generation, labels, ownerReferences, deletionTimestamp }, spec, status }`. 필요한 필드만 둔다(학습에 쓰이는 것만).
- 저장소: `Map<"kind/ns/name", Obj>`, 전역 `resourceVersion` 카운터. 쓰기마다 +1. `spec` 이 바뀌면 `generation` +1.
- watch: 구독자에게 `ADDED/MODIFIED/DELETED` 를 **이벤트 큐로** 전달한다. 지연은 **100ms (결정 — 학습용, 실제는 수 ms)**: 1× 화면에서 "쓰기 → 다른 컴포넌트가 알아챔" 의 순서가 보이게. 콜백을 즉시 동기 호출하지 않는다(재진입 사고 방지 — net-sim LESSONS 4h·4k).
- 내용이 같은 update 는 쓰지 않는다(resourceVersion·watch 없음) — 상태 갱신이 서로를 끝없이 깨우지 않게.
- 컨트롤러는 informer 캐시 대신 API 를 직접 읽는다(축소판 — 캐시 지연·expectations 를 흉내 내지 않음).
- 낙관적 동시성: `update` 는 받은 `resourceVersion` 이 현재와 다르면 `Conflict` → 컨트롤러가 다시 읽고 재시도.
- 삭제: 노드에 올라간 Pod 는 `deletionTimestamp`(Terminating) → kubelet 이 SIGTERM·정리 후 최종 삭제. 나머지는 바로 삭제. ownerReference 가비지 컬렉션은 **background (결정)** — 주인이 사라진 뒤 watch 지연만큼 뒤에 종속물을 지운다. finalizer 는 나중.

## 3. 컨트롤러
- 공통 틀: watch → 워크큐(같은 키는 합침) → `reconcile(key)` → 실패면 지수 백오프 재큐잉(배경이 아니라 일반 타이머 — 끝이 있다). 주기 resync 는 배경 타이머.
- Deployment: 템플릿 해시로 ReplicaSet 을 만들고 replicas 를 옮긴다(롤링 업데이트는 3단계).
- ReplicaSet: 원하는 수 vs 셀렉터에 맞는 살아 있는 Pod 수 → 생성/삭제(삭제 순서: Pending → NotReady → 최근 생성).
- EndpointSlice: Service 셀렉터 + Pod Ready 조건 → 엔드포인트 목록(2단계).
- Node lifecycle: heartbeat(Lease) 끊김 → NotReady → taint → toleration 만료 Pod eviction.
- 트레이스 actor 이름은 실제 컴포넌트 이름: `kube-scheduler`, `replicaset-controller`, `deployment-controller`, `kubelet@node-1`, `kube-proxy@node-2`, `coredns`.

## 3-2. 배포·종료 (3단계)
- Deployment 컨트롤러 (`controllers/deployment.ts`): 새 RS = 지금 템플릿 해시의 RS. RollingUpdate 는 실제 알고리즘의 축소판 — 새 RS 는 전체(spec.replicas 합)가 replicas+maxSurge 를 넘지 않게 늘리고, 옛 RS 는 "전체 − minAvailable − 새 RS 의 unavailable" 과 "available − minAvailable" 중 작은 만큼 줄인다(옛 RS 의 안 뜬 Pod 부터). 그래서 새 Pod 가 Ready 가 안 되면 멈춘다. Recreate 는 옛 Pod 가 모두 사라진 뒤 새 RS 를 늘린다(Pod 삭제를 watch). 옛 템플릿으로 돌아오면(undo) 그 RS 의 리비전을 맨 위로. 진전 마감은 일반 타이머(끝나면 취소).
- 종료 순서: Pod 삭제 → (watch) kubelet 이 preStop → SIGTERM(앱은 새 연결을 받지 않고 termMs 뒤 종료) → 정리, 동시에 EndpointSlice 갱신 → kube-proxy 가 **1초(RULE_SYNC_MS, 학습용)** 뒤 규칙 반영. 이 틈에 그 Pod 로 DNAT 된 요청은 연결 거부. preStop sleep 이 이 틈을 메운다.
- liveness: 배경 타이머 주기. failureThreshold 연속 실패면 crash 와 같은 길(재시작 백오프 포함). "앱 고장" 은 프로세스 상태라 재시작하면 풀린다.
- 부하 발생기 (`net/traffic.ts`): 배경 타이머로 요청을 계속 계산, 실패만 트레이스에 남김.
- PDB·drain: disruption 컨트롤러가 disruptionsAllowed 를 계산, `api.evict` 가 이를 보고 429(TooManyRequests) 또는 허용(허용 수를 줄이고 삭제). `DrainJob` 이 cordon → evict → 5초 재시도 → Pod 가 사라지면 "evicted" → "drained". 출력 줄이 시간이 지나며 늘어난다.

## 6-1. 바깥에서 들어오는 길 (4단계, `net/ingress.ts`·`net/request.ts`)
- LoadBalancer = NodePort + MetalLB 가 준 IP. speaker 는 노드 전원으로 살고(축소판), 후보 노드 중 해시 순서로 하나가 맡는다(맡던 노드가 계속 자격이 있으면 유지). Local 이면 Ready Pod 가 있는 노드만 후보.
- kube-proxy: 바깥(LB IP·NodePort) → KUBE-EXT. Cluster 면 KUBE-MARK-MASQ(SNAT) 후 모든 엔드포인트, Local 이면 KUBE-SVL(이 노드의 엔드포인트만, 없으면 DROP).
- 요청은 `Source.ip`(받는 쪽이 볼 출발지)와 `xff` 를 들고 다닌다. SNAT 에서 노드 IP 로, 프록시(ingress-nginx·Tailscale)는 새 연결이라 자기 Pod IP 가 되고 원래 출발지를 X-Forwarded-For 에 붙인다. 앱 응답에 "앱이 본 출발지" 를 함께 보여 준다.
- ingress-nginx 는 Ingress 규칙(Host 일치 → Exact → 가장 긴 Prefix → defaultBackend)으로 Service 의 ready 엔드포인트를 골라 Pod 로 직접 보낸다(ClusterIP 를 거치지 않음). Tailscale 프록시는 backend Service 의 ClusterIP 로 보낸다(프록시 노드의 kube-proxy 규칙을 탐).
- 바깥 DNS: Ingress 규칙의 host 는 그 Ingress 의 ADDRESS 로 풀린다고 가정. `*.ts.net` 은 funnel 이 켜진 tailscale Ingress 만 공인 인터넷에서 풀린다(funnel 은 443·8443·10000 만).
- ingress-nginx 는 Host 마다 server 블록: Host 가 맞는 규칙들 안에서만 경로를 고르고, 없으면 그 Ingress 의 defaultBackend, 그것도 없으면 404. Pod 에서 LoadBalancer IP 로 보낸 것은 KUBE-EXT 의 "pod traffic" 규칙으로 Local 과 상관없이 모든 엔드포인트로.
- 축소판: Cluster 정책의 SNAT 출발지를 노드 InternalIP 로 보여 준다. 실제(k3s flannel VXLAN)에서는 MASQUERADE 가 나가는 인터페이스 주소를 써서 flannel.1·cni0 주소(10.42.x.0 대)로 보일 수 있다(확인 안 함 — 추정).

## 7-1. GitOps (6단계, `gitops/`)
- Git 은 클러스터 밖의 사실이라 API 오브젝트가 아니다 (`Cluster.git`). 커밋 = 파일 전체 스냅샷, SHA 는 내용으로 정해짐(결정론).
- Argo CD 는 Application 마다 "가져온 리비전" 을 따로 기억한다 → Git 에 push 해도 다음 폴링(배경 타이머 3분)이나 Refresh 전에는 모른다. 라이브는 watch 로 바로 본다.
- 비교: Git 매니페스트에 적힌 필드만 라이브와 비교(기본값으로 채워진 필드 무시), 추적 표(`app.kubernetes.io/instance`)가 붙었는데 Git 에 없는 것은 prune 대상.
- 자동 sync 는 "마지막 sync 리비전 ≠ 지금 리비전" 일 때만. 같은 리비전의 드리프트는 selfHeal 이면 5초 뒤(일반 타이머 — 한 번) sync. Application 은 argocd 네임스페이스.

## 3-1. 노드 장애 (1단계, `controllers/nodelifecycle.ts`)
- kubelet 은 `kube-node-lease` 의 Lease 를 10초마다 갱신(배경 타이머). Lease 는 Node 가 주인 → Node 를 지우면 GC.
- node-lifecycle-controller: 5초마다(배경) Lease 를 보고 40초 넘게 갱신이 없으면 Ready=Unknown(`NodeStatusUnknown`), taint `node.kubernetes.io/unreachable` NoSchedule·NoExecute(timeAdded), 그 노드 Pod 의 Ready=False. 다시 갱신되고 kubelet 이 Ready 를 보고하면 taint 제거.
- API 서버는 Pod 를 만들 때 기본 toleration(not-ready·unreachable NoExecute 300초)을 붙인다(DefaultTolerationSeconds).
- taint-eviction-controller: NoExecute taint 의 timeAdded + tolerationSeconds 에 Pod 삭제를 예약(일반 타이머 — taint 가 빠지면 취소). kubelet 이 없으니 Pod 는 Terminating 에 멈춘다(실제와 같음). 노드가 돌아오면 kubelet 이 정리, Node 를 지우면 pod-garbage-collector 가 강제 삭제.
- 노드 "끄기" 는 API 에 없는 사실이라 `Cluster.setNodePower` 로만 바꾸고 화면은 `nodePowered` 로 안다. 켜면 kubelet 이 바인딩된 Pod 를 다시 읽어 맞춘다(지워지던 것 정리, 나머지는 새 샌드박스·새 IP·재시작 +1).
- 축소판: zone 별 eviction 속도 제한·대규모 장애 보호 없음, NodeStatus 주기 보고 없음(Lease 만), not-ready(kubelet 은 살았는데 런타임 고장) 경우 없음.

## 4. 스케줄러
- 바인딩 안 된 Pod 를 큐에 → 필터(Ready 노드, requests 가 남은 자리에 맞음, nodeSelector, taint/toleration) → 점수(남은 자원 균형 등 단순 규칙, 동점은 노드 이름 순 — 결정론) → `spec.nodeName` 바인딩.
- 실패하면 `FailedScheduling` 이벤트에 노드별 이유를 실제 문구로 모은다. 클러스터가 바뀌면(노드 추가·Pod 삭제) 다시 시도.

## 5. kubelet
- 자기 노드에 바인딩된 Pod 를 watch → 샌드박스·IP(CNI) → 이미지 pull(이미지별 고정 시간, 노드에 있으면 생략) → 컨테이너 시작 → 앱 흉내(`workloads.ts`)의 시작 시간 뒤 Running.
- probe: startup → liveness/readiness 주기(배경 타이머). readiness 결과는 Pod `Ready` 조건으로.
- 재시작: `restartPolicy`, 크래시마다 백오프 10s 두 배 최대 300s(성공적으로 10분 돌면 초기화) → `CrashLoopBackOff` 표시.
- 종료: `deletionTimestamp` → preStop → SIGTERM → grace period → SIGKILL(3단계).
- 노드 status·heartbeat 를 API 에 올린다(배경 타이머).

## 6. 네트워크 — 요청 단위 (2단계, `src/core/net/`·`controllers/endpointslice.ts`)
- 만든 것: ClusterIP 는 API 서버가 10.96.0.0/12 에서(10.96.0.1·.10 예약), NodePort 는 30000-32767 에서 정한다. EndpointSlice 는 Service 하나에 하나(축소판). kube-proxy 는 노드마다 Service·EndpointSlice 를 watch 해 그 노드의 규칙을 다시 쓰고(변화를 0ms 로 모아서), 요청은 **출발 노드의 규칙**으로 DNAT 된다 — 꺼진 노드의 규칙은 멈춰 있고, NotReady 전까지 엔드포인트가 남아 요청 일부가 시간 초과되는 것도 그대로 보인다.
- 요청 흉내는 시뮬레이션 시간을 쓰지 않고 지금 상태로 한 번에 계산한다. 확률 선택은 Pod 이름 난수와 분리한 `netRng`. 컨테이너 안 도구는 curl·wget·ping·nslookup 만 있다(축소판).
- readiness probe: kubelet 이 배경 타이머로 주기 실행, failureThreshold 연속 실패면 Ready=False, 한 번 성공하면 Ready=True. 앱의 준비 시간(`warmupMs`)과 "앱 고장"(사용자 동작)으로 실패를 만든다. liveness 는 3단계.
- 요청 = `{ from: Pod 또는 바깥, to: 이름 또는 IP:포트 }`. 지나는 단계를 순서대로 트레이스에 남긴다:
  1. DNS(CoreDNS: Service 이름 → ClusterIP, headless 면 Pod IP들)
  2. 출발 노드의 kube-proxy 규칙: ClusterIP:포트 → KUBE-SVC 체인 → 확률(시드 고정)로 KUBE-SEP 하나 → DNAT 대상 Pod IP:포트. conntrack 처럼 같은 연결은 같은 대상
  3. 경로: 같은 노드면 브리지(cni0), 다른 노드면 노드 간 라우팅(또는 오버레이 — 열린 결정)
  4. 대상 Pod 의 앱 흉내가 응답(또는 거부·timeout)
- ClusterIP 로 ping(ICMP) 을 보내면 규칙이 TCP/UDP 포트에만 있어 답이 없다 — 이것도 단계로 보여 준다.

## 7. 화면과 모델
- 모델(`src/model/`)은 사용자가 고치는 원본: 노드 목록 + 매니페스트들. 코어는 이것을 받아 API 저장소를 채운다(net-sim `netSync.ts` 처럼 diff 반영 — 처리 순서가 곧 의미).
- kubectl 흉내는 코어 API 위의 얇은 층(문자열 명령 → API 호출 + 실제와 같은 출력 형식). 출력 형식은 테스트로 고정한다.

## 열린 결정 (해당 단계 시작 때 사용자와)
- 가비지 컬렉션 foreground 를 따로 보여 줄지
- 노드 간 Pod 트래픽: 단순 라우팅 vs VXLAN 오버레이 시각화
- kube-proxy 모드: iptables 만 / IPVS 비교
- 시간 상수: **결정 (2026-10-02)** — 백오프(10초~300초)·유예 30초는 실제값, 샌드박스 0.5초·pull 2~4초·컨테이너 시작 0.3초는 학습용으로 줄임(`kubelet.ts`·`workloads.ts`). heartbeat 주기는 노드 장애를 만들 때 정한다
