# kube-sim 코어 설계

만들면서 고쳐 온 지금의 설계다 (0~4·6단계 2026-10-02, 5a·5b 2026-10-06). 바뀌면 이 문서를 먼저 고친다. 실제와 다르게 줄인 것은 "축소판" 으로 적는다. 남은 결정은 맨 끝 "열린 결정".

## 1. 시계와 이벤트 큐 (`clock.ts`, `model/simClock.ts`)
- 이벤트 = `{ at(ms), seq, actor, run() }`. `at` 다음 `seq`(넣은 순서) 로 정렬 → 결정론. 코어에 `Math.random`·`Date.now` 없음 (난수는 `rng.ts` 시드 고정).
- 일반 타이머: 시계를 그 시각으로 점프시킬 수 있다. 끝이 있는 기다림(이미지 pull, 재시작 백오프, 진전 마감, eviction 예약, self-heal)에 쓴다. 핸들로 취소한다 — 끝난 일의 타이머가 남으면 시계가 엉뚱하게 뛴다(net-sim LESSONS 1).
- 배경 타이머: 그 자체로는 시계를 움직이지 않고, 다른 일로 시간이 그 시각을 지날 때만 발화한다. 끝나지 않는 주기 동작(probe 주기, Lease heartbeat, 노드 감시, Git 폴링, 부하 발생기)은 반드시 이것으로.
- `runToIdle(maxEvents)`(일반 이벤트만 — 배경은 끝이 없으므로), `runUntil(t)`, `step()`, `stepAny()`(화면의 "한 단계" — 배경만 남아도 나아감).
- **화면 시계 (결정)**: 타이머(일반 또는 배경)가 하나라도 걸려 있으면 재생 속도(1× = 실제 시간)로 흐르고, 하나도 없으면 멈춘다. 노드가 있으면 heartbeat 가 늘 있으므로 실제 클러스터처럼 시간이 계속 흐른다 — 노드 장애의 40초·300초가 저절로 지나가야 해서다. net-sim 처럼 다음 이벤트로 **점프하지 않는다** — 기다림 자체가 배울 거리. 긴 기다림은 속도(최대 30×)와 "+10초"·"+1분".
- **끝없는 일반 타이머 사슬 (결정)**: 크래시·이미지 pull 재시도는 실제 kubelet 처럼 영원히 계속된다(간격 10초~300초라 폭주하지 않음). 그런 구성에서는 `runToIdle` 이 끝나지 않는다 → 테스트는 `runFor(ms)`.
- 같은 순간의 여러 변화를 보고 판단하는 곳은 0ms 타이머로 미뤄 모두 본 뒤 정한다(net-sim LESSONS 4v) — 컨트롤러 워크큐가 이렇게 모은다.
- 시간 상수 (결정): 백오프(10~300초)·유예 30초·Lease 40초·toleration 300초·Argo CD 폴링 180초·selfHeal 5초는 실제값. 샌드박스 0.5초·pull 1.5~4초·컨테이너 시작 0.3초·watch 전달 0.1초·kube-proxy 규칙 반영 1초는 학습용으로 정한 값.

