// 리뷰 6 (2026-10-02, GitOps)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { expect, test } from "vitest";
import { exampleById } from "../src/model/examples";
import { sim } from "../src/model/sim";
import { clusterDef, exampleId } from "../src/model/store";

// 문구(examples.ts gitops "손으로 sync"): "Git 대로 되돌리고 Synced 가 됩니다."
// 실제(sim): 앞 단계 "Git 에서 ingress.yaml 지우기" 뒤에 Refresh 단계가 없어(문구로만 권함) Argo CD 는 아직 옛 리비전을 보고,
//   수동 sync 가 그 옛 리비전(ingress.yaml 이 있던 것)을 적용한다 → Ingress 를 "unchanged" 로 다시 적용하고 "Synced" — Git HEAD 와 다르다.
//   (실제 Argo CD 라면 수동 sync 가 HEAD 를 풀어 Ingress 는 "ignored (requires pruning)" 로 OutOfSync 가 남는다 — review6-argocd 의 수동 sync 결함과 같은 뿌리)
// 학습 영향: "Git 대로" 라고 했는데 Git 에서 지운 Ingress 와 ts-net-sim 프록시가 그대로 있다. 예제에 Refresh 단계를 넣거나 sync 가 HEAD 를 쓰게 고쳐야 한다.
test("gitops 예제를 순서대로 따라가면 '손으로 sync' 뒤 Git HEAD 와 같다", () => {
  const ex = exampleById("gitops")!;
  exampleId.value = "gitops";
  clusterDef.value = ex.build();
  sim.reset();
  const c = sim.cluster;
  c.runFor(20_000);
  for (const t of ex.tries) {
    if (t.action) expect(sim.runAction(t.action)).toBeUndefined();
    else if (t.command) expect(sim.kubectl(t.command).ok).toBe(!t.expectFail);
    c.runFor(10_000);
  }
  const head = [...c.git.values()][0]!.head!;
  expect(head.files["deploy/ingress.yaml"]).toBeUndefined(); // Git 에서는 지웠다
  const app = c.api.get("Application", "net-sim", "argocd")!;
  expect(app.status.sync.status).toBe("Synced");
  expect(app.status.sync.revision).toBe(head.sha);
});
