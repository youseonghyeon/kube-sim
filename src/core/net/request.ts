// 요청 한 번을 단계별로 흉내 낸다: (DNS) → 출발 노드의 iptables 규칙(kube-proxy 가 써 둔 것)으로 DNAT → 노드 간 경로 → 앱 응답.
// 요청은 시뮬레이션 시간을 쓰지 않고 지금 상태로 한 번에 계산한다 (축소판: 지연·재전송 없음, 타임아웃은 결과로만).
// 노드 간 Pod 트래픽은 flannel VXLAN(k3s 기본)으로 캡슐화된다고 문구로만 보여 준다.
import type { Pod } from "../api/types";
import type { Cluster } from "../cluster";
import { imageSpec } from "../workloads";
import type { SvcRule } from "./kubeproxy";

export const CLUSTER_DOMAIN = "cluster.local";
export const DNS_SERVICE_IP = "10.96.0.10";

export type StepKind = "dns" | "dnat" | "route" | "response" | "fail";

export interface NetStep {
  kind: StepKind;
  /** 이 단계를 한 주체 (coredns, iptables@worker-1, flannel@worker-1, Pod 이름) */
  actor: string;
  text: string;
  /** 화면에서 점이 지나가는 곳 */
  at?: { pod?: string; node?: string; service?: string; dns?: boolean };
}

export interface NetResult {
  ok: boolean;
  steps: NetStep[];
  /** 도구(curl·ping·nslookup)가 화면에 찍는 것 */
  output: string;
  /** 응답한 Pod */
  servedBy?: string;
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

/** "http://web:80/path" · "web" · "10.96.0.12:8080" → host, port */
export function parseTarget(target: string): { host: string; port: number } | undefined {
  const m = /^(?:https?:\/\/)?([a-zA-Z0-9.-]+)(?::(\d+))?(?:\/.*)?$/.exec(target.trim());
  if (!m) return undefined;
  return { host: m[1]!.toLowerCase(), port: m[2] ? Number(m[2]) : 80 };
}

/** Pod 안에서 도구를 실행했을 때 (kubectl exec <pod> -- curl …) */
export function simulateFromPod(c: Cluster, from: Pod, tool: Tool, target: string): NetResult {
  const steps: NetStep[] = [];
  const srcNode = from.spec.nodeName!;
  const t = parseTarget(target);
  if (!t) return { ok: false, steps, output: `${tool}: 주소를 읽지 못했습니다: ${target}` };
  let ip = t.host;
  let shownHost = t.host;
  if (!IP_RE.test(t.host)) {
    const a = resolve(c, t.host, from.metadata.namespace ?? "default");
    if (!a.ip) {
      steps.push({ kind: "dns", actor: "coredns", text: `${a.tried.join(" → ")} 모두 NXDOMAIN (resolv.conf 의 search 도메인을 차례로 붙여 물어봄)`, at: { dns: true } });
      steps.push({ kind: "fail", actor: from.metadata.name, text: "이름을 풀지 못해 연결하지 않음" });
      if (tool === "nslookup") return { ok: false, steps, output: `Server:\t\t${DNS_SERVICE_IP}\nAddress:\t${DNS_SERVICE_IP}:53\n\n** server can't find ${t.host}: NXDOMAIN` };
      if (tool === "ping") return { ok: false, steps, output: `ping: bad address '${t.host}'` };
      return { ok: false, steps, output: `curl: (6) Could not resolve host: ${t.host}` };
    }
    const extra = a.tried.length > 1 ? ` (먼저 ${a.tried.slice(0, -1).join(", ")} 는 NXDOMAIN — ndots:5 라 search 도메인부터 붙여 봄)` : "";
    steps.push({ kind: "dns", actor: "coredns", text: `${t.host} → ${a.fqdn} → ${a.ip}${extra}`, at: { dns: true } });
    ip = a.ip;
    shownHost = a.fqdn;
    if (tool === "nslookup") return { ok: true, steps, output: `Server:\t\t${DNS_SERVICE_IP}\nAddress:\t${DNS_SERVICE_IP}:53\n\nName:\t${a.fqdn}\nAddress: ${a.ip}` };
  } else if (tool === "nslookup") {
    return { ok: false, steps, output: `** server can't find ${ip.split(".").reverse().join(".")}.in-addr.arpa: NXDOMAIN (축소판: 역방향 조회 없음)` };
  }
  return send(c, { node: srcNode, pod: from.metadata.name, ip: from.status.podIP }, tool, ip, t.port, shownHost, steps);
}

interface Source {
  node: string;
  pod?: string;
  ip?: string;
  /** 바깥에서 NodePort 로 들어옴 */
  outside?: boolean;
}

function send(c: Cluster, src: Source, tool: Tool, ip: string, port: number, shownHost: string, steps: NetStep[]): NetResult {
  const proxy = c.kubeProxies.get(src.node);
  const rules = proxy?.currentRules ?? [];
  const rule = rules.find((r) => r.clusterIP === ip && (tool === "ping" || r.port === port));
  const svcByIp = c.api.peekList("Service").find((s) => s.spec.clusterIP === ip);
  if (tool === "ping") {
    if (svcByIp) {
      steps.push({
        kind: "dnat",
        actor: `iptables@${src.node}`,
        text: `${ip} 는 Service ${svcByIp.metadata.name} 의 ClusterIP — 어떤 장치에도 붙어 있지 않은 가상 주소이고, kube-proxy 규칙은 TCP 포트에만 있어 ICMP 는 아무 규칙에도 맞지 않음`,
        at: { service: svcByIp.metadata.name },
      });
      steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "아무도 답하지 않음 → ping 은 시간 초과 (TCP 로 접속하면 됩니다)" });
      return { ok: false, steps, output: pingOut(shownHost, ip, 0) };
    }
    return deliverToIp(c, src, tool, ip, port, shownHost, steps);
  }
  if (svcByIp && !rule) {
    const known = svcByIp.spec.ports.map((p) => p.port).join(", ");
    steps.push({ kind: "dnat", actor: `iptables@${src.node}`, text: `${ip}:${port} 에 맞는 규칙 없음 (Service ${svcByIp.metadata.name} 의 포트는 ${known}) → 가상 주소라 받는 곳이 없어 패킷이 버려짐`, at: { service: svcByIp.metadata.name } });
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "응답 없음 → 연결 시간 초과" });
    return { ok: false, steps, output: `curl: (28) Failed to connect to ${shownHost} port ${port} after 130000 ms: Connection timed out` };
  }
  if (rule) return viaService(c, src, rule, shownHost, steps, tool);
  return deliverToIp(c, src, tool, ip, port, shownHost, steps);
}

