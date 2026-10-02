// 요청 한 번을 단계별로 흉내 낸다: (DNS) → 출발 노드의 iptables 규칙(kube-proxy 가 써 둔 것)으로 DNAT → 노드 간 경로 → 앱 응답.
// 바깥에서 들어오는 길(4단계): NodePort · LoadBalancer(MetalLB L2) · Ingress(ingress-nginx) · Tailscale Funnel.
// 출발지 IP 를 따라간다 — SNAT 되면 바뀌고, 프록시(Ingress 컨트롤러·Tailscale 프록시)는 새 연결을 맺어 자기 IP 가 출발지가 되고
// 원래 클라이언트는 X-Forwarded-For 에 남긴다. 응답한 앱이 본 출발지를 출력에 함께 보여 준다.
// 요청은 시뮬레이션 시간을 쓰지 않고 지금 상태로 한 번에 계산한다 (축소판: 지연·재전송 없음, 타임아웃은 결과로만).
// 노드 간 Pod 트래픽은 flannel VXLAN(k3s 기본)으로 캡슐화된다고 문구로만 보여 준다.
import type { Pod } from "../api/types";
import type { Cluster } from "../cluster";
import { imageSpec } from "../workloads";
import { funnelOn, ingressAddress, lbIP, matchIngress, proxyName, readyEndpoints } from "./ingress";
import type { SepRule, SvcRule } from "./kubeproxy";

export const CLUSTER_DOMAIN = "cluster.local";
export const DNS_SERVICE_IP = "10.96.0.10";
/** 바깥 클라이언트의 공인 IP (예시 — 문서용 대역 203.0.113.0/24) */
export const CLIENT_IP = "203.0.113.7";

export type StepKind = "dns" | "dnat" | "route" | "response" | "fail";

export interface NetStep {
  kind: StepKind;
  /** 이 단계를 한 주체 (coredns, iptables@worker-1, flannel@worker-1, Pod 이름) */
  actor: string;
  text: string;
  /** 화면에서 점이 지나가는 곳 */
  at?: { pod?: string; node?: string; service?: string; dns?: boolean; outside?: boolean; ingress?: string };
}

export interface NetResult {
  ok: boolean;
  steps: NetStep[];
  /** 도구(curl·ping·nslookup)가 화면에 찍는 것 */
  output: string;
  /** 응답한 Pod */
  servedBy?: string;
  /** 응답한 앱이 본 출발지 IP 와 X-Forwarded-For */
  seenSource?: string;
  forwardedFor?: string;
  /** HTTP 응답 코드 (응답을 받았을 때) */
  httpStatus?: number;
  /** 실패의 종류 — 도구마다 다른 문구(wget 등)를 만들 때 쓴다 */
  failure?: { kind: "dns" | "refused" | "timeout" | "http" | "nohttp"; host: string; ip?: string };
}

export type Tool = "curl" | "ping" | "nslookup";

interface DnsAnswer {
  fqdn: string;
  ip?: string;
  tried: string[];
}

/** CoreDNS 흉내: Pod 의 /etc/resolv.conf (search default.svc.cluster.local svc.cluster.local cluster.local, ndots:5) 를 따라 차례로 묻는다 */
export function resolve(c: Cluster, name: string, podNs = "default"): DnsAnswer {
  const host = name.replace(/\.$/, "");
  const absolute = name.endsWith(".");
  const dots = host.split(".").length - 1;
  const search = [`${podNs}.svc.${CLUSTER_DOMAIN}`, `svc.${CLUSTER_DOMAIN}`, CLUSTER_DOMAIN];
  const candidates = absolute ? [host] : dots >= 5 ? [host, ...search.map((s) => `${host}.${s}`)] : [...search.map((s) => `${host}.${s}`), host];
  const tried: string[] = [];
  for (const q of candidates) {
    tried.push(q);
    const ip = lookup(c, q);
    if (ip) return { fqdn: q, ip, tried };
  }
  return { fqdn: candidates[0]!, tried };
}

/** <svc>.<ns>.svc.cluster.local → ClusterIP */
function lookup(c: Cluster, fqdn: string): string | undefined {
  const m = new RegExp(`^([a-z0-9-]+)\\.([a-z0-9-]+)\\.svc\\.${CLUSTER_DOMAIN.replace(".", "\\.")}$`).exec(fqdn);
  if (!m) return undefined;
  if (m[1] === "kube-dns" && m[2] === "kube-system") return DNS_SERVICE_IP;
  return c.api.get("Service", m[1]!, m[2]!)?.spec.clusterIP;
}