## 2. API 서버 흉내 (`api/server.ts`, `api/types.ts`)
- 오브젝트 = `{ apiVersion, kind, metadata: { namespace, name, uid, resourceVersion, generation, labels, annotations, ownerReferences, deletionTimestamp }, spec, status }`. 학습에 쓰이는 필드만.
- 종류: Pod·ReplicaSet·Deployment·Node·Lease·Service·EndpointSlice·PodDisruptionBudget·Ingress·Application. 네임스페이스는 default 하나(축소판) — 예외는 Lease(kube-node-lease)·Application(argocd).
- 저장소 `Map<"kind/ns/name", Obj>`, 전역 `resourceVersion`. 쓰기마다 +1, `spec` 이 바뀌면 `generation` +1. 내용이 같은 update 는 쓰지 않는다 — 상태 갱신이 서로를 끝없이 깨우지 않게.
- watch: `ADDED/MODIFIED/DELETED` 를 **이벤트 큐로** 전달(지연 100ms). 복사본 하나를 모든 구독자가 함께 읽는다(읽기 전용). 콜백을 동기 호출하지 않는다(재진입 사고 방지 — net-sim LESSONS 4h·4k). 컴포넌트 안의 반복 조회는 복사 없는 `peekList`(읽기 전용).
- 컨트롤러는 informer 캐시 대신 API 를 직접 읽는다(축소판 — 캐시 지연·expectations 없음).
- 낙관적 동시성: 받은 `resourceVersion` 이 다르면 `Conflict` → `patch()` 가 다시 읽어 최대 5번.
- 서버가 정하는 값: 이름 검증(DNS subdomain), Deployment 기본값(RollingUpdate 25%/25%·progressDeadline 600·revisionHistoryLimit 10), Pod 기본 toleration(300초), Service ClusterIP(10.96.0.0/12)·NodePort(30000-32767)·externalTrafficPolicy — 만들 때와 바꿀 때 모두 같은 함수로(불변 필드 검사 포함).
- 삭제: 노드에 올라간 Pod 는 `deletionTimestamp`(Terminating) → kubelet 이 정리 후 최종 삭제. 나머지는 바로. ownerReference 가비지 컬렉션은 background(주인이 사라진 뒤 watch 지연만큼 뒤). finalizer 없음.
- Eviction API(`evict`): Pending·끝난 Pod 는 PDB 무시, PDB 가 둘 이상이면 거절, 허용 수가 없으면 429.
- 이벤트(`kubectl get events`): 같은 (대상, reason, message) 는 한 줄로 모으고 count 를 늘린다.
- apply(`Cluster.apply`)는 kubectl 처럼 `last-applied-configuration` 주석을 남기고, Deployment 템플릿 주석은 3-way merge(다른 도구가 붙인 `restartedAt` 보존). Service 는 매니페스트에 없는 clusterIP·nodePort 를 이어받는다.

## 3. 컨트롤러 (`controllers/`)
- 공통 틀(`base.ts`): watch → 워크큐(같은 키 합침, 0ms 뒤 한꺼번에) → `reconcile(key)` → 실패면 지수 백오프(일반 타이머, 5ms~60초, 15번 넘게 실패하면 포기). 컨트롤러를 만들 때 "무엇이 바뀌면 나를 다시 깨워야 하나" 를 목록으로 적고 watch 를 맞춘다(LESSONS).
- ReplicaSet: 원하는 수 vs 셀렉터에 맞는 살아 있는 Pod 수 → 생성(이름 = generateName 58자 + 5자)/삭제(순서: 노드 없음 → Pending → 준비 안 됨 → 재시작 많음 → 최근 생성). slow start 없음(축소판).
- EndpointSlice: Service 셀렉터 + Pod Ready·Terminating → 엔드포인트(Service 하나에 슬라이스 하나 — 축소판). 레이블이 바뀌어 벗어난 Pod 도 다시 계산.
- disruption: PDB 마다 Ready 수·최소 수(기대 수는 주인 Deployment 의 replicas)·허용 수.
- 트레이스 actor 이름은 실제 컴포넌트 이름: `kube-scheduler`, `deployment-controller`, `replicaset-controller`, `endpointslice-controller`, `node-lifecycle-controller`, `taint-eviction-controller`, `kubelet@node`, `kube-proxy@node`, `coredns`, `metallb-speaker@node`, `argocd-application-controller`.

### 3-1. Deployment·롤아웃 (3단계, `controllers/deployment.ts`)
- 새 RS = 지금 템플릿 해시(+ collisionCount)의 RS. RollingUpdate 는 실제 알고리즘의 축소판 — 새 RS 는 전체(spec.replicas 합)가 replicas+maxSurge 를 넘지 않게 늘리고, 옛 RS 는 "전체 − minAvailable − 새 RS 의 unavailable" 과 "available − minAvailable" 중 작은 만큼 줄인다(옛 RS 의 안 뜬 Pod 부터). 그래서 새 Pod 가 Ready 가 안 되면 멈춘다.
- Recreate 는 옛 Pod 가 모두 사라진 뒤 새 RS 를 늘린다(Pod 삭제를 watch).
- 리비전 = RS 의 `deployment.kubernetes.io/revision`. 옛 템플릿으로 돌아오면(undo) 그 RS 를 다시 쓰고 리비전을 맨 위로. 옛 RS 정리(revisionHistoryLimit)는 롤아웃이 끝난 뒤에만.
- 조건: Available, Progressing(진전 = 새 Pod·Ready·available 증가 또는 옛 Pod 감소). 진전 마감은 일반 타이머 — ProgressDeadlineExceeded 는 알림일 뿐 되돌리지 않는다.
- 축소판: minReadySeconds·paused·비례 스케일링 없음.