function viaService(c: Cluster, src: Source, rule: SvcRule, shownHost: string, steps: NetStep[], tool: Tool): NetResult {
  const where = `iptables@${src.node}`;
  if (!rule.seps.length) {
    steps.push({
      kind: "dnat",
      actor: where,
      text: `${rule.clusterIP}:${rule.port} → KUBE-SERVICES 에 "${rule.ns}/${rule.name} has no endpoints" REJECT 규칙 (ready 인 Pod 가 하나도 없음)`,
      at: { service: rule.name, node: src.node },
    });
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "ICMP port-unreachable 을 받음 → 연결 거부" });
    return { ok: false, steps, output: `curl: (7) Failed to connect to ${shownHost} port ${rule.port} after 1 ms: Couldn't connect to server` };
  }
  const n = rule.seps.length;
  const i = c.netRng.int(n);
  const sep = rule.seps[i]!;
  const odds = n === 1 ? "하나뿐" : `${n}개 중 하나를 고름 (확률 1/${n} — 규칙을 위에서부터 1/${n}, 1/${n - 1} … 로 시도)`;
  steps.push({
    kind: "dnat",
    actor: where,
    text: `${src.outside ? `NodePort ${rule.nodePort} → ` : ""}${rule.clusterIP}:${rule.port} 가 KUBE-SERVICES → ${rule.chain} 에 맞음 → 엔드포인트 ${odds} → ${sep.chain} → DNAT ${sep.ip}:${sep.port} (${sep.pod})`,
    at: { service: rule.name, node: src.node },
  });
  return deliverToIp(c, src, tool, sep.ip, sep.port, shownHost, steps, rule.port);
}

