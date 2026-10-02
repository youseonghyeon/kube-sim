// 리뷰 5 (2026-10-02, 바깥에서 들어오는 길)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { deployment, ingress, service } from "../src/core/cluster";
import type { Ingress } from "../src/core/api/types";
import { matchIngress } from "../src/core/net/ingress";
import { cluster } from "./helpers";

const NGINX = "registry.k8s.io/ingress-nginx/controller:v1.11.2";
const be = (name: string) => ({ service: { name, port: { number: 80 } } });
const ing = (name: string, spec: Ingress["spec"]): Ingress => ({ apiVersion: "networking.k8s.io/v1", kind: "Ingress", metadata: { name } as Ingress["metadata"], spec, status: { loadBalancer: {} } });

describe("review5 ingress-nginx: Host 가 맞는 server 블록 안에서만 경로를 고른다", () => {
  // 실제 ingress-nginx: host 가 있는 규칙은 그 host 의 server 블록, host 없는 규칙은 기본 server("_") 로 간다.
  // 요청 Host 가 a.com 이면 nginx 는 server a.com 만 보고, 그 안에 맞는 location 이 없으면 server a.com 의 "/" (= 그 Ingress 의
  // defaultBackend, 없으면 기본 백엔드 404) 로 간다. host 없는 규칙·다른 Ingress 의 defaultBackend 는 끼어들지 않는다.
  // sim: matchIngress 가 모든 규칙을 점수(Exact 10000 + 경로 길이 + host 1000)로 한 줄에 세워 host 없는 규칙이 이기거나,
  //      아무 Ingress 의 defaultBackend 를 쓴다.
  // 학습 영향: "다른 팀의 catch-all Ingress 가 내 도메인 요청을 가로챈다" 는 실제와 반대의 동작을 배운다 (그리고 실제 404 를 보면 이해 못 함).
  // 원인: src/core/net/ingress.ts:196-213 matchIngress.
  const hosted = ing("a", { ingressClassName: "nginx", rules: [{ host: "a.com", http: { paths: [{ path: "/api", pathType: "Prefix", backend: be("api") }] } }] });

  test("host 규칙에 맞는 경로가 없으면 host 없는 Prefix / 규칙으로 새지 않는다 (404)", () => {
    const catchAll = ing("b", { ingressClassName: "nginx", rules: [{ http: { paths: [{ path: "/", pathType: "Prefix", backend: be("catch") }] } }] });
    expect(matchIngress([hosted, catchAll], "a.com", "/")?.backend.service.name).toBeUndefined();
  });

  test("host 없는 Exact 규칙이 Host 가 맞는 server 의 Prefix / 를 이기지 않는다", () => {
    const hostlessExact = ing("d", { ingressClassName: "nginx", rules: [{ http: { paths: [{ path: "/x", pathType: "Exact", backend: be("hostless") }] } }] });
    const aRoot = ing("e", { ingressClassName: "nginx", rules: [{ host: "a.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: be("aroot") }] } }] });
    expect(matchIngress([hostlessExact, aRoot], "a.com", "/x")?.backend.service.name).toBe("aroot");
  });

  test("다른 Ingress 의 defaultBackend 는 Host 가 맞는 server 의 빈 경로를 채우지 않는다", () => {
    const def = ing("c", { ingressClassName: "nginx", defaultBackend: be("def") });
    expect(matchIngress([hosted, def], "a.com", "/")?.backend.service.name).toBeUndefined();
  });

  test("끝에서 끝까지: shop.example.com/ 은 catch-all Ingress 의 web 이 아니라 404", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("ingress-nginx-controller", { replicas: 1, image: NGINX, cpu: 100, memory: 128, port: 80 }));
    c.apply(service("ingress-nginx-controller", { selector: { app: "ingress-nginx-controller" }, port: 80, type: "LoadBalancer" }));
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
    c.apply(service("web", { selector: { app: "web" }, port: 80 }));
    c.apply(deployment("api", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
    c.apply(service("api", { selector: { app: "api" }, port: 80 }));
    c.apply(ingress("shop", { className: "nginx", rules: [{ host: "shop.example.com", http: { paths: [{ path: "/api", pathType: "Prefix", backend: be("api") }] } }] }));
    c.apply(ingress("catch-all", { className: "nginx", rules: [{ http: { paths: [{ path: "/", pathType: "Prefix", backend: be("web") }] } }] }));
    c.runFor(20_000);
    expect(c.requestExternal("http://shop.example.com/api").servedBy).toMatch(/^api-/);
    const r = c.requestExternal("http://shop.example.com/");
    expect(r.servedBy, r.output).toMatch(/^ingress-nginx-controller-/);
    expect(r.output).toContain("404 Not Found");
  });
});

describe("review5 ingress-nginx: 쿼리 문자열", () => {
  // 기대(실제 nginx): location 매칭은 URI 의 경로만 본다 — /api?x=1 은 Prefix /api 에 맞는다.
  // 실제(sim): parseTarget 이 "?x=1" 을 path 에 넣고 matchIngress 가 그대로 비교 → /api 규칙을 놓치고 "/" 규칙(shop)으로 간다.
  // 학습 영향: 쿼리를 붙이면 다른 Service 로 간다는 틀린 결론.
  // 원인: src/core/net/request.ts:79-82 parseTarget(쿼리 분리 없음) → src/core/net/ingress.ts:202-203.
  test("/api?x=1 은 Prefix /api 규칙으로 간다", () => {
    const a = ing("a", { ingressClassName: "nginx", rules: [{ host: "a.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: be("shop") }, { path: "/api", pathType: "Prefix", backend: be("api") }] } }] });
    expect(matchIngress([a], "a.com", "/api")?.backend.service.name).toBe("api");
    expect(matchIngress([a], "a.com", "/api?x=1")?.backend.service.name).toBe("api");
  });
});

describe("review5 kube-proxy: 엔드포인트가 없는 바깥 진입점", () => {
  // 기대(실제 kube-proxy): ready 엔드포인트가 없으면 filter 테이블 KUBE-EXTERNAL-SERVICES 에 LoadBalancer IP·NodePort 용 REJECT 도 쓴다
  //       ("default/x has no endpoints" -d <LB IP> … REJECT, --dport <nodePort> … REJECT).
  // 실제(sim): ClusterIP REJECT 한 줄만 있어, 바깥에서 LB IP 로 curl 해 "연결 거부" 를 본 학습자가 iptables-save 에서 그 규칙을 못 찾는다.
  //       (요청 단계 문구도 LB 로 들어왔는데 "ClusterIP:포트 → KUBE-SERVICES REJECT" 라고 쓴다 — request.ts:173)
  // 원인: src/core/net/kubeproxy.ts:107-112 iptablesSave.
  test("엔드포인트 없는 LoadBalancer Service 의 iptables-save 에 LB IP 와 NodePort REJECT 가 있다", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(service("x", { selector: { app: "none" }, port: 80, type: "LoadBalancer", nodePort: 30080 }));
    c.runFor(3000);
    const r = c.requestExternal("http://192.168.0.240/");
    expect(r.output).toMatch(/^curl: \(7\)/);
    const save = c.kubeProxies.get("w1")!.iptablesSave();
    expect(save).toMatch(/-d 192\.168\.0\.240\/32 .*has no endpoints.*REJECT/);
    expect(save).toMatch(/has no endpoints.*--dport 30080 .*REJECT/);
  });
});
