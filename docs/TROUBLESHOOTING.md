# 문제 해결 — 화면·로그에 보이는 실패 문구

사용자가 보는 실패 문구 → 원인 → 고치는 법. 새 실패 문구를 코드에 넣으면 여기도 같이 갱신한다(문구는 실제 kubectl 출력과 같게).
기능이 생기는 대로 단계별 절로 나눈다. 아래는 형식과, 1단계에서 들어올 예정인 항목이다.

## 스케줄링·Pod 수명주기 (1단계 예정)

| 증상 / 로그 문구 | 원인 | 고치는 법 |
|---|---|---|
| Pod 가 `Pending`, 이벤트 `FailedScheduling: 0/3 nodes are available: 3 Insufficient cpu.` | requests 를 채울 자리가 있는 노드가 없음 | requests 를 줄이거나 노드를 늘리거나 다른 Pod 를 줄인다 |
| `ImagePullBackOff` / `ErrImagePull` | 이미지 이름·태그가 틀렸거나 레지스트리에 없음 | 이미지 이름·태그를 고친다 (kubelet 은 백오프하며 다시 시도) |
| `CrashLoopBackOff`, 이벤트 `Back-off restarting failed container` | 컨테이너가 시작 직후 계속 종료됨 — 재시작 간격이 10초부터 두 배씩(최대 5분) 늘어난다 | 앱의 시작 실패 원인을 고친다. 고친 뒤에도 남은 백오프 시간만큼 기다린다 |
| 노드를 끊었는데 Pod 가 5분 동안 그대로 `Running` 으로 보임 | 노드가 NotReady 가 되면 taint 가 붙고, Pod 의 기본 toleration(300초)이 끝나야 eviction 된다 | 정상. 빨리 옮기려면 toleration 을 줄이거나 `kubectl drain` |
