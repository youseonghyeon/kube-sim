# kube-sim 코어 설계

0·1단계를 시작하기 전의 설계안이다. 만들면서 바뀌면 이 문서를 먼저 고친다. "열린 결정" 은 그 단계를 시작할 때 정한다.

## 1. 시계와 이벤트 큐
- 이벤트 = `{ at(ms), seq, actor, run() }`. `at` 다음 `seq`(넣은 순서) 로 정렬 → 결정론.
- 일반 타이머: 시계를 그 시각으로 점프시킬 수 있다. 끝이 있는 기다림(이미지 pull 3초, 재시작 백오프)에 쓴다. 핸들로 취소한다 — 끝난 일의 타이머가 남으면 시계가 엉뚱하게 뛴다(net-sim LESSONS 1).
- 배경 타이머: 그 자체로는 시계를 움직이지 않고, 다른 일로 시간이 그 시각을 지날 때만 발화한다. 끝나지 않는 주기 동작(probe 주기, 노드 heartbeat, 컨트롤러 resync)은 반드시 이것으로. 일반 이벤트가 없으면 `runToIdle` 은 멈춘다.
- `runToIdle(maxEvents)`, `runUntil(t)`, `step()`. 화면 애니메이션 시계는 net-sim `simClock.ts` 의 `advanceClock` 방식.
- 같은 순간의 여러 변화(노드를 지워 Pod 여럿이 동시에 사라짐)를 보고 판단해야 하는 곳은 0ms 타이머로 미뤄 모두 본 뒤 정한다(net-sim LESSONS 4v).

## 2. API 서버 흉내
- 오브젝트 = `{ apiVersion, kind, metadata: { namespace, name, uid, resourceVersion, generation, labels, ownerReferences, deletionTimestamp }, spec, status }`. 필요한 필드만 둔다(학습에 쓰이는 것만).
- 저장소: `Map<"kind/ns/name", Obj>`, 전역 `resourceVersion` 카운터. 쓰기마다 +1. `spec` 이 바뀌면 `generation` +1.
- watch: 구독자에게 `ADDED/MODIFIED/DELETED` 를 **이벤트 큐로** 전달한다(짧은 고정 지연 — informer 지연이 보이도록, 값은 열린 결정). 콜백을 즉시 동기 호출하지 않는다(재진입 사고 방지 — net-sim LESSONS 4h·4k).
- 낙관적 동시성: `update` 는 받은 `resourceVersion` 이 현재와 다르면 `Conflict` → 컨트롤러가 다시 읽고 재시도.
- 삭제: `deletionTimestamp` → (finalizer 는 나중) → 실제 삭제. ownerReference 를 따라 가비지 컬렉션(foreground/background 는 열린 결정).

## 3. 컨트롤러
- 공통 틀: watch → 워크큐(같은 키는 합침) → `reconcile(key)` → 실패면 지수 백오프 재큐잉(배경이 아니라 일반 타이머 — 끝이 있다). 주기 resync 는 배경 타이머.
- Deployment: 템플릿 해시로 ReplicaSet 을 만들고 replicas 를 옮긴다(롤링 업데이트는 3단계).
- ReplicaSet: 원하는 수 vs 셀렉터에 맞는 살아 있는 Pod 수 → 생성/삭제(삭제 순서: Pending → NotReady → 최근 생성).
- EndpointSlice: Service 셀렉터 + Pod Ready 조건 → 엔드포인트 목록(2단계).
- Node lifecycle: heartbeat(Lease) 끊김 → NotReady → taint → toleration 만료 Pod eviction.
- 트레이스 actor 이름은 실제 컴포넌트 이름: `kube-scheduler`, `replicaset-controller`, `deployment-controller`, `kubelet@node-1`, `kube-proxy@node-2`, `coredns`.

## 4. 스케줄러
- 바인딩 안 된 Pod 를 큐에 → 필터(Ready 노드, requests 가 남은 자리에 맞음, nodeSelector, taint/toleration) → 점수(남은 자원 균형 등 단순 규칙, 동점은 노드 이름 순 — 결정론) → `spec.nodeName` 바인딩.
- 실패하면 `FailedScheduling` 이벤트에 노드별 이유를 실제 문구로 모은다. 클러스터가 바뀌면(노드 추가·Pod 삭제) 다시 시도.

## 5. kubelet
- 자기 노드에 바인딩된 Pod 를 watch → 샌드박스·IP(CNI) → 이미지 pull(이미지별 고정 시간, 노드에 있으면 생략) → 컨테이너 시작 → 앱 흉내(`workloads.ts`)의 시작 시간 뒤 Running.
- probe: startup → liveness/readiness 주기(배경 타이머). readiness 결과는 Pod `Ready` 조건으로.
- 재시작: `restartPolicy`, 크래시마다 백오프 10s 두 배 최대 300s(성공적으로 10분 돌면 초기화) → `CrashLoopBackOff` 표시.
- 종료: `deletionTimestamp` → preStop → SIGTERM → grace period → SIGKILL(3단계).
- 노드 status·heartbeat 를 API 에 올린다(배경 타이머).

## 6. 네트워크 — 요청 단위 (2단계)
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
- watch 전달 지연 값(0ms vs 수 ms), 컨트롤러 처리 지연을 보여 줄지
- 가비지 컬렉션 방식(background 기본 / foreground 를 보여 줄지)
- 노드 간 Pod 트래픽: 단순 라우팅 vs VXLAN 오버레이 시각화
- kube-proxy 모드: iptables 만 / IPVS 비교
- 시간 상수(이미지 pull·컨테이너 시작·heartbeat 주기)를 실제값으로 할지 학습용으로 줄일지 — 실제값이면 "+10초" 가 자주 필요하다
