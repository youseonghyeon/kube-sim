// 리뷰 5 (2026-10-02, 바깥에서 들어오는 길)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { deployment, ingress, service } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const NGINX = "registry.k8s.io/ingress-nginx/controller:v1.11.2";

/** who Pod 는 w2 에만, client Pod 는 w1 에 */
function twoNodes(type: "LoadBalancer" | "NodePort", etp: "Cluster" | "Local") {
  const c = cluster([{ name: "w1" }, { name: "w2" }]);
  c.apply(deployment("who", { replicas: 1, image: "traefik/whoami:v1.10", cpu: 100, memory: 64, port: 80, nodeSelector: { "kubernetes.io/hostname": "w2" } }));
  c.apply(deployment("client", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80, nodeSelector: { "kubernetes.io/hostname": "w1" } }));
  c.apply(service("who", { selector: { app: "who" }, port: 80, type, nodePort: 30080, externalTrafficPolicy: etp }));
  c.runFor(15_000);
  const client = pods(c).find((p) => p.metadata.name.startsWith("client-"))!.metadata.name;
  return { c, client };
}

describe("review5 클러스터 안에서 바깥 주소로", () => {
  // 기대(실제 kube-proxy iptables): KUBE-EXT-<svc> 의 첫 규칙이 `-s <clusterCIDR> -j KUBE-SVC-<svc>` ("pod traffic for … external destinations").
  //       Pod 가 LoadBalancer IP 로 보낸 것은 Local 이어도 KUBE-SVL 을 타지 않고 모든 엔드포인트로 간다 → w1 의 Pod 도 w2 의 who 에 닿는다.
  // 실제(sim): send() 가 Pod 출발 요청에 outside:"lb" 를 붙여 viaService 가 Local 로 취급 → w1 에 엔드포인트가 없어 DROP → curl (28) 시간 초과.
  // 학습 영향: "Local 로 바꾸면 클러스터 안의 다른 Pod 가 LB IP 로 못 붙는다" 는 틀린 결론. iptables-save 에도 그 short-circuit 규칙이 없다.
  // 원인: src/core/net/request.ts:161 (outside:"lb" 부여) + :167 (local 판정), src/core/net/kubeproxy.ts:131-140 (KUBE-EXT 에 Pod CIDR 규칙 없음).
  test("Local LoadBalancer IP 로 Pod 가 curl 하면 (엔드포인트가 다른 노드여도) 닿는다", () => {
    const { c, client } = twoNodes("LoadBalancer", "Local");
    const r = c.requestFromPod(client, "curl", "http://192.168.0.240/");
    expect(r.ok, r.output).toBe(true);
    expect(r.servedBy).toMatch(/^who-/);
  });

  // 기대(실제): Pod 에서 다른 노드IP:NodePort 로 보내면 패킷이 그 노드로 가서 KUBE-NODEPORTS 를 탄다 (Cluster 라 어느 노드에서든 닿음).
  // 실제(sim): deliverToIp 가 노드 IP 를 "어떤 노드의 PodCIDR 에도 없음" 으로 보고 시간 초과.
  // 학습 영향: `kubectl exec <pod> -- curl <노드IP>:<NodePort>` 로 NodePort 를 확인하려는 학습자가 "NodePort 가 안 열렸다" 고 오해.
  // 원인: src/core/net/request.ts:137-163 send() 가 노드 IP 를 모름 (simulateExternal 만 노드 IP → simulateNodePort 로 보냄, :397).
  test("Pod 에서 노드IP:NodePort 로 curl 하면 닿는다", () => {
    const { c, client } = twoNodes("NodePort", "Cluster");
    const r = c.requestFromPod(client, "curl", "http://192.168.0.12:30080/");
    expect(r.ok, r.output).toBe(true);
    expect(r.servedBy).toMatch(/^who-/);
  });

  // 기대(실제): 노드 IP 는 진짜 장치에 붙은 주소라 ping 에 답한다 (ClusterIP 와 대비되는 학습 포인트).
  // 실제(sim): 노드 IP 를 PodCIDR 밖 주소로 보고 100% packet loss.
  // 원인: src/core/net/request.ts:153 → deliverToIp :212-217.
  test("Pod 에서 노드 IP 로 ping 하면 답이 온다", () => {
    const { c, client } = twoNodes("NodePort", "Cluster");
    const r = c.requestFromPod(client, "ping", "192.168.0.12");
    expect(r.output).toContain("3 packets received");
  });
});