const IP_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** "http://web:80/path" · "web" · "10.96.0.12:8080" · "https://x.ts.net/" → host, port, path */
export function parseTarget(target: string): { host: string; port: number; path: string; https: boolean } | undefined {
  const m = /^(?:(https?):\/\/)?([a-zA-Z0-9.-]+)(?::(\d+))?(\/[^\s]*)?$/.exec(target.trim());
  if (!m) return undefined;
  const https = m[1] === "https";
  return { host: m[2]!.toLowerCase(), port: m[3] ? Number(m[3]) : https ? 443 : 80, path: (m[4] ?? "/").split(/[?#]/)[0] || "/", https };
}

/** 요청 한 번 동안 바뀌지 않는 것 (출력 문구용) */
interface Req {
  tool: Tool;
  /** 사용자가 친 호스트·포트 — 실패 문구에 그대로 */
  host: string;
  port: number;
  /** HTTP Host 헤더·경로 (Ingress 가 본다) */
  httpHost: string;
  path: string;
}

/** 패킷을 보내는 쪽 */
interface Source {
  node: string;
  pod?: string;
  /** 받는 쪽이 보게 될 출발지 IP (SNAT·프록시에서 바뀐다) */
  ip: string;
  /** 지금까지 쌓인 X-Forwarded-For */
  xff?: string;
  /** 바깥에서 NodePort·LoadBalancer 로 들어옴 (KUBE-EXT 체인을 탐) */
  outside?: "nodeport" | "lb";
}

/** Pod 안에서 도구를 실행했을 때 (kubectl exec <pod> -- curl …) */
export function simulateFromPod(c: Cluster, from: Pod, tool: Tool, target: string): NetResult {
  const steps: NetStep[] = [];
  const srcNode = from.spec.nodeName!;
  const t = parseTarget(target);
  if (!t) return { ok: false, steps, output: `${tool}: 주소를 읽지 못했습니다: ${target}` };
  let ip = t.host;
  if (!IP_RE.test(t.host)) {
    const a = resolve(c, t.host, from.metadata.namespace ?? "default");
    if (!a.ip) {
      steps.push({ kind: "dns", actor: "coredns", text: `${a.tried.join(" → ")} 모두 NXDOMAIN (resolv.conf 의 search 도메인을 차례로 붙여 물어봄)`, at: { dns: true } });
      steps.push({ kind: "fail", actor: from.metadata.name, text: "이름을 풀지 못해 연결하지 않음" });
      const failure = { kind: "dns" as const, host: t.host };
      if (tool === "nslookup") return { ok: false, steps, failure, output: `Server:\t\t${DNS_SERVICE_IP}\nAddress:\t${DNS_SERVICE_IP}:53\n\n** server can't find ${t.host}: NXDOMAIN` };
      if (tool === "ping") return { ok: false, steps, failure, output: `ping: bad address '${t.host}'` };
      return { ok: false, steps, failure, output: `curl: (6) Could not resolve host: ${t.host}` };
    }
    const extra = a.tried.length > 1 ? ` (먼저 ${a.tried.slice(0, -1).join(", ")} 는 NXDOMAIN — ndots:5 라 search 도메인부터 붙여 봄)` : "";
    steps.push({ kind: "dns", actor: "coredns", text: `${t.host} → ${a.fqdn} → ${a.ip}${extra}`, at: { dns: true } });
    ip = a.ip;
    if (tool === "nslookup") return { ok: true, steps, output: `Server:\t\t${DNS_SERVICE_IP}\nAddress:\t${DNS_SERVICE_IP}:53\n\nName:\t${a.fqdn}\nAddress: ${a.ip}` };
  } else if (tool === "nslookup") {
    return { ok: false, steps, output: `** server can't find ${ip.split(".").reverse().join(".")}.in-addr.arpa: NXDOMAIN (축소판: 역방향 조회 없음)` };
  }
  // curl·ping 은 사용자가 쓴 이름을 그대로 찍는다 (풀린 FQDN 이 아니라)
  const req: Req = { tool, host: t.host, port: t.port, httpHost: t.host, path: t.path };
  return send(c, { node: srcNode, pod: from.metadata.name, ip: from.status.podIP ?? "" }, req, ip, t.port, steps);
}

function send(c: Cluster, src: Source, req: Req, ip: string, port: number, steps: NetStep[]): NetResult {
  // 노드 IP 로: 그 노드까지 가서 그 노드의 KUBE-NODEPORTS 가 처리한다 (ping 이면 노드가 답한다)
  const toNode = !src.outside ? c.api.peekList("Node").find((n) => n.status.addresses.some((a) => a.type === "InternalIP" && a.address === ip)) : undefined;
  if (toNode) {
    const nn = toNode.metadata.name;
    steps.push({ kind: "route", actor: src.pod ?? src.node, text: `${ip} 는 노드 ${nn} 의 주소 → ${nn === src.node ? "자기 노드" : "노드 네트워크로 그 노드까지"}`, at: { node: nn } });
    if (!c.nodePowered(nn)) {
      steps.push({ kind: "fail", actor: src.pod ?? src.node, text: `${nn} 가 꺼져 있어 답이 없음` });
      return timedOut(req, steps, ip);
    }
    if (req.tool === "ping") {
      steps.push({ kind: "response", actor: nn, text: `노드 ${nn} 가 ICMP echo 에 답함`, at: { node: nn } });
      return { ok: true, steps, output: pingOut(req.host, ip, 3, 63) };
    }
    const np = c.kubeProxies.get(nn)?.currentRules.find((r) => r.nodePort === port);
    if (!np) {
      steps.push({ kind: "fail", actor: nn, text: `${nn}:${port} 에서 듣는 것도, KUBE-NODEPORTS 규칙도 없음 → 연결 거부`, at: { node: nn } });
      return refused(req, steps, ip, 1);
    }
    return viaService(c, { ...src, node: nn, outside: "nodeport" }, np, req, steps);
  }
  const proxy = c.kubeProxies.get(src.node);
  const rules = proxy?.currentRules ?? [];
  const rule = rules.find((r) => (r.clusterIP === ip || r.lbIP === ip) && (req.tool === "ping" || r.port === port));
  const svcByIp = c.api.peekList("Service").find((s) => s.spec.clusterIP === ip || lbIP(s) === ip);
  if (req.tool === "ping") {
    if (svcByIp) {
      steps.push({
        kind: "dnat",
        actor: `iptables@${src.node}`,
        text: `${ip} 는 Service ${svcByIp.metadata.name} 의 ${svcByIp.spec.clusterIP === ip ? "ClusterIP" : "LoadBalancer IP"} — kube-proxy 규칙은 TCP 포트에만 있어 ICMP 는 아무 규칙에도 맞지 않음`,
        at: { service: svcByIp.metadata.name },
      });
      steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "아무도 답하지 않음 → ping 은 시간 초과 (TCP 로 접속하면 됩니다)" });
      return { ok: false, steps, failure: { kind: "timeout", host: req.host, ip }, output: pingOut(req.host, ip, 0) };
    }
    return deliverToIp(c, src, req, ip, port, steps);
  }
  if (svcByIp && !rule) {
    const known = svcByIp.spec.ports.map((p) => p.port).join(", ");
    steps.push({ kind: "dnat", actor: `iptables@${src.node}`, text: `${ip}:${port} 에 맞는 규칙 없음 (Service ${svcByIp.metadata.name} 의 포트는 ${known}) → 가상 주소라 받는 곳이 없어 패킷이 버려짐`, at: { service: svcByIp.metadata.name } });
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "응답 없음 → 연결 시간 초과" });
    return timedOut(req, steps, ip);
  }
  // Pod 에서 LoadBalancer IP 로 온 것: KUBE-EXT 의 "pod traffic" 규칙이 바로 KUBE-SVC 로 보낸다 (Local 이어도 모든 엔드포인트, SNAT 없음)
  if (rule) return viaService(c, src, rule, req, steps, rule.lbIP === ip && !src.outside ? "pod-to-lb" : undefined);
  return deliverToIp(c, src, req, ip, port, steps);
}