### 3-2. 노드 장애 (1단계, `controllers/nodelifecycle.ts`)
- kubelet 은 `kube-node-lease` 의 Lease 를 10초마다 갱신(배경). Lease 는 Node 가 주인 → Node 를 지우면 GC. 같은 이름 노드를 다시 더하면 남은 Lease 를 이어받는다.
- node-lifecycle-controller: 5초마다(배경) Lease 를 보고 40초 넘게 갱신이 없으면 Ready=Unknown, taint `node.kubernetes.io/unreachable` NoSchedule·NoExecute(timeAdded), 그 노드 Pod 의 Ready=False. 되살아나면 taint 제거.
- taint-eviction-controller: timeAdded + tolerationSeconds 에 Pod 삭제 예약(일반 타이머 — taint 가 빠지면 취소). kubelet 이 없으니 Pod 는 Terminating 에 멈춘다(실제와 같음). 노드가 돌아오면 kubelet 이 정리, Node 를 지우면 pod-garbage-collector 가 강제 삭제(같은 이름 노드가 이미 다시 있으면 건드리지 않음).
- 노드 "끄기" 는 API 에 없는 사실이라 `Cluster.setNodePower` 로만 바꾼다. 꺼진 kubelet 은 resize 를 보고하지 못하고, 켜면 바인딩된 Pod 를 다시 읽어 맞춘다(지워지던 것 정리, 나머지는 새 샌드박스·새 IP, 한 번이라도 시작했던 컨테이너만 재시작 +1).
- 축소판: zone 별 eviction 속도 제한·대규모 장애 보호 없음, NodeStatus 주기 보고 없음(Lease 만), not-ready(kubelet 은 살았는데 런타임 고장) 경우 없음.

### 3-3. PDB·drain (3단계, `drain.ts`)
- `DrainJob`: cordon → 시작할 때 고른 Pod(Terminating 포함)만 대상 → evict → 429 면 5초 뒤 다시 → Pod 가 사라지면 "evicted" → 모두 사라지면 "drained". 출력 줄이 시간이 지나며 늘어난다. 10분 넘게 못 끝내면 포기(축소판 — 실제 기본은 무한 대기).

## 4. 스케줄러 (`scheduler.ts`)
- 노드가 없는 Pod 를 큐에 → 필터(cordon, untolerated taint(NotReady 포함), nodeSelector, Too many pods, Insufficient cpu/memory — Terminating Pod 도 자리를 차지) → 점수 LeastAllocated(동점은 노드 이름 순) → `spec.nodeName` 바인딩.
- 실패하면 `FailedScheduling` 에 실제 문구(`0/3 nodes are available: 3 Insufficient cpu.`)로 이유를 모으고, 클러스터가 바뀔 때만(노드 추가·자원·cordon·taint·라벨·Ready 변화, 노드의 Pod 삭제) 다시 시도 — status.images 같은 변화는 무시. 재시도 이유를 트레이스에 남긴다.
- 축소판: 여러 점수 플러그인·preemption·5분 주기 재시도 없음.

## 5. kubelet (`kubelet.ts`)
- 자기 노드에 바인딩된 Pod 를 watch → 샌드박스·IP(노드의 PodCIDR) → 이미지 pull(같은 이미지는 한 번만, 노드에 있으면 생략, 레지스트리에 없으면 ErrImagePull → ImagePullBackOff) → 컨테이너 시작 → Running.
- readiness probe(배경 주기): failureThreshold 연속 실패면 Ready=False, 한 번 성공하면 Ready=True. 앱의 준비 시간(`warmupMs`)과 "앱 고장"(사용자 동작)으로 실패를 만든다.
- liveness probe(배경 주기): 연속 실패면 컨테이너를 죽이고 crash 와 같은 길(백오프 포함). "앱 고장" 은 프로세스 상태라 재시작하면 풀린다.
- 재시작: 크래시마다 첫 재시작은 바로, 그다음 10초부터 두 배 최대 300초(10분 잘 돌면 초기화) → CrashLoopBackOff.
- 종료: `deletionTimestamp` → (preStop sleep — 그동안 계속 요청을 받음) → SIGTERM(새 연결 거부, `termMs` 뒤 종료) → 남은 유예(최소 2초) 안에 안 끝나면 SIGKILL → 정리 → 최종 삭제.
- 축소판: Pod 마다 첫 컨테이너만 돌린다, startup probe 없음.

