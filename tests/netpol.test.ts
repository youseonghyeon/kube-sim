// 5c: NetworkPolicy — 고르면 격리, 허용은 더하기, 막히면 DROP(시간 초과), egress 는 DNS 부터, DNAT 뒤 포트로 판단.
import { describe, expect, test } from "vitest";
import { deployment, ingress, networkPolicy, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const live = (c: C, app: string) => pods(c).filter((p) => p.metadata.labels.app === app && p.metadata.deletionTimestamp === undefined);
const curl = (c: C, from: string, target: string) => c.requestFromPod(live(c, from)[0]!.metadata.name, "curl", target);

function base(c: C) {
  c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 50, memory: 32, port: 80 }));
  c.apply(service("web", { selector: { app: "web" }, port: 80 }));
  c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
  c.apply(deployment("other", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
  c.runFor(10_000);
}
const denyWeb = networkPolicy("deny-web", { podSelector: { matchLabels: { app: "web" } }, policyTypes: ["Ingress"] });
const allowClient = networkPolicy("allow-client", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: "client" } } }], ports: [{ protocol: "TCP", port: 80 }] }] });

describe("기본 허용 → 고르면 격리, 허용은 더하기", () => {
  test("정책 없으면 다 된다 · deny 하나로 DROP(시간 초과) · allow 를 더하면 client 만 · deny 를 지워도 allow 가 고르면 여전히 격리", () => {
    const c = cluster();
    base(c);
    expect(curl(c, "client", "http://web").ok).toBe(true);
    expect(curl(c, "other", "http://web").ok).toBe(true);
    c.apply(denyWeb);
    const r = curl(c, "client", "http://web");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("curl: (28) Failed to connect to web port 80 after 130000 ms: Connection timed out");
    expect(r.steps.at(-1)!.text).toMatch(/의 ingress\(들어오는 쪽\) 가 NetworkPolicy deny-web 로 격리됨 .*→ DROP \(거부가 아니라 버림 → 시간 초과\)/);
    expect(r.steps.at(-1)!.actor).toMatch(/^kube-router@worker-\d$/);
    c.apply(allowClient);
    const ok = curl(c, "client", "http://web");
    expect(ok.ok).toBe(true);
    expect(ok.steps.some((s) => s.text.includes("ingress 를 allow-client 가 허용"))).toBe(true);
    expect(curl(c, "other", "http://web").ok).toBe(false);
    kubectl(c, "kubectl delete networkpolicy deny-web");
    expect(curl(c, "other", "http://web").ok).toBe(false); // allow-client 도 web 을 고른다 → 여전히 격리
    kubectl(c, "kubectl delete netpol allow-client");
    expect(curl(c, "other", "http://web").ok).toBe(true);
  });

  test("포트가 있는 규칙은 ICMP 를 허용하지 않는다 (ping 은 시간 초과)", () => {
    const c = cluster();
    base(c);
    c.apply(allowClient);
    const ip = live(c, "web")[0]!.status.podIP!;
    expect(c.requestFromPod(live(c, "client")[0]!.metadata.name, "ping", ip).ok).toBe(false);
    expect(curl(c, "client", `http://${ip}`).ok).toBe(true);
  });
});

describe("egress — DNS 부터 막힌다, 정책은 DNAT 뒤 포트로", () => {
  const setup = () => {
    const c = cluster();
    c.apply(deployment("api", { replicas: 1, image: "example/api:1.1", cpu: 50, memory: 32, port: 8080 }));
    c.apply(service("api", { selector: { app: "api" }, port: 80, targetPort: 8080 }));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
    c.runFor(15_000);
    return c;
  };
  const egressTo = (port: number) => networkPolicy("client-egress", { podSelector: { matchLabels: { app: "client" } }, policyTypes: ["Egress"], egress: [{ to: [{ podSelector: { matchLabels: { app: "api" } } }], ports: [{ port }] }] });
  const allowDns = networkPolicy("allow-dns", {
    podSelector: { matchLabels: { app: "client" } },
    policyTypes: ["Egress"],
    egress: [{ to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "kube-dns" } } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }],
  });

  test("api 로만 열면 이름부터 못 푼다 → DNS 허용 → Service 포트(80)로 연 정책은 targetPort(8080)라 막힘 → 8080 으로 고치면 됨", () => {
    const c = setup();
    expect(curl(c, "client", "http://api").ok).toBe(true);
    c.apply(egressTo(8080));
    const r = curl(c, "client", "http://api");
    expect(r.output).toBe("curl: (6) Could not resolve host: api");
    expect(r.steps[0]!.text).toContain("CoreDNS(10.96.0.10 → kube-system 의 k8s-app=kube-dns, UDP 53)로 가는 허용 규칙이 없음 → DNS 질의 DROP");
    expect(c.requestFromPod(live(c, "client")[0]!.metadata.name, "nslookup", "api").output).toBe(";; connection timed out; no servers could be reached");
    c.apply(allowDns);
    expect(curl(c, "client", "http://api").ok).toBe(true);
    c.apply(egressTo(80));
    const r80 = curl(c, "client", "http://api");
    expect(r80.ok).toBe(false);
    expect(r80.steps.at(-1)!.text).toContain("의 egress(나가는 쪽) 가 NetworkPolicy client-egress, allow-dns 로 격리됨");
    expect(r80.steps.at(-1)!.text).toContain(":8080");
  });
});