function viaService(c: Cluster, src: Source, rule: SvcRule, req: Req, steps: NetStep[], how?: "pod-to-lb"): NetResult {
  const where = `iptables@${src.node}`;
  const local = !!src.outside && rule.externalTrafficPolicy === "Local";
  const pool: SepRule[] = local ? rule.seps.filter((s) => s.nodeName === src.node) : rule.seps;
  if (!rule.seps.length) {
    const target = src.outside === "lb" || how ? `LoadBalancer IP ${rule.lbIP}:${rule.port} → filter 테이블 KUBE-EXTERNAL-SERVICES` : src.outside === "nodeport" ? `NodePort ${rule.nodePort} → filter 테이블 KUBE-EXTERNAL-SERVICES` : `${rule.clusterIP}:${rule.port} → filter 테이블 KUBE-SERVICES`;
    steps.push({
      kind: "dnat",
      actor: where,
      text: `${target} 의 "${rule.ns}/${rule.name} has no endpoints" REJECT 규칙 (ready 인 Pod 가 하나도 없음)`,
      at: { service: rule.name, node: src.node },
    });
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "ICMP port-unreachable 을 받음 → 연결 거부" });
    return refused(req, steps, rule.clusterIP, 1);
  }
  if (!pool.length) {
    steps.push({
      kind: "dnat",
      actor: where,
      text: `externalTrafficPolicy: Local — ${src.node} 에는 Service ${rule.name} 의 Ready Pod 가 없음 → KUBE-SVL 이 비어 있어 버림 (다른 노드로 넘기지 않는다)`,
      at: { service: rule.name, node: src.node },
    });
    steps.push({ kind: "fail", actor: "client", text: "응답 없음 → 연결 시간 초과 (Local 은 Pod 가 있는 노드로만 들어와야 한다 — LoadBalancer 는 그런 노드만 IP 를 맡는다)" });
    return timedOut(req, steps, src.ip);
  }
  const n = pool.length;
  const sep = pool[c.netRng.int(n)]!;
  const odds = n === 1 ? "하나뿐" : `${n}개 중 하나를 고름 (확률 1/${n})`;
  const entry =
    src.outside === "lb"
      ? `LoadBalancer IP ${rule.lbIP}:${rule.port} → KUBE-EXT → `
      : src.outside === "nodeport"
        ? `KUBE-NODEPORTS ${rule.nodePort} → KUBE-EXT → `
        : how === "pod-to-lb"
          ? `LoadBalancer IP ${rule.lbIP}:${rule.port} → KUBE-EXT 의 "pod traffic" 규칙 (클러스터 안에서 온 것은 externalTrafficPolicy 와 상관없이) → `
          : `${rule.clusterIP}:${rule.port} 가 KUBE-SERVICES → `;
  const nodeIp = c.api.get("Node", src.node)?.status.addresses.find((a) => a.type === "InternalIP")?.address ?? src.node;
  let next = src;
  let snat = "";
  if (src.outside && !local) {
    next = { ...src, ip: nodeIp };
    snat = ` · externalTrafficPolicy: Cluster → 출발지 ${src.ip} 를 노드 IP ${nodeIp} 로 SNAT (어느 노드의 Pod 로 가도 응답이 이 노드로 돌아오게 — 원래 클라이언트 IP 는 사라짐)`;
  } else if (local) snat = ` · externalTrafficPolicy: Local → 이 노드의 Pod 만 고르고 SNAT 하지 않음 (출발지 ${src.ip} 그대로)`;
  steps.push({
    kind: "dnat",
    actor: where,
    text: `${entry}${local ? rule.chain.replace("KUBE-SVC-", "KUBE-SVL-") : rule.chain} → 엔드포인트 ${odds} → ${sep.chain} → DNAT ${sep.ip}:${sep.port} (${sep.pod})${snat}`,
    at: { service: rule.name, node: src.node },
  });
  return deliverToIp(c, next, req, sep.ip, sep.port, steps);
}

