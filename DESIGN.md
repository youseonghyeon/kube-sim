# kube-sim 디자인 노트

자매 프로젝트 net-sim(`../net-sim/DESIGN.md`)의 방향·토큰을 물려받는다 — 같은 사용자가 승인한 방향이다. 아래 "캔버스" 는 0단계에서 그려 보여 주고 사용자가 확인했다(2026-10-02).

## 방향
정제된 프로덕트 툴(Linear/Figma 결). 크롬(UI 뼈대)은 무채색으로 물러나고, 캔버스 위의 노드·Pod·트래픽만 색을 가진다.

## 색 (net-sim 과 같음)
| 토큰 | 라이트 | 다크 | 용도 |
|---|---|---|---|
| canvas | #EDEFF2 | #15171C | 캔버스 바닥 |
| surface | #FFFFFF | #1E2128 | 패널 |
| surface-2 | #F5F6F8 | #262A32 | 입력, 호버 |
| line | #DFE3E8 | #30353E | 1px 구분선 |
| ink | #17191E | #E8EAEE | 본문 |
| ink-2 | #646B78 | #9AA1AD | 보조 텍스트 |
| accent | #3457D5 | #7A93FF | 선택, 주요 버튼 |

상태: 정상 #1E9E5A · 기다림(Pending·ContainerCreating) #C98A10 · 오류(CrashLoopBackOff·ImagePullBackOff·NotReady) #D64541
새 색은 토큰으로만 추가한다. 다크 모드는 처음부터 토큰으로 함께 둔다.

## 타이포
- Pretendard Variable: UI 전체(한글+라틴). 13px 기본, 12px 보조, 11px 캡션. 제목은 크기보다 굵기(600)로 구분.
- JetBrains Mono: IP·포트·리소스 이름·kubectl 출력처럼 문자 정렬이 의미 있는 데이터에만.

## 레이아웃 (net-sim 과 같은 틀)
44px 상단바(재생·일시정지·속도·"+10초"·파일 메뉴) / 좌측 팔레트 / 캔버스 / 우측 300px 인스펙터(탭: 개요·설정·진단·표, 접기·넓게) / 하단 접이식 서랍(로그 · kubectl 입력창 — `curl`·`argocd`·`git` 도 받음).
패널은 그림자 없이 1px 선으로만 분리. 카드 없음.

## 캔버스 (확정 2026-10-02 — 사용자 확인 "좋은데")
위에서 아래로 한 열. 필요한 줄만 보인다.
- 컨트롤 플레인: 한 줄의 작은 상자 4개(kube-apiserver·kube-scheduler·kube-controller-manager·CoreDNS). 상자마다 최근에 한 일(`cp-last`)을 짧게 — 컨트롤 루프의 "결정" 이 여기와 Pod 칩의 이름표(예: `생성 · replicaset-controller`)로 보이고, 자세한 이유는 로그에.
- GitOps 줄(Application 이 있을 때): Git 저장소 → Argo CD Application(Synced/OutOfSync·Healthy·리비전).
- 바깥 줄(Ingress·LoadBalancer 가 있을 때): 바깥 클라이언트·인터넷 → Ingress(호스트·경로 → Service) 상자.
- Service 줄: 노드 밖에 떠 있는 가상 상자(점선 테두리) — "어디에도 없는 주소". 이름·타입·ClusterIP(·NodePort·LB IP)·엔드포인트 ready 수. 고르면 엔드포인트 Pod 로 옅은 선(Overlay).
- 스케줄 대기 줄: 노드가 없는 Pod.
- 노드 = 큰 상자(이름·IP·상태·cpu/memory requests 막대·꺼짐/NotReady 카운트다운). Pod = 노드 안 칩(상태 색, 이름 Mono, IP, 재시작 수, 롤아웃 중 리비전 `r1`·`r2`).
- 부하 막대(부하 발생기가 있을 때): 요청 수·실패 수·마지막 실패.
- 요청(curl)은 움직이는 점으로 경로(DNS → DNAT → 노드 간 → Pod)를 따라간다. 단계 문구는 kubectl 창에.
- 자리 배치는 자동(끌어 놓지 않음).

## 하지 않는 것
전면 카드화, 드롭섀도 남발, 대문자 라벨, 이모지 아이콘, 장식용 그라데이션, 단어 하나만 강조하는 헤드라인.