### 5-1. 자원 — requests·limits·실사용 (5a, 2026-10-06)
- 세 숫자가 따로 산다: requests(API·스케줄러가 보는 예약), limits(커널 cgroup 상한), 실사용(이미지 모양에서 계산 — `workloads.ts` `memoryAt`·`cpuM`·`workMs`). `kubectl top` = 실사용(`Cluster.podMetrics`).
- API 서버: limits 만 적고 requests 를 비우면(0) **Pod 에만** requests = limits (실제 SetDefaults_Pod — 템플릿은 적은 그대로라 limits 를 바꾸면 새 Pod 가 새 limits 로 채워지고, Argo CD·드리프트 비교에 보정이 필요 없다). requests > limits 면 Invalid (템플릿 포함). limits 0 은 상한 없음(`limitOf`) — kubelet 이 0 을 쿼터 없음으로 보는 것과 같다.
- 메모리: 컨테이너가 시작하면 0 → `memMi`(램프 `memRampMs`) → 누수(`leakMiPerMin`). 시간에 대해 줄지 않으므로 "다음 OOM 시각" 을 이분 탐색(ms)으로 찾아 **배경 타이머** 하나(`oomWatch`)로 건다 — 매초 검사하지 않는다. 컨테이너가 뜨고 죽을 때·노드 자원이 바뀔 때 다시 건다.
  - cgroup OOM: 사용 > limits.memory → `kubelet.oom` → crash(137, `OOMKilled`) → 보통의 재시작·백오프.
  - 노드 OOM: 컨테이너 사용 합 > 노드 메모리 → oom_score = 사용/노드×1000 + oom_score_adj(Guaranteed -997 · BestEffort 1000 · Burstable 1000-1000×requests/노드 를 3~999)가 가장 큰 것 하나 → 노드에 `SystemOOM` 이벤트.
- CPU: 컨테이너마다 원하는 만큼(`cpuM`, limits.cpu 까지). 합이 노드 CPU 를 넘으면 requests 비율(cpu.shares, 최소 2m)로 물 채우기 분배. 덜 받은 비율만큼 응답이 느려진다: 응답 = `workMs` × 원함/받음 (받음은 반올림 전 값, 바닥 1m — 화면의 `0m` 에서도 끝이 있는 값). 지워지는 중(watch 가 오기 전)에 죽은 컨테이너는 재시작하지 않고 종료 상태(예: OOMKilled)를 남긴 채 정리된다. probe 도 같은 응답 시간이라 timeoutSeconds(기본 1초)를 넘으면 실패(`context deadline exceeded`). 분배는 도는 컨테이너가 바뀔 때만 다시 계산(`cpuCache`).
- 축소판: kubelet 의 node-pressure eviction(memory.available)·시스템 예약(kube-reserved)·페이지 캐시 없음, CPU 는 CFS 주기·버스트 없이 비율로만, 요청 수가 CPU 사용을 늘리지 않음(수요는 이미지마다 고정), metrics-server 지연(15초) 없음. `kubectl top` 은 실제처럼 Mi·% 를 버림.