/** Pod IP 로 패킷을 보낸다: 같은 노드면 cni0 브리지, 다른 노드면 flannel VXLAN. 받은 Pod 가 프록시면 거기서 다음 연결로 이어진다 */
function deliverToIp(c: Cluster, src: Source, req: Req, ip: string, port: number, steps: NetStep[]): NetResult {
  const pod = c.api.peekList("Pod").find((p) => p.status.podIP === ip && p.spec.nodeName);
  const node = c.api.peekList("Node").find((n) => n.spec.podCIDR && inCidr(ip, n.spec.podCIDR));
  if (!node) {
    steps.push({ kind: "route", actor: src.pod ?? src.node, text: `${ip} 는 어떤 노드의 PodCIDR 에도 없음 → 기본 경로로 나갔지만 받는 곳이 없음` });
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "응답 없음 → 연결 시간 초과" });
    return timedOut(req, steps, ip);
  }
  const dst = node.metadata.name;
  if (dst === src.node) steps.push({ kind: "route", actor: `cni0@${src.node}`, text: `${ip} 는 같은 노드(${src.node}) 의 PodCIDR ${node.spec.podCIDR} → 브리지 cni0 로 바로 전달`, at: { node: dst, pod: pod?.metadata.name } });
  else {
    const nodeIp = node.status.addresses.find((a) => a.type === "InternalIP")?.address;
    steps.push({
      kind: "route",
      actor: `flannel@${src.node}`,
      text: `${ip} 는 ${dst} 의 PodCIDR ${node.spec.podCIDR} → flannel.1 로 VXLAN 캡슐화해 노드 IP ${nodeIp} 로 보냄 → ${dst} 가 풀어서 cni0 로 전달`,
      at: { node: dst, pod: pod?.metadata.name },
    });
  }
  const timeout = () => {
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: `${dst} 가 꺼져 있어 아무도 받지 않음 → 시간 초과 (EndpointSlice 에서 빠지기 전까지 요청 일부가 이렇게 실패)` });
    return timedOut(req, steps, ip);
  };
  if (!c.nodePowered(dst)) return timeout();
  if (!pod) {
    steps.push({ kind: "fail", actor: `cni0@${dst}`, text: `${ip} 를 가진 Pod 가 없음 (이미 사라진 Pod 의 IP) → 응답 없음` });
    return req.tool === "ping" ? timedOut(req, steps, ip) : refused(req, steps, ip, 3);
  }
  const app = c.kubelets.get(dst)?.appState(pod.metadata.uid);
  if (req.tool === "ping") {
    if (!app?.running && !pod.status.podIP) return timeout();
    const ttl = dst === src.node ? 64 : 62;
    steps.push({ kind: "response", actor: pod.metadata.name, text: `Pod 의 네트워크 네임스페이스가 ICMP echo 에 답함 (ttl=${ttl})`, at: { pod: pod.metadata.name } });
    return { ok: true, steps, output: pingOut(req.host, ip, 3, ttl), servedBy: pod.metadata.name };
  }
  const spec = imageSpec(pod.spec.containers[0]!.image);
  if (!app?.running || spec?.port !== port) {
    const why = !app?.running ? "컨테이너가 돌고 있지 않음" : `앱은 포트 ${spec?.port ?? "(없음)"} 에서 듣는데 ${port} 로 옴 — Service 의 targetPort 를 확인하세요`;
    steps.push({ kind: "fail", actor: pod.metadata.name, text: `${why} → TCP RST → 연결 거부`, at: { pod: pod.metadata.name } });
    return refused(req, steps, ip, 2);
  }
  if (spec.role === "ingress-nginx") return viaIngressNginx(c, pod, src, req, steps);
  if (spec.role === "tailscale-proxy") return viaTailscaleProxy(c, pod, src, req, steps);
  if (spec.body === undefined) {
    steps.push({ kind: "fail", actor: pod.metadata.name, text: `${pod.metadata.name} 의 앱이 받았지만 HTTP 가 아닌 프로토콜로 답함 → curl 이 HTTP 응답으로 읽지 못함`, at: { pod: pod.metadata.name } });
    return { ok: false, steps, failure: { kind: "nohttp", host: req.host, ip }, output: "curl: (1) Received HTTP/0.9 when not allowed", servedBy: pod.metadata.name };
  }
  const seen = `(응답한 Pod: ${pod.metadata.name} · 앱이 본 출발지 ${src.ip}${src.xff ? ` · X-Forwarded-For: ${src.xff}` : ""} — 실제 curl 은 이 줄을 찍지 않습니다)`;
  if (app.sick || !app.warm) {
    steps.push({ kind: "response", actor: pod.metadata.name, text: `${pod.metadata.name} 이(가) 받았지만 앱이 준비되지 않음 → HTTP 503`, at: { pod: pod.metadata.name } });
    return {
      ok: false,
      steps,
      httpStatus: 503,
      failure: { kind: "http", host: req.host, ip },
      output: `<html><body>503 Service Unavailable</body></html>\n${seen}`,
      servedBy: pod.metadata.name,
      seenSource: src.ip,
      forwardedFor: src.xff,
    };
  }
  steps.push({
    kind: "response",
    actor: pod.metadata.name,
    text: `${pod.metadata.name} (${ip}:${port}) 의 앱이 HTTP 200 으로 응답 — 앱이 본 출발지 IP 는 ${src.ip}${src.xff ? `, X-Forwarded-For: ${src.xff}` : ""}`,
    at: { pod: pod.metadata.name },
  });
  const body = spec.role === "echo" ? `Hostname: ${pod.metadata.name}\nIP: ${ip}\nRemoteAddr: ${src.ip}:${40000 + c.netRng.int(20000)}\nGET ${req.path} HTTP/1.1\nHost: ${req.httpHost}${src.xff ? `\nX-Forwarded-For: ${src.xff}` : ""}` : spec.body;
  return { ok: true, steps, httpStatus: 200, output: `${body}\n${seen}`, servedBy: pod.metadata.name, seenSource: src.ip, forwardedFor: src.xff };
}

