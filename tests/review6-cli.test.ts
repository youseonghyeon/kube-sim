// 리뷰 6 (2026-10-02, GitOps)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { application, deployment, ingress, pdb, service, type Manifest } from "../src/core/cluster";
import { runArgocd } from "../src/core/gitops/cli";
import { cluster } from "./helpers";

const REPO = "https://github.com/youseonghyeon/net-sim.git";
const base = (): Record<string, Manifest> => ({
  "deploy/deployment.yaml": deployment("net-sim", { replicas: 1, image: "ghcr.io/youseonghyeon/net-sim:aaa111", cpu: 10, memory: 16, port: 8080 }),
  "deploy/service.yaml": service("net-sim", { selector: { app: "net-sim" }, port: 8080 }),
});
function setup(automated?: { prune: boolean; selfHeal: boolean }, f = base()) {
  const c = cluster([{ name: "w1" }]);
  c.gitCommit(REPO, f, "first");
  c.apply(application("net-sim", { repoURL: REPO, path: "deploy", automated }));
  c.runFor(15_000);
  return c;
}

describe("review6 argocd CLI", () => {
  // 기대(실제 argocd app diff): 머리줄은 "===== <group>/<Kind> <ns>/<name> ======" — Ingress 는 networking.k8s.io, PDB 는 policy.
  // 실제(sim): Deployment 만 apps 를 붙이고 나머지는 빈 group → "===== /Ingress default/net-sim ======" (Service 의 "/Service" 는 실제와 같음).
  // 학습 영향(낮음): 실제 출력과 모양이 달라 group 개념을 잘못 익힌다. (appGet 의 GROUP 열은 이미 맞게 나온다 — cli.ts 두 곳이 어긋남)
  test("argocd app diff 머리줄의 group 이 실제와 같다 (Ingress·PDB)", () => {
    const c = setup(undefined, {
      ...base(),
      "deploy/ingress.yaml": ingress("net-sim", { className: "nginx", defaultBackend: { service: { name: "net-sim", port: { number: 8080 } } } }),
      "deploy/pdb.yaml": pdb("net-sim", { app: "net-sim" }, { minAvailable: 1 }),
    });
    runArgocd(c, "argocd app sync net-sim");
    c.runFor(5_000);
    c.gitCommit(REPO, base(), "remove ingress and pdb");
    c.argocd.refresh("net-sim");
    c.runFor(1_000);
    const out = runArgocd(c, "argocd app diff net-sim").output;
    expect(out).toContain("===== networking.k8s.io/Ingress default/net-sim ======");
    expect(out).toContain("===== policy/PodDisruptionBudget default/net-sim ======");
  });

  // 기대(실제 argocd app get, printAppSummaryTable): Synced 는 "Synced to main (sha)", OutOfSync 는 "OutOfSync from main (sha)".
  // 실제(sim): "OutOfSync to main (sha)".
  test("argocd app get: OutOfSync 는 'from <target>' 으로 쓴다", () => {
    const c = setup({ prune: true, selfHeal: false });
    c.api.patch("Deployment", "net-sim", "default", "kubectl", (o) => (o.spec.replicas = 3));
    c.runFor(1_000);
    expect(runArgocd(c, "argocd app get net-sim").output).toMatch(/Sync Status:\s+OutOfSync from main \([0-9a-f]{7}\)/);
  });

  // 기대(실제 argocd app set): 자동 sync 가 아닌 앱에 --self-heal·--auto-prune 만 주면
  //   "FATA[0000] Cannot set --self-heal: application not configured with automatic sync" 로 실패한다.
  // 실제(sim): 아무것도 바꾸지 않고 성공(빈 출력, 종료 코드 0)으로 끝난다 — 학습자는 selfHeal 이 켜진 줄 안다.
  test("argocd app set --self-heal 은 Manual 앱에서 실패를 알린다", () => {
    const c = setup(undefined);
    const r = runArgocd(c, "argocd app set net-sim --self-heal");
    expect(c.api.get("Application", "net-sim", "argocd")!.spec.syncPolicy).toBeUndefined();
    expect(r.ok).toBe(false);
    expect(r.output).toContain("application not configured with automatic sync");
  });
});
