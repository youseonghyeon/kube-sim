// NetworkPolicy 를 화면에서 읽고 고치기 위한 순수 도우미 (인스펙터 개요 문장 · 규칙 폼 ↔ spec).
// 폼의 한 줄 = 규칙 하나(방향 · 상대 하나 · 포트들). 상대가 여럿이거나 폼으로 못 그리는 모양이면 "그대로 둠" 줄로 보여 주고 지우기만 된다.
import type { NetworkPolicy, NetworkPolicyPeer, NetworkPolicyPort } from "../core/api/types";
import { COREDNS, selectorText } from "../core/net/netpol";

type Spec = NetworkPolicy["spec"];
type Rule = { from?: NetworkPolicyPeer[]; to?: NetworkPolicyPeer[]; ports?: NetworkPolicyPort[] };

export type PeerKind = "any" | "app" | "dns" | "cidr" | "other";

export interface NetpolRow {
  dir: "ingress" | "egress";
  peer: PeerKind;
  /** app 이름 또는 CIDR */
  value: string;
  /** "80, 53/UDP" — 비우면 모든 포트·프로토콜 */
  ports: string;
  /** peer 가 other 일 때 원래 규칙 (폼으로 고치지 않고 그대로 되돌려 쓴다) */
  raw?: Rule;
}

const DNS_NS = { matchLabels: { "kubernetes.io/metadata.name": COREDNS.ns } };
const DNS_POD = { matchLabels: { ...COREDNS.labels } };

function peerOf(p: NetworkPolicyPeer): { peer: PeerKind; value: string } {
  if (p.ipBlock && !p.ipBlock.except?.length) return { peer: "cidr", value: p.ipBlock.cidr };
  const pod = p.podSelector?.matchLabels ?? {};
  const ns = p.namespaceSelector?.matchLabels;
  if (ns && ns["kubernetes.io/metadata.name"] === COREDNS.ns && Object.keys(ns).length === 1 && pod["k8s-app"] === "kube-dns" && Object.keys(pod).length === 1) return { peer: "dns", value: "" };
  if (!p.namespaceSelector && !p.ipBlock && Object.keys(pod).length === 1 && pod.app) return { peer: "app", value: pod.app };
  return { peer: "other", value: "" };
}

export function portsText(ports: NetworkPolicyPort[] | undefined): string {
  return (ports ?? []).map((p) => `${p.port ?? "*"}${(p.protocol ?? "TCP") === "TCP" ? "" : `/${p.protocol}`}`).join(", ");
}

/** "80, 53/UDP" 같은 글 → 포트 목록 (* 는 그 프로토콜의 모든 포트). 빈 문자열이면 모든 포트·프로토콜. 잘못되면 오류 문구 */
export function parsePorts(text: string): { ports?: NetworkPolicyPort[] } | { error: string } {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return {};
  const ports: NetworkPolicyPort[] = [];
  for (const part of parts) {
    const m = /^(\d+|\*)(?:\/(TCP|UDP))?$/i.exec(part);
    if (!m || (m[1] !== "*" && (Number(m[1]) < 1 || Number(m[1]) > 65535))) return { error: `"${part}" — 80 · 53/UDP · */UDP 처럼 (비우면 모든 포트)` };
    const proto = (m[2]?.toUpperCase() ?? "TCP") as "TCP" | "UDP";
    ports.push({ protocol: proto, ...(m[1] === "*" ? {} : { port: Number(m[1]) }) });
  }
  return { ports };
}

export function netpolRows(spec: Spec): NetpolRow[] {
  const rows = (dir: "ingress" | "egress", list: Rule[] | undefined): NetpolRow[] =>
    (list ?? []).map((r) => {
      const peers = (dir === "ingress" ? r.from : r.to) ?? [];
      const ports = portsText(r.ports);
      if (!peers.length) return { dir, peer: "any", value: "", ports };
      if (peers.length > 1) return { dir, peer: "other", value: "", ports, raw: structuredClone(r) };
      const p = peerOf(peers[0]!);
      return p.peer === "other" ? { dir, peer: "other", value: "", ports, raw: structuredClone(r) } : { dir, ...p, ports };
    });
  return [...rows("ingress", spec.ingress), ...rows("egress", spec.egress)];
}

function ruleOf(row: NetpolRow): Rule {
  if (row.peer === "other" && row.raw) {
    // 방향을 바꿔도 상대는 그대로 옮긴다 (from ↔ to) — 빠뜨리면 "어디든 허용" 이 된다
    const peers = row.raw.from ?? row.raw.to;
    return { ...(peers ? { [row.dir === "ingress" ? "from" : "to"]: structuredClone(peers) } : {}), ...(row.raw.ports ? { ports: structuredClone(row.raw.ports) } : {}) };
  }
  const parsed = parsePorts(row.ports);
  const ports = "ports" in parsed ? parsed.ports : undefined;
  const peer: NetworkPolicyPeer | undefined =
    row.peer === "app" ? { podSelector: { matchLabels: { app: row.value } } } : row.peer === "dns" ? { namespaceSelector: DNS_NS, podSelector: DNS_POD } : row.peer === "cidr" ? { ipBlock: { cidr: row.value } } : undefined;
  const key = row.dir === "ingress" ? "from" : "to";
  return { ...(peer ? { [key]: [peer] } : {}), ...(ports ? { ports } : {}) };
}

/** 폼의 줄들로 ingress·egress 규칙을 다시 쓴다 (방향 켜기·끄기 policyTypes 는 그대로) */
export function setNetpolRows(spec: Spec, rows: NetpolRow[]): void {
  const ing = rows.filter((r) => r.dir === "ingress").map(ruleOf);
  const eg = rows.filter((r) => r.dir === "egress").map(ruleOf);
  if (ing.length) spec.ingress = ing as Spec["ingress"];
  else delete spec.ingress;
  if (eg.length) spec.egress = eg as Spec["egress"];
  else delete spec.egress;
}

function peerText(p: NetworkPolicyPeer): string {
  const k = peerOf(p);
  if (k.peer === "app") return `app=${k.value} Pod`;
  if (k.peer === "dns") return "CoreDNS (kube-system)";
  if (k.peer === "cidr") return k.value;
  if (p.ipBlock) return `${p.ipBlock.cidr} (except ${(p.ipBlock.except ?? []).join(", ")})`;
  const ns = p.namespaceSelector ? `네임스페이스 ${selectorText(p.namespaceSelector) === "<none>" ? "모두" : selectorText(p.namespaceSelector)}` : "";
  const pod = p.podSelector ? `Pod ${selectorText(p.podSelector) === "<none>" ? "모두" : selectorText(p.podSelector)}` : "";
  return [ns, pod].filter(Boolean).join(" 의 ");
}

/** 규칙 하나를 한 줄 문장으로: "app=client Pod 에서 · TCP 80" */
export function ruleText(dir: "ingress" | "egress", r: Rule): string {
  const peers = (dir === "ingress" ? r.from : r.to) ?? [];
  const who = peers.length ? peers.map(peerText).join(" 또는 ") : "어디든";
  const ports = r.ports?.length ? r.ports.map((p) => `${p.protocol ?? "TCP"} ${p.port ?? "모든 포트"}`).join(", ") : "모든 포트";
  return `${who}${dir === "ingress" ? " 에서" : " 로"} · ${ports}`;
}