/** ingress-nginx 컨트롤러 Pod: Host·경로로 Ingress 규칙을 찾아 그 Service 의 엔드포인트(Pod IP)로 직접 새 연결 */
function viaIngressNginx(c: Cluster, pod: Pod, src: Source, req: Req, steps: NetStep[]): NetResult {
  const ns = pod.metadata.namespace ?? "default";
  const ings = c.api.peekList("Ingress", ns).filter((i) => i.spec.ingressClassName === "nginx");
  const m = matchIngress(ings, req.httpHost, req.path);
  const name = pod.metadata.name;
  if (!m) {
    steps.push({ kind: "response", actor: name, text: `Host ${req.httpHost} · 경로 ${req.path} 에 맞는 Ingress 규칙이 없음 → ingress-nginx 의 기본 백엔드가 404`, at: { pod: name } });
    return { ok: false, steps, httpStatus: 404, failure: { kind: "http", host: req.host }, output: "<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>", servedBy: name };
  }
  const svc = c.api.get("Service", m.backend.service.name, ns);
  const eps = svc ? readyEndpoints(c, ns, svc, m.backend.service.port.number) : [];
  if (!svc || !eps.length) {
    steps.push({ kind: "response", actor: name, text: `Ingress ${m.ing.metadata.name} 의 규칙 ${m.how} → Service ${m.backend.service.name}:${m.backend.service.port.number} 에 ready 엔드포인트가 없음 → 503`, at: { pod: name, ingress: m.ing.metadata.name } });
    return {
      ok: false,
      steps,
      httpStatus: 503,
      failure: { kind: "http", host: req.host },
      output: "<html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503 Service Temporarily Unavailable</h1></center><hr><center>nginx</center></body></html>",
      servedBy: name,
    };
  }
  const ep = eps[c.netRng.int(eps.length)]!;
  const xff = src.xff ? `${src.xff}, ${src.ip}` : src.ip;
  steps.push({
    kind: "dnat",
    actor: name,
    text: `ingress-nginx: Host ${req.httpHost} · 경로 ${req.path} → Ingress ${m.ing.metadata.name} 의 규칙 ${m.how} → Service ${svc.metadata.name} 의 엔드포인트 ${eps.length}개 중 ${ep.ip}:${ep.port} (${ep.pod}) 로 새 연결 — ClusterIP·kube-proxy 를 거치지 않고 Pod 로 바로. 출발지는 이 Pod(${pod.status.podIP}), X-Forwarded-For: ${xff}`,
    at: { pod: name, ingress: m.ing.metadata.name },
  });
  return deliverToIp(c, { node: pod.spec.nodeName!, pod: name, ip: pod.status.podIP ?? "", xff }, { ...req }, ep.ip, ep.port, steps);
}

