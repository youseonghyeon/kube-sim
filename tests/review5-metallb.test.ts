// 리뷰 5 (2026-10-02, 바깥에서 들어오는 길)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster } from "./helpers";

describe("review5 MetalLB IP 풀", () => {
  function fullPool() {
    const c = cluster([{ name: "w1" }]);
    for (let i = 0; i < 12; i++) c.apply(service(`lb${i}`, { selector: { app: "x" }, port: 80, type: "LoadBalancer" }));
    c.runFor(2000);
    expect(runKubectl(c, "get svc lb11").output).toMatch(/<pending>/);
    return c;
  }

  // 기대(실제 MetalLB): Service 가 지워져 IP 가 풀에 돌아오면 controller 가 모든 Service 를 다시 처리(SyncStateReprocessAll)해
  //       <pending> 이던 lb11 이 그 IP 를 받는다.
  // 실제(sim): MetalLB 는 지워진 Service 의 키만 reconcile 하고 끝나 lb11 은 노드 이벤트가 생길 때까지 영원히 <pending>.
  // 학습 영향: "풀이 차면 pending → 하나 지우면 풀린다" 를 해 본 학습자가 IP 가 안 풀리는 것을 보고 MetalLB 를 오해한다.
  // 원인: src/core/net/ingress.ts MetalLB.reconcile (63-71행) — 반납 뒤 pending Service 를 다시 큐에 넣지 않음.
  test("LoadBalancer Service 를 지우면 <pending> 이던 Service 가 풀린 IP 를 받는다", () => {
    const c = fullPool();
    runKubectl(c, "delete svc lb3");
    c.runFor(5000);
    expect(runKubectl(c, "get svc lb11").output.split("\n")[1]).toMatch(/LoadBalancer\s+\S+\s+192\.168\.0\.24\d/);
  });

  // 같은 원인: type 을 ClusterIP 로 바꿔 IP 를 반납해도 <pending> Service 가 받지 못한다.
  test("LoadBalancer → ClusterIP 로 IP 를 반납하면 <pending> 이던 Service 가 그 IP 를 받는다", () => {
    const c = fullPool();
    runKubectl(c, `patch svc lb0 -p '{"spec":{"type":"ClusterIP"}}'`);
    c.runFor(5000);
    expect(runKubectl(c, "get svc lb0").output).toMatch(/ClusterIP\s+\S+\s+<none>/);
    expect(c.api.get("Service", "lb11")!.status.loadBalancer?.ingress?.[0]?.ip).toBe("192.168.0.240");
  });
});