### 5-2. 설정 — ConfigMap·Secret (5b, 2026-10-06)
- 오브젝트: ConfigMap(data 평문), Secret(data base64 — 쓸 때 stringData 를 주면 API 서버가 data 로 바꾸고 stringData 는 저장하지 않음). spec 이 없어 `apply` 와 Argo CD 비교는 data 를 따로 다룬다 (Argo CD 는 Git 의 stringData 를 base64 로 바꿔 라이브 data 와 키 집합까지 비교).
- kubelet 순서: 샌드박스 → **volume 마운트**(ConfigMap·Secret 이 없으면 FailedMount 로 ContainerCreating 에 머물며 2초부터 두 배·최대 2분 재시도 — 이미지 pull 도 안 함) → pull → 컨테이너 만들기 직전 **env 해석**(envFrom → env 순, 없으면 CreateContainerConfigError 로 10초마다 재시도).
- env 는 컨테이너마다 시작할 때 한 번 (크래시 재시작이면 같은 Pod 라도 다시 해석). 파일은 Pod 단위: ConfigMap·Secret 이 바뀌면 watch 로 알고 `VOLUME_SYNC_MS`(1분) 뒤 non-subPath 파일만 다시 쓴다. 지워져도 이미 붙은 파일은 남긴다.
- `kubectl exec -- env|printenv|cat|ls` 와 설정 앱(`example/config-app`, 요청마다 env 와 파일을 그대로 돌려줌)이 컨테이너가 본 값을 보여 준다.
- 축소판: kubelet 동기화 주기·캐시 TTL 대신 1분 고정, 원자적 심볼릭 링크 교체(..data) 없음, optional 참조·items(키 골라 마운트)·defaultMode·immutable·binaryData·Secret 종류(tls·dockerconfigjson) 없음, 네임스페이스는 default 하나.

## 6. 네트워크 — 요청 단위 (2·4단계, `net/`)
- ClusterIP·NodePort 는 API 서버가 정한다. kube-proxy 는 노드마다 Service·EndpointSlice 를 watch 해 그 노드의 규칙을 **1초 뒤**(RULE_SYNC_MS) 다시 쓴다 — 이 틈 때문에 Pod 삭제·롤아웃 중 요청이 실패하고 preStop 이 그것을 막는다. 요청은 **출발 노드의 규칙**으로 DNAT 된다(꺼진 노드의 규칙은 멈춰 있다).
- `iptables-save` 모양: filter(KUBE-SERVICES·KUBE-EXTERNAL-SERVICES 의 has no endpoints REJECT), nat(KUBE-SERVICES → KUBE-SVC → 확률 1/n → KUBE-SEP → DNAT, 바깥은 KUBE-EXT, Local 은 KUBE-SVL, Pod 대역은 "pod traffic" 규칙).
- 요청 한 번(`request.ts`)은 시뮬레이션 시간을 쓰지 않고 지금 상태로 한 번에 계산한다: (CoreDNS: resolv.conf search·ndots:5) → 출발 노드 규칙 DNAT → 경로(같은 노드 cni0, 다른 노드 flannel VXLAN — 문구로만) → 앱 응답(200·503·거부·시간 초과). 확률 선택은 Pod 이름 난수와 분리한 `netRng`. 컨테이너 안 도구는 curl·wget·ping·nslookup 만(축소판). ClusterIP 로 ping 은 답이 없다.
- 출발지 IP 를 따라간다: `Source.ip`(받는 쪽이 볼 출발지)와 X-Forwarded-For. SNAT 에서 노드 IP 로, 프록시(ingress-nginx·Tailscale)는 새 연결이라 자기 Pod IP 가 되고 원래 출발지를 XFF 에 붙인다.
- 부하 발생기(`traffic.ts`): 배경 타이머로 요청을 계속 계산, 실패만 트레이스에 남긴다.