/** Tailscale 프록시 Pod: TLS 를 끝내고 Ingress 의 backend Service(ClusterIP)로 새 연결 — 이 Pod 가 있는 노드의 kube-proxy 규칙을 탄다 */
function viaTailscaleProxy(c: Cluster, pod: Pod, src: Source, req: Req, steps: NetStep[]): NetResult {
  const ns = pod.metadata.namespace ?? "default";
  const parent = pod.metadata.labels["tailscale.com/parent-resource"];
  const ing = parent ? c.api.get("Ingress", parent, ns) : undefined;
  const be = ing ? matchIngress([ing], req.httpHost, req.path)?.backend : undefined;
  const svc = be ? c.api.get("Service", be.service.name, ns) : undefined;
  const name = pod.metadata.name;
  if (!be || !svc?.spec.clusterIP) {
    steps.push({ kind: "response", actor: name, text: `Ingress 의 backend Service ${be?.service.name ?? "(없음)"} 를 찾지 못함 → 502`, at: { pod: name } });
    return { ok: false, steps, httpStatus: 502, failure: { kind: "http", host: req.host }, output: "<html><body>502 Bad Gateway</body></html>", servedBy: name };
  }
  const xff = src.xff ? `${src.xff}, ${src.ip}` : src.ip;
  steps.push({
    kind: "dnat",
    actor: name,
    text: `Tailscale 프록시: TLS(${req.host}) 를 끝내고 backend Service ${svc.metadata.name}:${be.service.port.number} (ClusterIP ${svc.spec.clusterIP}) 로 새 연결 — 출발지는 이 Pod(${pod.status.podIP}), X-Forwarded-For: ${xff}`,
    at: { pod: name, ingress: ing?.metadata.name },
  });
  // 실패 문구는 사용자가 접속한 주소(https://…:443)로 — 안쪽 Service 포트가 아니라
  return send(c, { node: pod.spec.nodeName!, pod: name, ip: pod.status.podIP ?? "", xff }, req, svc.spec.clusterIP, be.service.port.number, steps);
}

