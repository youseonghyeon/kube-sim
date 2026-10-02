# kube-sim — 에이전트 작업 지침

쿠버네티스가 "왜 이렇게 동작하는지" 를 직접 구성하고 한 단계씩 보며 익히는 학습 시뮬레이터. 자매 프로젝트 `../net-sim`(네트워크 시뮬레이터)과 같은 방식이다: 브라우저에서 돌고, 실제 클러스터에 연결하지 않으며, 모든 시뮬레이션은 결정론적. 디자인 품질이 최우선(`DESIGN.md`).

지금 상태: **0·1단계 (2026-10-02).** Deployment·ReplicaSet·스케줄러·kubelet(pull·크래시 백오프·종료·heartbeat)·노드 장애(NotReady·taint·eviction)·kubectl 흉내·캔버스 UI. 2단계(Service·EndpointSlice·kube-proxy·CoreDNS·readiness), 3단계(롤링 업데이트·liveness·preStop·PDB/drain), 4단계(LoadBalancer·Ingress·externalTrafficPolicy·Tailscale funnel), 6단계(Argo CD 식 GitOps)도 됨. 남은 것은 `docs/ROADMAP.md` 5단계(운영 — 후보 중 고르기).
저장소: https://github.com/youseonghyeon/kube-sim (public). 배포는 아직 없다.

## 목적 — 누구의 어떤 이해를 바꾸나
- 사용자: 자기 서비스(예: net-sim)를 Helm 차트 + ArgoCD 로 홈 클러스터에 배포하는 개발자. kubectl 출력은 보지만 그 뒤에서 무슨 일이 일어나는지는 몰라, 문제가 생기면 추측하게 된다.
- 목표: 다음 같은 질문에 시뮬레이션이 직접 답하게 한다.
  - Pod 를 지웠는데 왜 다시 생기나 · 왜 Pending 에서 멈췄나(FailedScheduling) · 노드가 죽었는데 왜 5분 동안 안 옮겨지나
  - Service IP 는 왜 ping 이 안 되나 · Pod 가 Running 인데 왜 트래픽이 안 가나(readiness) · 요청은 어느 노드의 어느 Pod 로 가나
  - 롤링 업데이트 중 요청은 어디로 가고 왜 502 가 나나 · CrashLoopBackOff 의 백오프는 어떻게 늘어나나
  - ArgoCD 의 OutOfSync·self-heal·prune 은 무엇을 비교하고 무엇을 고치나
- 학습 포인트가 기능보다 우선이다. 새 기능은 "무엇을 새로 배우나" 를 ROADMAP 에 먼저 적는다.

## 언어·스택 (결정 2026-10-02)
- **TypeScript (strict)** + Vite + Preact(+ `@preact/signals`) + vitest + Playwright. net-sim 과 같다. 버전은 `../net-sim/package.json` 에 맞춘다(TypeScript 7, Vite 8, Vitest 5 — `defineConfig` 는 `vitest/config` 에서).
- 이유
  1. 결과물이 브라우저 시각화라 UI 는 어차피 TS 다.
  2. 코어(시뮬레이션)를 DOM 없는 순수 TS 로 두면 vitest 로 결정론적 트레이스를 그대로 단언할 수 있다.
  3. net-sim 의 이벤트 큐·트레이스·로그 서랍·검증 스크립트 패턴과 교훈을 그대로 쓴다.
  4. 배포가 같다(정적 사이트 → nginx 컨테이너).
- 검토했지만 고르지 않음: Go(쿠버네티스 본가 언어지만 화면은 결국 JS 이고 WASM 경계가 부담. 실제 k8s 코드를 돌리는 게 아니라 흉내 내는 것이라 이점이 작다), Rust/WASM(과함), Python(브라우저에서 못 돎).
- 실제 Kubernetes·client-go·kind·minikube 는 쓰지 않는다. 결정론·속도·설명력을 위해 동작을 직접 흉내 낸다.

