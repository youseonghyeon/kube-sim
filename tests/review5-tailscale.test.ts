// 리뷰 5 (2026-10-02, 바깥에서 들어오는 길)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { deployment, ingress, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const backend = { service: { name: "net-sim", port: { number: 8080 } } };

function tsCluster(tls: string[] = ["net-sim"]) {
  const c = cluster([{ name: "w1" }, { name: "w2" }]);
  c.apply(deployment("net-sim", { replicas: 1, image: "ghcr.io/youseonghyeon/net-sim:latest", cpu: 10, memory: 16, port: 8080 }));
  c.apply(service("net-sim", { selector: { app: "net-sim" }, port: 8080 }));
  c.apply(ingress("net-sim", { className: "tailscale", defaultBackend: backend, tls, annotations: { "tailscale.com/funnel": "true" } }));
  c.runFor(20_000);
  return c;
}

describe("review5 Tailscale 오퍼레이터", () => {
  // 기대(실제 operator): Ingress 가 더 이상 tailscale 클래스가 아니면 프록시(StatefulSet)와 tailnet 기기를 정리한다 (maybeCleanup).
  // 실제(sim): TailscaleOperator.reconcile 이 클래스가 아니면 그냥 return — ts-net-sim Deployment·Pod 가 Ingress 가 지워질 때까지 남는다.
  // 학습 영향: 클래스를 nginx 로 옮긴 뒤에도 프록시 Pod 가 캔버스에 계속 돌아 "아직 tailscale 이 처리하나?" 혼란.
  // 원인: src/core/net/ingress.ts:157.
  test("ingressClassName 을 tailscale → nginx 로 바꾸면 프록시가 사라진다", () => {
    const c = tsCluster();
    expect(c.api.get("Deployment", "ts-net-sim")).toBeDefined();
    c.apply(ingress("net-sim", { className: "nginx", defaultBackend: backend }));
    c.runFor(20_000);
    expect(c.api.get("Deployment", "ts-net-sim")).toBeUndefined();
    expect(pods(c).some((p) => p.metadata.name.startsWith("ts-net-sim-"))).toBe(false);
  });

  // 기대(실제 operator): 자기가 만든 프록시(StatefulSet)를 watch 하므로, 사용자가 지우면 다시 만든다.
  // 실제(sim): Deployment 를 watch 하지 않아 Ingress 가 바뀔 때까지 프록시가 없다 — ADDRESS 는 그대로 *.ts.net 이라 funnel 요청은 시간 초과.
  // 학습 영향: "오퍼레이터가 원하는 상태를 계속 맞춘다(reconcile)" 는 이 프로젝트의 핵심 교훈과 반대.
  // 원인: src/core/net/ingress.ts:149-152 (Ingress 만 watch).
  test("프록시 Deployment 를 지우면 오퍼레이터가 다시 만든다", () => {
    const c = tsCluster();
    runKubectl(c, "delete deployment ts-net-sim");
    c.runFor(20_000);
    expect(c.api.get("Deployment", "ts-net-sim")).toBeDefined();
    expect(c.requestExternal("https://net-sim.tailnet-1234.ts.net/").ok).toBe(true);
  });

  // 기대(실제 operator, hostnameForIngress): tls.hosts[0] 의 첫 라벨만 기기 이름으로 쓴다 — "net-sim.example.com" → net-sim.<tailnet>.ts.net.
  // 실제(sim): hostOf 가 tls 호스트 전체를 써서 ADDRESS 가 net-sim.example.com.tailnet-1234.ts.net.
  // 학습 영향: 사용자의 실제 매니페스트(FQDN 을 적는 경우)와 다른 주소를 배운다. (추정 근거: tailscale operator 소스 — 확인 필요)
  // 원인: src/core/net/ingress.ts:191-193.
  test("tls.hosts 에 FQDN 을 적어도 기기 이름은 첫 라벨", () => {
    const c = tsCluster(["net-sim.example.com"]);
    expect(runKubectl(c, "get ingress net-sim").output).toMatch(/\snet-sim\.tailnet-1234\.ts\.net\s/);
  });

  // 기대(실제): tailnet 기기 이름은 겹칠 수 없어 두 번째 기기는 net-sim-1 같은 이름을 받고, 오퍼레이터는 실제 이름을 ADDRESS 에 적는다.
  // 실제(sim): 두 Ingress 의 ADDRESS 가 똑같이 net-sim.tailnet-1234.ts.net — funnel 은 그중 첫 Ingress 로만 간다.
  // 원인: src/core/net/ingress.ts:178 (이름 중복 검사 없음), request.ts:405.
  test("같은 tls 호스트를 쓰는 두 tailscale Ingress 의 ADDRESS 는 서로 다르다", () => {
    const c = tsCluster();
    c.apply(ingress("other", { className: "tailscale", defaultBackend: backend, tls: ["net-sim"] }));
    c.runFor(20_000);
    const a = c.api.get("Ingress", "net-sim")!.status.loadBalancer.ingress?.[0]?.hostname;
    const b = c.api.get("Ingress", "other")!.status.loadBalancer.ingress?.[0]?.hostname;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });
});