/** 바깥(클러스터 밖 클라이언트)에서 노드IP:NodePort 로 */
export function simulateNodePort(c: Cluster, nodeName: string, nodePort: number, clientIp = CLIENT_IP): NetResult {
  const steps: NetStep[] = [];
  const node = c.api.get("Node", nodeName);
  const nodeIp = node?.status.addresses.find((a) => a.type === "InternalIP")?.address ?? nodeName;
  const req: Req = { tool: "curl", host: nodeIp, port: nodePort, httpHost: nodeIp, path: "/" };
  if (!node || !c.nodePowered(nodeName)) {
    steps.push({ kind: "fail", actor: "client", text: `${nodeName} 가 꺼져 있어 응답 없음` });
    return timedOut(req, steps, nodeIp);
  }
  const rule = c.kubeProxies.get(nodeName)?.currentRules.find((r) => r.nodePort === nodePort);
  if (!rule) {
    steps.push({ kind: "dnat", actor: `iptables@${nodeName}`, text: `KUBE-NODEPORTS 에 ${nodePort} 규칙 없음 (NodePort Service 가 아님) → 연결 거부` });
    return refused(req, steps, nodeIp, 1);
  }
  steps.push({ kind: "route", actor: "client", text: `클러스터 밖 클라이언트(${clientIp}) → ${nodeName} (${nodeIp}:${nodePort})`, at: { node: nodeName, outside: true } });
  return viaService(c, { node: nodeName, ip: clientIp, outside: "nodeport" }, rule, req, steps);
}

/**
 * 클러스터 밖에서 URL 로 curl: 이름이면 바깥 DNS(Ingress 의 ADDRESS 로 등록됐다고 가정)·Tailscale(*.ts.net, funnel),
 * IP 면 LoadBalancer IP 또는 노드IP:NodePort.
 */
export function simulateExternal(c: Cluster, url: string, clientIp = CLIENT_IP): NetResult {
  const steps: NetStep[] = [];
  const t = parseTarget(url);
  if (!t) return { ok: false, steps, output: `curl: (3) URL rejected: Malformed input to a URL function` };
  const req: Req = { tool: "curl", host: t.host, port: t.port, httpHost: t.host, path: t.path };
  if (t.host.endsWith(".ts.net")) return viaFunnel(c, req, clientIp, steps);
  let ip = t.host;
  if (!IP_RE.test(t.host)) {
    const ing = c.api.peekList("Ingress").find((i) => i.spec.rules?.some((r) => r.host === t.host) && ingressAddress(i));
    if (!ing) {
      steps.push({ kind: "dns", actor: "공인 DNS", text: `${t.host} 를 아는 DNS 가 없음 (축소판: Ingress 규칙의 host 만 Ingress 의 ADDRESS 로 등록돼 있다고 가정)`, at: { outside: true } });
      return { ok: false, steps, failure: { kind: "dns", host: t.host }, output: `curl: (6) Could not resolve host: ${t.host}` };
    }
    ip = ingressAddress(ing)!;
    steps.push({ kind: "dns", actor: "공인 DNS", text: `${t.host} → ${ip} (Ingress ${ing.metadata.name} 의 ADDRESS = ingress-nginx 의 LoadBalancer IP 를 DNS 에 등록해 뒀다고 가정)`, at: { outside: true } });
  }
  const svc = c.api.peekList("Service").find((s) => lbIP(s) === ip);
  if (svc) {
    const node = c.metallb.announcer(svc.metadata.namespace ?? "default", svc.metadata.name);
    if (!node) {
      steps.push({ kind: "route", actor: "client", text: `ARP: ${ip} 는 누구? → 맡은 노드가 없어 아무도 답하지 않음${svc.spec.externalTrafficPolicy === "Local" ? " (Local: Ready Pod 가 있는 노드가 없음)" : ""}`, at: { outside: true } });
      steps.push({ kind: "fail", actor: "client", text: "응답 없음 → 연결 시간 초과" });
      return timedOut(req, steps, ip);
    }
    const nodeIp = c.api.get("Node", node)?.status.addresses.find((a) => a.type === "InternalIP")?.address;
    steps.push({
      kind: "route",
      actor: `metallb-speaker@${node}`,
      text: `클러스터 밖 클라이언트(${clientIp}) → ARP: ${ip} 는 누구? → ${node}(${nodeIp}) 의 speaker 가 자기 MAC 으로 답함 (L2 모드: IP 하나를 노드 하나가 맡는다) → 패킷이 ${node} 로`,
      at: { node, outside: true },
    });
    const rule = c.kubeProxies.get(node)?.currentRules.find((r) => r.lbIP === ip && r.port === t.port);
    if (!rule) {
      steps.push({ kind: "dnat", actor: `iptables@${node}`, text: `${ip}:${t.port} 에 맞는 규칙 없음 (Service 포트는 ${svc.spec.ports.map((p) => p.port).join(", ")})`, at: { node } });
      return refused(req, steps, ip, 1);
    }
    return viaService(c, { node, ip: clientIp, outside: "lb" }, rule, req, steps);
  }
  const node = c.api.peekList("Node").find((n) => n.status.addresses.some((a) => a.address === ip));
  if (node) return simulateNodePort(c, node.metadata.name, t.port, clientIp);
  steps.push({ kind: "route", actor: "client", text: `${ip} 는 이 클러스터의 LoadBalancer IP 도 노드 IP 도 아님`, at: { outside: true } });
  return timedOut(req, steps, ip);
}

