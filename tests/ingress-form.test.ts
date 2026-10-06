// 화면에서 Ingress 만들기·고치기 (인스펙터 폼 ↔ 매니페스트) — 만든 Ingress 가 실제로 요청을 받는지까지.
import { describe, expect, test } from "vitest";
import { deployment, service } from "../src/core/cluster";
import { DefSync } from "../src/model/defSync";
import { buildRules, flattenRules, hostError, ingressNginxManifests, newIngress, pathError, setRules } from "../src/model/ingressForm";

const nodes = [{ name: "worker-1", cpu: 2000, memory: 4096 }, { name: "worker-2", cpu: 2000, memory: 4096 }];
const web = [deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }), service("web", { selector: { app: "web" }, port: 80 })];

describe("규칙 펴기·묶기", () => {
  test("같은 Host 의 경로는 다시 한 rule 로 묶이고, 빈 Host 는 host 필드가 없다", () => {
    const rows = [
      { host: "a.example.com", path: "/", pathType: "Prefix" as const, service: "web", port: 80 },
      { host: "", path: "/x", pathType: "Prefix" as const, service: "api", port: 8080 },
      { host: "a.example.com", path: "/api", pathType: "Prefix" as const, service: "api", port: 8080 },
    ];
    const rules = buildRules(rows)!;
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ host: "a.example.com", http: { paths: [{ path: "/" }, { path: "/api" }] } });
    expect(rules[1]).not.toHaveProperty("host");
    const m = newIngress("x", [{ name: "web", port: 80 }], new Set(), true)!;
    setRules(m, rows);
    expect(flattenRules(m)).toEqual([rows[0], rows[2], rows[1]]);
    setRules(m, []);
    expect(m.spec.rules).toBeUndefined();
  });

  test("Host·경로 검사 문구", () => {
    expect(hostError("")).toBeUndefined();
    expect(hostError("shop.example.com")).toBeUndefined();
    expect(hostError("Shop.Example.com")).toContain("소문자");
    expect(hostError("192.168.0.240")).toContain("IP");
    expect(pathError("api")).toContain("/ 로 시작");
  });
});

describe("+ Ingress 로 만든 것이 실제로 요청을 받는다", () => {
  test("ingress-nginx 가 없으면 tailscale 클래스 — 설치 없이 주소가 붙고 바깥에서 닿는다", () => {
    const m = newIngress("web", [{ name: "web", port: 80 }], new Set(), false)!;
    expect(m.spec.ingressClassName).toBe("tailscale");
    const s = new DefSync();
    s.reset({ nodes, manifests: [...web, m] }, "x");
    s.cluster.runFor(30_000);
    const addr = s.cluster.api.get("Ingress", "web")!.status.loadBalancer.ingress?.[0]?.hostname;
    expect(addr).toMatch(/^web\..+\.ts\.net$/);
  });

  test("nginx 클래스는 컨트롤러가 없으면 주소가 없고, 'ingress-nginx 설치' 뒤에는 Host 로 닿는다", () => {
    const m = newIngress("web", [{ name: "web", port: 80 }], new Set(), true)!;
    expect(m.spec.ingressClassName).toBe("nginx");
    expect(m.spec.rules?.[0]?.host).toBe("web.example.com");
    const s = new DefSync();
    s.reset({ nodes, manifests: [...web, m] }, "x");
    s.cluster.runFor(30_000);
    expect(s.cluster.api.get("Ingress", "web")!.status.loadBalancer.ingress).toBeUndefined();
    s.sync({ nodes, manifests: [...web, m, ...ingressNginxManifests()] });
    s.cluster.runFor(30_000);
    expect(s.cluster.api.get("Ingress", "web")!.status.loadBalancer.ingress?.[0]?.ip).toBe("192.168.0.240");
    const r = s.cluster.requestExternal("http://web.example.com/");
    expect(r.ok).toBe(true);
    expect(r.servedBy).toMatch(/^web-/);
  });

  test("ingress-nginx 의 Service 는 고르지 않고, 아직 아무 Ingress 도 가리키지 않는 Service 를 먼저 고른다", () => {
    const svcs = [{ name: "ingress-nginx-controller", port: 80 }, { name: "web", port: 80 }, { name: "api", port: 8080 }];
    expect(newIngress("x", svcs, new Set(["web"]), true)!.spec.rules?.[0]?.http.paths[0]?.backend.service).toEqual({ name: "api", port: { number: 8080 } });
    expect(newIngress("x", [{ name: "ingress-nginx-controller", port: 80 }], new Set(), true)).toBeUndefined();
  });
});

test("LoadBalancer Service 를 막 만든 직후(kube-proxy 규칙 전)의 실패는 포트 탓으로 말하지 않는다", () => {
  const s = new DefSync();
  s.reset({ nodes, manifests: [...web, ...ingressNginxManifests()] }, "x");
  s.cluster.runFor(10_000);
  s.sync({ nodes, manifests: [...web, ...ingressNginxManifests(), service("web-lb", { selector: { app: "web" }, port: 80, type: "LoadBalancer" })] });
  s.cluster.runFor(100);
  const ip = s.cluster.api.get("Service", "web-lb")!.status.loadBalancer?.ingress?.[0]?.ip;
  expect(ip).toBeDefined();
  const r = s.cluster.requestExternal(`http://${ip}/`);
  expect(r.ok).toBe(false);
  expect(r.steps.at(-1)!.text).toContain("kube-proxy 가 이 노드에 규칙을 쓰기 전");
});