## 구조 (바뀌면 여기부터 고친다)
- `src/core/` 순수 TS 코어. DOM 의존 금지, 모든 동작은 테스트로 고정한다. 자세한 설계는 `docs/ARCHITECTURE.md`.
  - `clock.ts` 시계·이벤트 큐(일반 타이머 + 배경 타이머) — net-sim `src/core/network.ts` 의 큐 개념
  - `trace.ts` `TraceKind` 목록. 새 이벤트 종류는 여기에 먼저 등록한다
  - `api/` API 서버 흉내: 오브젝트 저장소(kind·namespace·name, `metadata.resourceVersion`·`generation`·`ownerReferences`·`labels`), watch, 낙관적 동시성, ownerReference 가비지 컬렉션, 이벤트(`kubectl get events`)
  - `controllers/` 공통 워크큐(`base.ts`) + Deployment(롤링·Recreate·리비전)·ReplicaSet·EndpointSlice·disruption(PDB) + `nodelifecycle.ts`(node-lifecycle·taint-eviction) (나중에 HPA·StatefulSet)
  - `drain.ts` kubectl drain 진행(Eviction API, 5초 재시도), `net/traffic.ts` 부하 발생기
  - `scheduler.ts` 필터 → 점수 → 바인딩, FailedScheduling 문구
  - `kubelet.ts` 노드마다 Pod 수명주기: 샌드박스·IP → 이미지 pull → 시작 → 크래시 백오프 → SIGTERM·정리, Lease heartbeat, readiness·liveness probe, preStop, 전원 끄기·켜기 (startup probe 없음)
  - `cluster.ts` 위 컴포넌트를 묶은 한 벌 + pod-garbage-collector. 바깥은 여기로만 클러스터를 바꾼다
  - `kubectl.ts` 문자열 명령 → API 호출 + 실제 모양의 출력 (`podStatusText` 등 표시 도우미는 UI 도 쓴다)
  - `workloads.ts` 이미지 카탈로그 = 컨테이너 안 앱 흉내(pull 시간, 크래시 조건, SIGTERM 반응). 카탈로그에 없는 이미지는 pull 실패
  - `gitops/` Git 저장소(`git.ts`), Argo CD 컨트롤러(`argocd.ts` — 비교·자동 sync·selfHeal·prune), argocd·git CLI 흉내(`cli.ts`)
  - `units.ts` cpu(millicore)·memory(MiB)·AGE 표기 · `rng.ts` 시드 고정 난수·이름 접미사·템플릿 해시
  - `net/kubeproxy.ts` 노드마다 iptables 규칙(모양·확률·KUBE-EXT/SVL), `net/request.ts` CoreDNS 이름 풀기 + 요청 한 번의 단계(DNS → DNAT → 경로 → 응답/실패, 바깥 → LB·NodePort·Ingress·funnel, 출발지 IP 추적), `net/ingress.ts` MetalLB·ingress-nginx 상태·Tailscale 오퍼레이터·Ingress 규칙 고르기
  - `controllers/endpointslice.ts` Service 셀렉터 + Pod Ready → 엔드포인트
- `src/model/` 편집 가능한 클러스터 정의(노드 + 매니페스트)와 예제(`examples.ts`, "해 볼 것" 포함), 정의 → 클러스터 diff 반영(`defSync.ts`), 화면 시계(`simClock.ts`), 신호·rAF(`sim.ts`), 화면 모양 뽑기(`view.ts`), 명령 한 줄 나누기(`commands.ts` — curl·argocd·git·kubectl), 앱 상태(`store.ts` — localStorage. 되돌리기는 아직 없음)
- `src/app/` Preact UI: 왼쪽 오브젝트 나무, 캔버스(컨트롤 플레인 · 스케줄 대기 · 노드 안 Pod 칩), 인스펙터(개요·설정·describe·YAML, 선택 없으면 예제의 "해 볼 것"), 아래 서랍(로그 · kubectl)
- `tests/` vitest. 코어는 트레이스 시퀀스(`kind` 배열)를 그대로 단언한다
- `scripts/` `ui-check.mjs`(Playwright 스모크 — Vite 를 **포트 5199** 로 직접 띄움, 사용자가 5173 을 쓸 수 있음), `perf-check.mjs`(프로덕션 빌드로 fps 측정)