/** Tailscale Funnel: 공인 인터넷 → Tailscale 중계 서버 → (WireGuard) → tailnet 기기인 프록시 Pod */
function viaFunnel(c: Cluster, req: Req, clientIp: string, steps: NetStep[]): NetResult {
  const ing = c.api.peekList("Ingress").find((i) => i.spec.ingressClassName === "tailscale" && ingressAddress(i) === req.host);
  if (!ing) {
    steps.push({ kind: "dns", actor: "공인 DNS", text: `${req.host} — 이 tailnet 에 그런 기기가 없음`, at: { outside: true } });
    return { ok: false, steps, failure: { kind: "dns", host: req.host }, output: `curl: (6) Could not resolve host: ${req.host}` };
  }
  if (!funnelOn(ing)) {
    steps.push({ kind: "dns", actor: "공인 DNS", text: `${req.host} 는 tailnet 안에서만 풀리는 이름 — funnel 이 꺼져 있어(annotation tailscale.com/funnel 없음) 공인 인터넷에서는 닿지 않음`, at: { outside: true } });
    return { ok: false, steps, failure: { kind: "dns", host: req.host }, output: `curl: (6) Could not resolve host: ${req.host}` };
  }
  steps.push({ kind: "dns", actor: "공인 DNS", text: `${req.host} → Tailscale Funnel 중계 서버의 공인 IP (funnel 켜짐)`, at: { outside: true } });
  if (![443, 8443, 10000].includes(req.port)) {
    steps.push({ kind: "fail", actor: "tailscale-funnel", text: `Funnel 은 HTTPS 포트 443·8443·10000 만 받음 — ${req.port} 로는 들어갈 수 없다 (https:// 로)`, at: { outside: true } });
    return refused(req, steps, req.host, 30);
  }
  const proxy = c.api
    .peekList("Pod", ing.metadata.namespace ?? "default")
    .find((p) => p.metadata.labels["tailscale.com/parent-resource"] === ing.metadata.name && p.metadata.deletionTimestamp === undefined && p.status.podIP && p.spec.nodeName);
  if (!proxy || !c.nodePowered(proxy.spec.nodeName!)) {
    steps.push({ kind: "route", actor: "tailscale-funnel", text: `중계 서버가 tailnet 기기 ${proxyName(ing.metadata.name)} 를 찾지 못함 (프록시 Pod 가 없거나 꺼짐)`, at: { outside: true } });
    steps.push({ kind: "fail", actor: "client", text: "연결은 됐지만 뒤쪽이 없음 → 응답 없음" });
    return timedOut(req, steps, req.host);
  }
  steps.push({
    kind: "route",
    actor: "tailscale-funnel",
    text: `클라이언트(${clientIp}) 의 TLS 연결을 중계 서버가 그대로 tailnet 의 기기 ${proxy.metadata.name} 로 넘김 (WireGuard 터널 — NodePort·LoadBalancer·노드 공인 IP 가 필요 없다)`,
    at: { pod: proxy.metadata.name, node: proxy.spec.nodeName },
  });
  return deliverToIp(c, { node: proxy.spec.nodeName!, ip: clientIp }, { ...req, port: 443 }, proxy.status.podIP!, 443, steps);
}

function refused(req: Req, steps: NetStep[], ip: string, ms: number): NetResult {
  return { ok: false, steps, failure: { kind: "refused", host: req.host, ip }, output: `curl: (7) Failed to connect to ${req.host} port ${req.port} after ${ms} ms: Couldn't connect to server` };
}

function timedOut(req: Req, steps: NetStep[], ip: string): NetResult {
  const failure = { kind: "timeout" as const, host: req.host, ip };
  if (req.tool === "ping") return { ok: false, steps, failure, output: pingOut(req.host, ip, 0) };
  return { ok: false, steps, failure, output: `curl: (28) Failed to connect to ${req.host} port ${req.port} after 130000 ms: Connection timed out` };
}

function inCidr(ip: string, cidr: string): boolean {
  const [base] = cidr.split("/");
  return ip.split(".").slice(0, 3).join(".") === base!.split(".").slice(0, 3).join(".");
}

function pingOut(host: string, ip: string, received: number, ttl = 64): string {
  const lines = [`PING ${host} (${ip}): 56 data bytes`];
  for (let i = 0; i < received; i++) lines.push(`64 bytes from ${ip}: seq=${i} ttl=${ttl} time=0.${4 + i} ms`);
  lines.push("", `--- ${host} ping statistics ---`, `3 packets transmitted, ${received} packets received, ${received ? 0 : 100}% packet loss`);
  return lines.join("\n");
}