describe("review5 Tailscale Funnel 포트", () => {
  // 기대(실제): Funnel 은 443·8443·10000 만, Tailscale Ingress 프록시는 HTTPS(443)만 듣는다. http:// (80) 로는 연결되지 않는다.
  // 실제(sim): viaFunnel 이 사용자가 친 포트를 무시하고 443 으로 바꿔 보내 http:// 도 성공.
  // 학습 영향: "funnel 은 http 로도 된다" 는 오해. net-sim 배포의 실제 주소(https)와 다르게 배운다.
  // 원인: src/core/net/request.ts:429 ({ ...req, port: 443 }).
  test("http:// (포트 80) 로 funnel 주소에 붙으면 실패한다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("net-sim", { replicas: 1, image: "ghcr.io/youseonghyeon/net-sim:latest", cpu: 10, memory: 16, port: 8080 }));
    c.apply(service("net-sim", { selector: { app: "net-sim" }, port: 8080 }));
    c.apply(ingress("net-sim", { className: "tailscale", defaultBackend: { service: { name: "net-sim", port: { number: 8080 } } }, tls: ["net-sim"], annotations: { "tailscale.com/funnel": "true" } }));
    c.runFor(20_000);
    expect(c.requestExternal("https://net-sim.tailnet-1234.ts.net/").ok).toBe(true);
    expect(c.requestExternal("http://net-sim.tailnet-1234.ts.net/").ok).toBe(false);
  });
});

describe("review5 도구 문구", () => {
  // 기대(실제 busybox wget): ingress-nginx 의 404 를 받으면 "wget: server returned error: HTTP/1.1 404 Not Found".
  // 실제(sim): failure.kind "http" 는 상태 코드와 상관없이 늘 "503 Service Unavailable" 로 찍는다 (404·502 도).
  // 학습 영향: Host 가 안 맞아 404 인데 503(엔드포인트 없음)으로 읽혀 엉뚱한 곳(Pod readiness)을 고친다.
  // 원인: src/core/kubectl.ts:991-992 wgetOutput, src/core/net/request.ts NetResult.failure 에 상태 코드가 없음.
  test("Pod 안에서 wget 으로 ingress-nginx 에 Host 없이 보내면 404 로 찍힌다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("ingress-nginx-controller", { replicas: 1, image: NGINX, cpu: 100, memory: 128, port: 80 }));
    c.apply(service("ingress-nginx-controller", { selector: { app: "ingress-nginx-controller" }, port: 80, type: "LoadBalancer" }));
    c.apply(deployment("client", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
    c.runFor(20_000);
    const client = pods(c).find((p) => p.metadata.name.startsWith("client-"))!.metadata.name;
    const r = runKubectl(c, `kubectl exec ${client} -- wget -qO- http://ingress-nginx-controller/`);
    expect(r.net?.output).toContain("404 Not Found");
    expect(r.output).toBe("wget: server returned error: HTTP/1.1 404 Not Found");
  });

  // 기대(실제 curl): `curl -o /dev/null URL`, `curl -m 5 URL`, `curl -H "Host: …" URL` 의 대상은 URL.
  // 실제(sim): sim.ts 의 정규식 /^curl\s+(?:-\S+\s+)*(\S+)/ 이 옵션 값("/dev/null"·"5"·'"Host:')을 URL 로 읽어
  //       "curl: (3) URL rejected" — kubectl exec 쪽(firstOperand)은 값을 받는 옵션을 건너뛰는데 바깥 curl 만 안 한다.
  // 학습 영향: Ingress 를 IP 로 시험할 때 흔히 쓰는 `curl -H "Host: shop.example.com" http://<LB IP>/` 가 URL 오류로 보인다.
  // 원인: src/model/sim.ts:122.
  test("바깥 curl 에 값을 받는 옵션이 있어도 URL 을 찾는다", async () => {
    const { sim } = await import("../src/model/sim");
    for (const cmd of ["curl -o /dev/null http://192.168.0.240/", "curl -m 5 http://192.168.0.240/", 'curl -H "Host: shop.example.com" http://192.168.0.240/']) {
      expect(sim.kubectl(cmd).output, cmd).not.toContain("URL rejected");
    }
  });
});