## 모델링 원칙
- **결정론**: 코어에 `Math.random`·`Date.now` 금지. 확률이 필요하면(kube-proxy 의 확률 분배 등) 시드 고정 의사난수(net-sim 의 xorshift). 같은 입력 → 같은 트레이스.
- **시계**: 시뮬레이션 시각(ms). 화면 시계는 타이머(일반·배경)가 걸려 있으면 재생 속도(1× = 실제 시간)로 흐르고, 하나도 없으면 멈춘다 — 노드가 있으면 heartbeat 가 있으니 실제처럼 계속 흐른다. net-sim 과 달리 다음 이벤트로 점프하지 않는다 — 기다림(pull·백오프·노드 장애 40초·300초)이 배울 거리라서(ARCHITECTURE 1절). 끝나지 않는 주기 동작(컨트롤러 resync·probe·노드 heartbeat)은 **배경 타이머**(그 자체로는 시계를 움직이지 않음)로만 넣는다 — 일반 타이머로 넣으면 `runToIdle` 이 끝나지 않는다(net-sim LESSONS 4s). 상단바에 시간 흘려보내기("+10초"·"+1분") 버튼을 둔다. 실제로 영원히 재시도하는 kubelet 백오프는 예외로 일반 타이머다(간격 최대 300초) — 그런 시나리오의 테스트는 `runFor`.
- **컨트롤 루프가 주인공**: 쿠버네티스의 핵심은 선언(desired)과 관찰(observed)을 맞추는 reconcile 이다. 컨트롤러는 watch 이벤트로 깨어나 reconcile 하고 실패하면 백오프로 다시 시도한다. 트레이스는 이 루프를 그대로 보여 준다.
- **트레이스 문구**: "무엇을 보고 → 어떤 결정 → 결과" 가 한 줄에 드러나게. 예: `replicaset-controller: web-7d9 원하는 3 · 있는 2 → Pod 1개 생성 (web-7d9-x2k)`.
- **네트워킹 깊이**: 처음에는 요청(연결) 단위로 그린다 — 요청 하나가 DNS → Service VIP → kube-proxy 규칙 → Pod IP → 노드 간 경로를 어떻게 지나는지 단계별로. net-sim 같은 프레임 단위는 필요해질 때(오버레이 캡슐화를 보여 줄 때 등) 정한다.
- **줄인 것은 밝힌다**: 실제와 다르게 줄인 동작은 코드 주석·이 문서·화면 안내에 "축소판" 으로 적는다.
- 사용자 입력으로 끝없이 돌 수 있는 곳(컨트롤러가 서로를 계속 고치는 구성, 크래시 루프)에는 상한·백오프를 둔다.

## 용어·문구
- UI·로그는 한국어 존댓말 문장형. 쿠버네티스 용어는 **실무 통용어·원문 그대로** 쓴다. 우리말로 풀어 쓰지 않는다(사용자가 원함 — net-sim 에서 확인): Pod, Deployment, ReplicaSet, Service, ClusterIP, NodePort, Endpoints, EndpointSlice, kube-proxy, readiness/liveness/startup probe, rolling update, maxSurge/maxUnavailable, taint/toleration, cordon/drain, eviction, requests/limits, OOMKilled, CrashLoopBackOff, ImagePullBackOff, Pending, FailedScheduling, OutOfSync, self-heal, prune.
- 이벤트 Reason·상태 문자열은 실제 kubectl 출력과 같게 쓴다(예: `Back-off restarting failed container`, `0/3 nodes are available: 3 Insufficient cpu.`).
- 실무 출력 줄을 함께 보여 준다: `kubectl get pods -o wide`, `kubectl describe pod`, `kubectl get events`, `kubectl rollout status`, `iptables-save | grep KUBE-SVC`, `conntrack -L`, `argocd app get`.
- 에러·실패 문구는 "무엇이 잘못됐고 어떻게 고치는지" 를 담는다.