### 6-1. 바깥에서 들어오는 길 (4단계, `net/ingress.ts`)
- LoadBalancer = NodePort + MetalLB 가 준 IP(192.168.0.240~250). speaker 는 노드 전원으로 살고, 후보 노드 중 해시 순서로 하나가 ARP 를 맡는다(맡던 노드가 계속 자격이 있으면 유지). Local 이면 Ready Pod 가 있는 노드만 후보. IP 를 반납하면 기다리던 Service 를 다시 본다.
- externalTrafficPolicy: Cluster 는 SNAT 후 모든 엔드포인트, Local 은 그 노드의 엔드포인트만(없으면 버림), 출발지 보존.
- ingress-nginx: Host 마다 server 블록 — Host 가 맞는 규칙들 안에서만 경로(Exact → 가장 긴 Prefix, 쿼리는 뗌), 없으면 그 Ingress 의 defaultBackend, 그것도 없으면 404, 엔드포인트가 없으면 503. Service 의 ready 엔드포인트로 직접 보낸다(ClusterIP 를 거치지 않음). ADDRESS = 컨트롤러 Service 의 LoadBalancer IP.
- Tailscale 오퍼레이터: tailscale 클래스 Ingress 마다 프록시(Deployment `ts-<이름>`, 주인 = Ingress)를 만들고 지워지면 다시 만든다. ADDRESS = `<tls 호스트 첫 라벨>.<tailnet>`(겹치면 -1). 프록시는 backend Service 의 ClusterIP 로 보낸다. funnel 이면 공인 인터넷 → 중계 → 프록시(443·8443·10000 만).
- 바깥 DNS: Ingress 규칙의 host 는 그 Ingress 의 ADDRESS 로 풀린다고 가정.
- 축소판: MetalLB·오퍼레이터는 Pod 없는 부가 기능(장애 감지 즉시), 프록시는 StatefulSet 대신 Deployment, tailnet 이름은 가짜. Cluster 정책의 SNAT 출발지를 노드 InternalIP 로 보여 준다 — 실제(k3s flannel VXLAN)에서는 flannel.1·cni0 주소로 보일 수 있다(확인 안 함 — 추정).

## 7. GitOps (6단계, `gitops/`)
- Git 은 클러스터 밖의 사실이라 API 오브젝트가 아니다(`Cluster.git`). 커밋 = 파일 전체 스냅샷, SHA 는 내용으로 정해짐(결정론). Helm 렌더링 결과가 저장소에 있다고 본다(축소판).
- Argo CD 는 Application 마다 "가져온 리비전"(과 source)을 따로 기억한다 → push 해도 다음 폴링(배경 3분)이나 Refresh 전에는 모른다. source 가 바뀌면 다시 가져온다. 라이브는 watch 로 바로 본다. 손으로 하는 sync 는 그때 HEAD 를 다시 읽는다.
- 비교: Git 매니페스트에 적힌 필드만 라이브와 비교(기본값으로 채워진 필드 무시). 추적 표 `app.kubernetes.io/instance` 가 붙었는데 Git 에 없는 것은 prune 대상.
- 자동 sync 는 (리비전, source) 마다 한 번. 같은 리비전의 드리프트는 selfHeal 이면 5초 뒤(일반 타이머 — 한 번). 할 일이 prune 뿐인데 prune 이 꺼져 있으면, 또는 Git 경로가 비면(allowEmpty=false) 자동으로 하지 않는다. 적용이 거절되면 Failed 로 끝나고 같은 리비전을 다시 시도하지 않는다.
- 축소판: Argo CD 는 Pod 없는 부가 기능, 대상 네임스페이스 default, sync 즉시 완료, webhook·훅·sync wave·finalizer 없음.

## 8. 화면과 모델 (`src/model/`, `src/app/`)
- 모델은 사용자가 고치는 원본: 노드 목록 + 매니페스트 + (GitOps 예제의) 처음 Git 내용. `defSync.ts` 가 diff 로 클러스터에 반영한다(처리 순서가 곧 의미: 노드 → Deployment → 나머지 → 지운 것 → 지운 노드). kubectl·argocd 로 바꾼 라이브는 모델에 돌아오지 않는다(드리프트로 보인다 — 실제와 같음).
- 명령 한 줄(`commands.ts`): `curl …` = 클러스터 밖에서, `argocd …`·`git …` = 그 CLI 흉내, 나머지 = kubectl. 출력 형식은 테스트로 고정한다.
- 화면은 `view.ts` 가 뽑은 모양(같은 버전이면 캔버스·목록이 함께 씀)을 그리고, 캔버스는 실제 시간 약 0.1초마다만 다시 그린다(이름표·카운트다운).

## 열린 결정
- 가비지 컬렉션 foreground 를 따로 보여 줄지
- 노드 간 Pod 트래픽을 패킷 단위(VXLAN 캡슐화)로 그릴지 — 지금은 문구로만
- kube-proxy IPVS·nftables 모드 비교
- conntrack(같은 연결은 같은 대상)·headless Service
- 5단계(운영) 남은 후보: HPA(실사용 모양이 생겼으니 metrics 를 그대로 쓸 수 있다), NetworkPolicy, StatefulSet+PVC. 5a 뒤: kubelet node-pressure eviction(Evicted Pod)을 보여 줄지
