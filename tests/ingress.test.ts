import { describe, expect, test } from "vitest";
import { deployment, ingress, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { CLIENT_IP } from "../src/core/net/request";
import { cluster, pods } from "./helpers";

const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);
const NGINX = "registry.k8s.io/ingress-nginx/controller:v1.11.2";

function nginxCluster(etp: "Cluster" | "Local" = "Cluster") {
  const c = cluster([{ name: "w1" }, { name: "w2" }, { name: "w3" }]);
  c.apply(deployment("ingress-nginx-controller", { replicas: 1, image: NGINX, cpu: 100, memory: 128, port: 80, nodeSelector: { "kubernetes.io/hostname": "w1" } }));
  c.apply(service("ingress-nginx-controller", { selector: { app: "ingress-nginx-controller" }, port: 80, type: "LoadBalancer", externalTrafficPolicy: etp }));
  c.apply(deployment("shop", { replicas: 2, image: "traefik/whoami:v1.10", cpu: 100, memory: 64, port: 80 }));
  c.apply(service("shop", { selector: { app: "shop" }, port: 80 }));
  c.apply(deployment("api", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
  c.apply(service("api", { selector: { app: "api" }, port: 80 }));
  c.apply(
    ingress("shop", {
      className: "nginx",
      rules: [
        { host: "shop.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "shop", port: { number: 80 } } } }] } },
        { host: "shop.example.com", http: { paths: [{ path: "/api", pathType: "Prefix", backend: { service: { name: "api", port: { number: 80 } } } }] } },
      ],
    }),
  );
  c.runFor(20_000);
  return c;
}

describe("LoadBalancer (MetalLB L2)", () => {
  test("주소 풀에서 IP 를 받고 노드 하나가 맡는다, get svc 의 EXTERNAL-IP", () => {
    const c = nginxCluster();
    const svc = c.api.get("Service", "ingress-nginx-controller")!;
    expect(svc.status.loadBalancer?.ingress?.[0]?.ip).toBe("192.168.0.240");
    expect(svc.spec.ports[0]!.nodePort).toBeGreaterThanOrEqual(30000);
    expect(k(c, "get svc ingress-nginx-controller").output.split("\n")[1]).toMatch(/LoadBalancer\s+10\.96\.0\.\d+\s+192\.168\.0\.240\s+80:3\d{4}\/TCP/);
    expect(c.metallb.announcer("default", "ingress-nginx-controller")).toMatch(/^w[123]$/);
    expect(c.api.eventsFor(svc.metadata.uid).map((e) => e.reason)).toEqual(expect.arrayContaining(["IPAllocated", "nodeAssigned"]));
  });

  test("맡은 노드가 꺼지면 다른 노드가 이어받는다", () => {
    const c = nginxCluster();
    const first = c.metallb.announcer("default", "ingress-nginx-controller")!;
    c.setNodePower(first, false);
    c.runFor(1000);
    const next = c.metallb.announcer("default", "ingress-nginx-controller");
    expect(next).toBeDefined();
    expect(next).not.toBe(first);
  });

  test("풀이 다 차면 <pending>", () => {
    const c = cluster([{ name: "w1" }]);
    for (let i = 0; i < 12; i++) c.apply(service(`lb${i}`, { selector: { app: "x" }, port: 80, type: "LoadBalancer" }));
    c.runFor(2000);
    expect(k(c, "get svc lb11").output.split("\n")[1]).toMatch(/LoadBalancer\s+\S+\s+<pending>/);
  });
});

describe("Ingress (ingress-nginx)", () => {
  test("ADDRESS 는 컨트롤러 Service 의 LoadBalancer IP, get/describe ingress", () => {
    const c = nginxCluster();
    expect(k(c, "get ingress").output).toMatch(/^NAME\s+CLASS\s+HOSTS\s+ADDRESS\s+PORTS\s+AGE\nshop\s+nginx\s+shop\.example\.com\s+192\.168\.0\.240\s+80\s+\d+s$/);
    const d = k(c, "describe ingress shop").output;
    expect(d).toMatch(/Ingress Class:\s+nginx/);
    expect(d).toMatch(/shop\.example\.com\n\s+\/\s+shop:80 \(10\.244\.\d\.\d+:80,10\.244\.\d\.\d+:80\)/);
  });

  test("바깥에서 Host 로 들어와 경로대로 나뉜다 (/ → shop, /api → api), 없는 호스트는 DNS 실패", () => {
    const c = nginxCluster();
    const a = c.requestExternal("http://shop.example.com/");
    expect(a.ok, a.output).toBe(true);
    expect(a.servedBy).toMatch(/^shop-/);
    expect(a.steps.map((s) => s.kind)).toEqual(["dns", "route", "dnat", "route", "dnat", "route", "response"]);
    const b = c.requestExternal("http://shop.example.com/api/items");
    expect(b.servedBy).toMatch(/^api-/);
    expect(c.requestExternal("http://nope.example.com/").output).toBe("curl: (6) Could not resolve host: nope.example.com");
  });

  test("Host 가 규칙에 없으면 ingress-nginx 의 404", () => {
    const c = nginxCluster();
    const r = c.requestExternal("http://192.168.0.240/");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("404 Not Found");
  });

  test("Cluster 정책: 앱이 보는 X-Forwarded-For 가 노드 IP (클라이언트 IP 사라짐)", () => {
    const c = nginxCluster("Cluster");
    const r = c.requestExternal("http://shop.example.com/");
    expect(r.forwardedFor).toMatch(/^192\.168\.0\.1\d$/);
    expect(r.seenSource).toMatch(/^10\.244\./); // 앱이 보는 출발지는 ingress-nginx Pod
  });

  test("Local 정책: X-Forwarded-For 에 원래 클라이언트 IP, Pod 가 있는 노드만 IP 를 맡는다", () => {
    const c = nginxCluster("Local");
    expect(c.metallb.announcer("default", "ingress-nginx-controller")).toBe("w1");
    const r = c.requestExternal("http://shop.example.com/");
    expect(r.ok, r.output).toBe(true);
    expect(r.forwardedFor).toBe(CLIENT_IP);
    expect(r.output).toContain(`X-Forwarded-For: ${CLIENT_IP}`);
  });

  test("kubectl create ingress 와 패치로 Local 전환", () => {
    const c = nginxCluster();
    expect(k(c, 'create ingress api --class=nginx --rule="api.example.com/*=api:80"').output).toBe("ingress.networking.k8s.io/api created");
    c.runFor(2000);
    expect(c.requestExternal("http://api.example.com/").servedBy).toMatch(/^api-/);
    expect(k(c, `patch svc ingress-nginx-controller -p '{"spec":{"externalTrafficPolicy":"Local"}}'`).output).toBe("service/ingress-nginx-controller patched");
    c.runFor(3000);
    expect(c.requestExternal("http://shop.example.com/").forwardedFor).toBe(CLIENT_IP);
    expect(k(c, `patch svc shop -p '{"spec":{"externalTrafficPolicy":"Local"}}'`).output).toMatch(/may only be set for externally-accessible services/);
  });
});

describe("externalTrafficPolicy (NodePort·LoadBalancer 직접)", () => {
  function whoami(etp: "Cluster" | "Local") {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("who", { replicas: 1, image: "traefik/whoami:v1.10", cpu: 100, memory: 64, port: 80, nodeSelector: { "kubernetes.io/hostname": "w2" } }));
    c.apply(service("who", { selector: { app: "who" }, port: 80, type: "LoadBalancer", externalTrafficPolicy: etp }));
    c.runFor(15_000);
    return c;
  }

  test("Cluster: 앱은 노드 IP 를 본다 (SNAT), Pod 가 없는 노드의 NodePort 로도 닿는다", () => {
    const c = whoami("Cluster");
    const np = c.api.get("Service", "who")!.spec.ports[0]!.nodePort!;
    const r = c.requestNodePort("w1", np);
    expect(r.ok).toBe(true);
    expect(r.seenSource).toBe("192.168.0.11");
    expect(r.output).toContain("RemoteAddr: 192.168.0.11:");
  });

  test("Local: 앱이 클라이언트 IP 를 본다, Pod 가 없는 노드의 NodePort 는 버린다, IP 는 Pod 가 있는 노드가 맡는다", () => {
    const c = whoami("Local");
    const np = c.api.get("Service", "who")!.spec.ports[0]!.nodePort!;
    expect(c.requestNodePort("w1", np).output).toMatch(/^curl: \(28\)/);
    const r = c.requestNodePort("w2", np);
    expect(r.seenSource).toBe(CLIENT_IP);
    expect(c.metallb.announcer("default", "who")).toBe("w2");
    expect(c.requestExternal(`http://${c.api.get("Service", "who")!.status.loadBalancer!.ingress![0]!.ip}/`).seenSource).toBe(CLIENT_IP);
    expect(c.kubeProxies.get("w1")!.iptablesSave()).toContain('"default/who has no local endpoints" -j KUBE-MARK-DROP');
  });

  test("Local 인데 Pod 가 옮겨 가면 맡는 노드도 따라간다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    k(c, "cordon w1");
    c.apply(deployment("who", { replicas: 1, image: "traefik/whoami:v1.10", cpu: 100, memory: 64, port: 80 }));
    c.apply(service("who", { selector: { app: "who" }, port: 80, type: "LoadBalancer", externalTrafficPolicy: "Local" }));
    c.runFor(15_000);
    expect(c.metallb.announcer("default", "who")).toBe("w2");
    const p = pods(c)[0]!.metadata.name;
    k(c, "uncordon w1");
    k(c, "cordon w2");
    k(c, `delete pod ${p}`);
    c.runFor(20_000);
    expect(pods(c).find((x) => x.metadata.deletionTimestamp === undefined)!.spec.nodeName).toBe("w1");
    expect(c.metallb.announcer("default", "who")).toBe("w1");
  });
});

describe("Tailscale Ingress (funnel)", () => {
  function tsCluster(funnel: boolean) {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("net-sim", { replicas: 1, image: "ghcr.io/youseonghyeon/net-sim:latest", cpu: 10, memory: 16, port: 8080 }));
    c.apply(service("net-sim", { selector: { app: "net-sim" }, port: 8080 }));
    c.apply(ingress("net-sim", { className: "tailscale", defaultBackend: { service: { name: "net-sim", port: { number: 8080 } } }, tls: ["net-sim"], annotations: funnel ? { "tailscale.com/funnel": "true" } : undefined }));
    c.runFor(20_000);
    return c;
  }

  test("오퍼레이터가 프록시 Pod 를 띄우고 ADDRESS 에 tailnet 이름", () => {
    const c = tsCluster(true);
    expect(pods(c).some((p) => p.metadata.name.startsWith("ts-net-sim-"))).toBe(true);
    expect(k(c, "get ingress").output).toMatch(/net-sim\s+tailscale\s+\*\s+net-sim\.tailnet-1234\.ts\.net\s+80, 443/);
  });

  test("funnel: 인터넷 → 중계 → 프록시 Pod → Service ClusterIP → Pod (NodePort·LB 없이)", () => {
    const c = tsCluster(true);
    const r = c.requestExternal("https://net-sim.tailnet-1234.ts.net/");
    expect(r.ok, r.output).toBe(true);
    expect(r.servedBy).toMatch(/^net-sim-/);
    expect(r.output).toContain("<title>net-sim</title>");
    expect(r.forwardedFor).toBe(CLIENT_IP);
    expect(r.steps.some((s) => s.actor === "tailscale-funnel")).toBe(true);
    expect(r.steps.some((s) => s.kind === "dnat" && s.actor.startsWith("iptables@"))).toBe(true); // 프록시 → ClusterIP 는 kube-proxy 규칙을 탄다
  });

  test("funnel 이 꺼지면 공인 인터넷에서는 닿지 않는다", () => {
    const c = tsCluster(false);
    expect(c.requestExternal("https://net-sim.tailnet-1234.ts.net/").output).toBe("curl: (6) Could not resolve host: net-sim.tailnet-1234.ts.net");
  });

  test("Ingress 를 지우면 프록시도 지워진다 (ownerReferences)", () => {
    const c = tsCluster(true);
    k(c, "delete ingress net-sim");
    c.runFor(10_000);
    expect(pods(c).some((p) => p.metadata.name.startsWith("ts-"))).toBe(false);
  });
});