## 사용자와 일하는 방식
- 한국어로, 존댓말 어미로, 짧고 직설적으로 답한다.
- 착수 전 명시적인 "진행해/해줘" 가 있는지 본다. 설명 + 질문으로 끝난 말은 지시가 아니다 → 답하고 범위를 제안한 뒤 멈춘다.
- 디자인 방향·상호작용 모델은 큰 UI 를 만들기 전에 먼저 보여 주고 확인받는다(net-sim 첫 버전이 "내가 바란 게 아니다" 를 받은 교훈).
- 긴 작업 중에는 단계(커밋·리뷰 결과)마다 한두 줄로 진행을 알린다. 오래 조용하면 문제가 생긴 것으로 읽힌다. 큰 작업 보고는 마지막에 1) 한 일 2) 검증한 방법 3) 검증 못 한 부분 4) 알려진 한계.
- 큰 기능 뒤에는 깨끗한 문맥의 리뷰 에이전트(worktree)에게 "재현 테스트로 결함을 찾아라" 를 시키고, 결함을 고친 뒤 재현 테스트를 저장소에 남긴다. 끝나면 worktree 를 지운다(`.gitignore` 에 `.claude/worktrees/` — `git add -A` 가 worktree 를 gitlink 로 담은 사고가 있었다).
- 새 실수·교훈은 그 세션에 `docs/LESSONS.md` 에, 사용자에게 보이는 실패 문구는 `docs/TROUBLESHOOTING.md` 에 남긴다. 같은 실수를 두 번 하면 규칙(테스트·린터·이 문서)으로 막는다.
- 커밋은 아래 검증을 통과한 뒤에 한다. 파일은 경로를 지정해 stage 한다(`git add -A` 금지). 원격은 public GitHub(`origin`, main 에 바로 push — 사용자 승인 2026-10-02). 배포는 아직 없다 — 만들 때 사용자와 정한다(net-sim 은 ghcr + ArgoCD + Tailscale funnel. 클러스터 쓰기는 사용자 몫).

## 검증
```
npm run typecheck   # tsc --noEmit
npm test            # vitest (코어)
npm run ui-check    # Playwright 스모크 (.shots/ 에 스크린샷)
npm run perf-check  # 프로덕션 빌드로 fps·긴 프레임
```
코어 변경은 `npm test`, UI 변경은 `npm run ui-check` 까지 통과해야 완료다. 캔버스 매 프레임 코드는 `perf-check` 도. 예제·화면을 바꾸면 스크린샷을 직접 본다(테스트가 다 통과해도 겹침·잘림은 화면에서만 보인다).

## 문서
- `DESIGN.md` 디자인 토큰·원칙 (net-sim 에서 물려받은 것 + kube-sim 캔버스 제안)
- `docs/ROADMAP.md` 단계별 계획·배우는 것·완료 기준 — **다음 할 일은 여기서 고른다**
- `docs/ARCHITECTURE.md` 코어 설계(오브젝트·컨트롤 루프·시계·요청 경로)와 열린 결정
- `docs/LESSONS.md` 교훈 (net-sim 에서 물려받은 것 + 새로 생기는 것)
- `docs/TROUBLESHOOTING.md` 사용자가 보는 실패 문구 → 원인 → 고치는 법
- 참고: `../net-sim` — 같은 사용자의 자매 프로젝트. 코드와 교훈을 참고하되 import 로 의존하지는 않는다(필요한 것은 옮겨 와서 이쪽 테스트로 고정).