/** Pod IP 로 패킷을 보낸다: 같은 노드면 cni0 브리지, 다른 노드면 flannel VXLAN */
function deliverToIp(c: Cluster, src: Source, tool: Tool, ip: string, port: number, shownHost: string, steps: NetStep[], shownPort = port): NetResult {
  const pod = c.api.peekList("Pod").find((p) => p.status.podIP === ip && p.spec.nodeName);
  const node = c.api.peekList("Node").find((n) => n.spec.podCIDR && inCidr(ip, n.spec.podCIDR));
  if (!node) {
    steps.push({ kind: "route", actor: src.pod ?? src.node, text: `${ip} 는 어떤 노드의 PodCIDR 에도 없음 → 기본 경로로 나갔지만 받는 곳이 없음` });
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: "응답 없음 → 연결 시간 초과" });
    return { ok: false, steps, output: tool === "ping" ? pingOut(shownHost, ip, 0) : `curl: (28) Failed to connect to ${shownHost} port ${shownPort} after 130000 ms: Connection timed out` };
  }
  const dst = node.metadata.name;
  if (dst === src.node) steps.push({ kind: "route", actor: `cni0@${src.node}`, text: `${ip} 는 같은 노드(${src.node}) 의 PodCIDR ${node.spec.podCIDR} → 브리지 cni0 로 바로 전달`, at: { node: dst, pod: pod?.metadata.name } });
  else {
    const nodeIp = node.status.addresses.find((a) => a.type === "InternalIP")?.address;
    steps.push({
      kind: "route",
      actor: `flannel@${src.node}`,
      text: `${ip} 는 ${dst} 의 PodCIDR ${node.spec.podCIDR} → flannel.1 로 VXLAN 캡슐화해 노드 IP ${nodeIp} 로 보냄 → ${dst} 가 풀어서 cni0 로 전달${src.outside ? " (출발지는 노드 IP 로 SNAT — 원래 클라이언트 IP 는 사라짐)" : ""}`,
      at: { node: dst, pod: pod?.metadata.name },
    });
  }
  const timeout = () => {
    steps.push({ kind: "fail", actor: src.pod ?? src.node, text: `${dst} 가 꺼져 있어 아무도 받지 않음 → 시간 초과 (EndpointSlice 에서 빠지기 전까지 요청 일부가 이렇게 실패)` });
    return { ok: false, steps, output: tool === "ping" ? pingOut(shownHost, ip, 0) : `curl: (28) Failed to connect to ${shownHost} port ${shownPort} after 130000 ms: Connection timed out` };
  };
  if (!c.nodePowered(dst)) return timeout();
  if (!pod) {
    steps.push({ kind: "fail", actor: `cni0@${dst}`, text: `${ip} 를 가진 Pod 가 없음 (이미 사라진 Pod 의 IP) → 응답 없음` });
    return { ok: false, steps, output: tool === "ping" ? pingOut(shownHost, ip, 0) : `curl: (7) Failed to connect to ${shownHost} port ${shownPort} after 3 ms: Couldn't connect to server` };
  }
  const app = c.kubelets.get(dst)?.appState(pod.metadata.uid);
  if (tool === "ping") {
    if (!app?.running && !pod.status.podIP) return timeout();
    const ttl = dst === src.node ? 64 : 62;
    steps.push({ kind: "response", actor: pod.metadata.name, text: `Pod 의 네트워크 네임스페이스가 ICMP echo 에 답함 (ttl=${ttl})`, at: { pod: pod.metadata.name } });
    return { ok: true, steps, output: pingOut(shownHost, ip, 3, ttl), servedBy: pod.metadata.name };
  }
  const spec = imageSpec(pod.spec.containers[0]!.image);
  if (!app?.running || spec?.port !== port) {
    const why = !app?.running ? "컨테이너가 돌고 있지 않음" : `앱은 포트 ${spec?.port ?? "(없음)"} 에서 듣는데 ${port} 로 옴 — Service 의 targetPort 를 확인하세요`;
    steps.push({ kind: "fail", actor: pod.metadata.name, text: `${why} → TCP RST → 연결 거부`, at: { pod: pod.metadata.name } });
    return { ok: false, steps, output: `curl: (7) Failed to connect to ${shownHost} port ${shownPort} after 2 ms: Couldn't connect to server` };
  }
  if (app.sick || !app.warm) {
    steps.push({ kind: "response", actor: pod.metadata.name, text: `${pod.metadata.name} 이(가) 받았지만 앱이 준비되지 않음 → HTTP 503`, at: { pod: pod.metadata.name } });
    return { ok: false, steps, output: `<html><body>503 Service Unavailable</body></html>\n(응답한 Pod: ${pod.metadata.name} — 실제 curl 은 이 줄을 찍지 않습니다)`, servedBy: pod.metadata.name };
  }
  steps.push({ kind: "response", actor: pod.metadata.name, text: `${pod.metadata.name} (${ip}:${port}) 의 앱이 HTTP 200 으로 응답`, at: { pod: pod.metadata.name } });
  return { ok: true, steps, output: `${spec.body ?? "OK"}\n(응답한 Pod: ${pod.metadata.name} — 실제 curl 은 이 줄을 찍지 않습니다)`, servedBy: pod.metadata.name };
}

/** 바깥(클러스터 밖 클라이언트)에서 노드IP:NodePort 로 */
export function simulateNodePort(c: Cluster, nodeName: string, nodePort: number): NetResult {
  const steps: NetStep[] = [];
  const node = c.api.get("Node", nodeName);
  const nodeIp = node?.status.addresses.find((a) => a.type === "InternalIP")?.address ?? nodeName;
  if (!node || !c.nodePowered(nodeName)) {
    steps.push({ kind: "fail", actor: "client", text: `${nodeName} 가 꺼져 있어 응답 없음` });
    return { ok: false, steps, output: `curl: (28) Failed to connect to ${nodeIp} port ${nodePort} after 130000 ms: Connection timed out` };
  }
  const rule = c.kubeProxies.get(nodeName)?.currentRules.find((r) => r.nodePort === nodePort);
  if (!rule) {
    steps.push({ kind: "dnat", actor: `iptables@${nodeName}`, text: `KUBE-NODEPORTS 에 ${nodePort} 규칙 없음 (NodePort Service 가 아님) → 연결 거부` });
    return { ok: false, steps, output: `curl: (7) Failed to connect to ${nodeIp} port ${nodePort} after 1 ms: Couldn't connect to server` };
  }
  steps.push({ kind: "route", actor: "client", text: `클러스터 밖 클라이언트 → ${nodeName} (${nodeIp}:${nodePort})`, at: { node: nodeName } });
  return viaService(c, { node: nodeName, outside: true }, rule, nodeIp, steps, "curl");
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