describe("Ingress 컨트롤러와 노드", () => {
  test("shop 은 ingress-nginx 에서 온 것만: 바깥 → Ingress 는 되고, client 가 직접 오면 막힘", () => {
    const c = cluster();
    c.apply(deployment("ingress-nginx-controller", { replicas: 1, image: "registry.k8s.io/ingress-nginx/controller:v1.11.2", cpu: 100, memory: 128, port: 80 }));
    c.apply(service("ingress-nginx-controller", { selector: { app: "ingress-nginx-controller" }, port: 80, type: "LoadBalancer" }));
    c.apply(deployment("shop", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, port: 80 }));
    c.apply(service("shop", { selector: { app: "shop" }, port: 80 }));
    c.apply(ingress("shop", { className: "nginx", rules: [{ host: "shop.example.com", http: { paths: [{ path: "/", pathType: "Prefix", backend: { service: { name: "shop", port: { number: 80 } } } }] } }] }));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
    c.apply(networkPolicy("shop-from-ingress", { podSelector: { matchLabels: { app: "shop" } }, ingress: [{ from: [{ podSelector: { matchLabels: { app: "ingress-nginx-controller" } } }], ports: [{ port: 80 }] }] }));
    c.runFor(20_000);
    expect(c.requestExternal("http://shop.example.com/").ok).toBe(true);
    expect(curl(c, "client", "http://shop").ok).toBe(false);
  });

  test("Pod 가 도는 노드에서 오는 트래픽은 늘 허용: 바깥 → NodePort 가 같은 노드에 떨어지면 되고(SNAT 노드 IP), 다른 노드면 막힘", () => {
    const c = cluster();
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 50, memory: 32, port: 80, nodeSelector: { "kubernetes.io/hostname": "worker-2" } }));
    c.apply(service("web", { selector: { app: "web" }, port: 80, type: "NodePort", nodePort: 30080 }));
    c.apply(denyWeb);
    c.runFor(15_000);
    expect(c.requestNodePort("worker-2", 30080).ok).toBe(true);
    const far = c.requestNodePort("worker-1", 30080);
    expect(far.ok).toBe(false);
    expect(far.steps.at(-1)!.text).toContain("192.168.0.11");
    // ipBlock 으로 worker-1 의 IP 를 허용하면 된다 (Cluster 정책에서는 원래 클라이언트 IP 가 아니라 노드 IP 로 보인다)
    c.apply(networkPolicy("from-nodes", { podSelector: { matchLabels: { app: "web" } }, ingress: [{ from: [{ ipBlock: { cidr: "192.168.0.0/24" } }] }] }));
    expect(c.requestNodePort("worker-1", 30080).ok).toBe(true);
  });
});

describe("kubectl · API", () => {
  test("get · describe (실제 모양) · policyTypes 기본값 · CIDR 검사", () => {
    const c = cluster();
    c.apply(denyWeb);
    c.apply(allowClient);
    expect(c.api.get("NetworkPolicy", "allow-client")!.spec.policyTypes).toEqual(["Ingress"]);
    expect(kubectl(c, "kubectl get netpol").output).toMatch(/NAME\s+POD-SELECTOR\s+AGE\nallow-client\s+app=web\s+\S+\ndeny-web\s+app=web/);
    expect(kubectl(c, "kubectl describe networkpolicy deny-web").output).toContain(
      "Spec:\n  PodSelector:     app=web\n  Allowing ingress traffic:\n    <none> (Selected pods are isolated for ingress connectivity)\n  Not affecting egress traffic\n  Policy Types: Ingress",
    );
    expect(kubectl(c, "kubectl describe networkpolicy allow-client").output).toContain("  Allowing ingress traffic:\n    To Port: 80/TCP\n    From:\n      PodSelector: app=client");
    expect(() => c.apply(networkPolicy("bad", { podSelector: {}, ingress: [{ from: [{ ipBlock: { cidr: "10.0.0.0" } }] }] }))).toThrow("must be a valid CIDR value");
    c.apply(networkPolicy("eg", { podSelector: {}, egress: [{}] }));
    expect(c.api.get("NetworkPolicy", "eg")!.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  });
});
