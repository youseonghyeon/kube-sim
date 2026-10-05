# kube-sim

쿠버네티스가 왜 이렇게 동작하는지 직접 구성하고 한 단계씩 보며 익히는 학습 시뮬레이터입니다. 브라우저에서 돌고, 실제 클러스터에 연결하지 않으며, 모든 동작은 결정론적입니다. 자매 프로젝트: [net-sim](../net-sim) (네트워크).

- 지금 상태 (2026-10-02): [로드맵](docs/ROADMAP.md) 0~4·6단계 완료 — 컨트롤 루프(Deployment·ReplicaSet·스케줄러·kubelet), 노드 장애, Service 네트워킹(kube-proxy iptables·CoreDNS·readiness), 롤링 업데이트·종료·PDB/drain, LoadBalancer·Ingress·Tailscale funnel, Argo CD 식 GitOps. 남은 것은 5단계(운영).
- 예제: 상단바의 예제 메뉴에서 고르면 노드·매니페스트가 깔리고, 인스펙터의 "해 볼 것" 버튼으로 시나리오를 돌립니다. 아래 서랍에 `kubectl`·`curl`·`argocd`·`git` 을 칠 수 있습니다.
- 실행: `npm install && npm run dev` → http://localhost:5173
- 검증: `npm run typecheck` · `npm test` · `npm run ui-check` · `npm run perf-check`
- 작업 지침: [AGENTS.md](AGENTS.md) — 에이전트는 여기부터 읽습니다 (`CLAUDE.md` 가 이것을 불러옵니다).
- 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · 디자인: [DESIGN.md](DESIGN.md) · 교훈: [docs/LESSONS.md](docs/LESSONS.md) · 문제 해결: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- 스택: TypeScript + Vite + Preact + vitest + Playwright
- 배포: `main` 에 push 하면 GitHub Actions 가 `tsc` + vitest 게이트를 지난 뒤 이미지를 `ghcr.io/youseonghyeon/kube-sim:<sha>` 로 올리고 `deploy/values.yaml` 의 태그를 봇 커밋으로 갱신합니다. ArgoCD(`argocd/application.yaml`, 한 번만 `kubectl apply`)가 `deploy/` Helm 차트를 `app` 네임스페이스에 자동 sync 합니다. 주소는 Tailscale funnel → `https://kube-sim.<tailnet>.ts.net`.
