# kube-sim

쿠버네티스가 왜 이렇게 동작하는지 직접 구성하고 한 단계씩 보며 익히는 학습 시뮬레이터입니다. 브라우저에서 돌고, 실제 클러스터에 연결하지 않으며, 모든 동작은 결정론적입니다. 자매 프로젝트: [net-sim](../net-sim) (네트워크).

- 지금 상태: 문서만 준비됨 (2026-10-02). 다음 할 일은 [docs/ROADMAP.md](docs/ROADMAP.md) 의 0단계(골격)입니다.
- 작업 지침: [AGENTS.md](AGENTS.md) — 에이전트는 여기부터 읽습니다 (`CLAUDE.md` 가 이것을 불러옵니다).
- 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 디자인: [DESIGN.md](DESIGN.md) · 교훈: [docs/LESSONS.md](docs/LESSONS.md) · 문제 해결: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- 스택: TypeScript + Vite + Preact + vitest + Playwright
