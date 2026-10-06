// NetworkPolicy 판단 (k3s 의 kube-router 처럼 노드에서 건다). 순수 함수 — 요청 흉내(request.ts)와 화면이 같이 쓴다.
// 규칙: Pod 를 고르는 정책이 하나라도 있으면 그 방향은 기본 차단, 고른 정책들의 규칙 중 하나라도 맞으면 허용 (더해진다).
// 판단은 DNAT 뒤의 Pod IP·포트로 한다. Pod 가 도는 노드에서 오가는 트래픽(probe 등)은 늘 허용.
// 축소판: 네임스페이스는 default 와 kube-system(CoreDNS 만) 둘, named port·endPort·SCTP 없음, 연결 추적(응답 방향 허용)은 따로 그리지 않는다.
import type { NetworkPolicy, NetworkPolicyPeer, NetworkPolicyPort, Pod, Selector } from "../api/types";
import type { Cluster } from "../cluster";

export type Proto = "TCP" | "UDP" | "ICMP";

/** CoreDNS 는 Pod 로 그리지 않지만 정책에서는 kube-system 의 k8s-app=kube-dns Pod 로 본다 */
export const COREDNS = { ns: "kube-system", labels: { "k8s-app": "kube-dns" }, ip: "10.244.0.10" } as const;

/** 한쪽 끝: Pod 이거나 (클러스터 밖·노드) IP 만 */
export interface Peer {
  pod?: Pod;
  /** Pod 가 아닌 끝의 이름표 (CoreDNS) */
  labels?: Record<string, string>;
  ns?: string;
  ip: string;
}

export interface Verdict {
  allowed: boolean;
  /** 막혔다면 어느 쪽에서 */
  blockedAt?: "egress" | "ingress";
  /** 격리한 정책들 (막힌 쪽) */
  policies: string[];
  /** 허용했다면 맞은 정책 (격리돼 있을 때만) */
  allowedBy: { egress?: string; ingress?: string };
}

export function selects(sel: Selector | undefined, labels: Record<string, string>): boolean {
  return Object.entries(sel?.matchLabels ?? {}).every(([k, v]) => labels[k] === v);
}

export function selectorText(sel: Selector | undefined): string {
  const e = Object.entries(sel?.matchLabels ?? {});
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(",") : "<none>";
}

function nsLabels(ns: string): Record<string, string> {
  return { "kubernetes.io/metadata.name": ns };
}

function ipNum(ip: string): number {
  return ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const b = Number(bits);
  if (!base || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return ((ipNum(ip) & mask) >>> 0) === ((ipNum(base) & mask) >>> 0);
}

function peerLabels(p: Peer): { labels: Record<string, string>; ns: string } | undefined {
  if (p.pod) return { labels: p.pod.metadata.labels, ns: p.pod.metadata.namespace ?? "default" };
  if (p.labels) return { labels: p.labels, ns: p.ns ?? "default" };
  return undefined;
}

function peerMatches(rule: NetworkPolicyPeer, policyNs: string, other: Peer): boolean {
  if (rule.ipBlock) return inCidr(other.ip, rule.ipBlock.cidr) && !(rule.ipBlock.except ?? []).some((x) => inCidr(other.ip, x));
  const who = peerLabels(other);
  if (!who) return false; // Pod 가 아닌 것은 셀렉터로 고를 수 없다 (ipBlock 으로만)
  if (rule.namespaceSelector && !selects(rule.namespaceSelector, nsLabels(who.ns))) return false;
  if (!rule.namespaceSelector && who.ns !== policyNs) return false;
  return rule.podSelector ? selects(rule.podSelector, who.labels) : true;
}

function portMatches(ports: NetworkPolicyPort[] | undefined, port: number | undefined, proto: Proto): boolean {
  if (!ports?.length) return true;
  if (proto === "ICMP") return false;
  return ports.some((p) => (p.protocol ?? "TCP") === proto && (p.port === undefined || p.port === port));
}

/** 이 Pod 를 고르는 정책들 (방향별) */
export function isolation(c: Cluster, pod: Pod): { ingress: NetworkPolicy[]; egress: NetworkPolicy[] } {
  const ns = pod.metadata.namespace ?? "default";
  const mine = c.api.peekList("NetworkPolicy", ns).filter((np) => selects(np.spec.podSelector, pod.metadata.labels));
  return {
    ingress: mine.filter((np) => (np.spec.policyTypes ?? ["Ingress"]).includes("Ingress")),
    egress: mine.filter((np) => (np.spec.policyTypes ?? []).includes("Egress")),
  };
}

/** from → to (port, proto) 가 지나가는가: 먼저 보내는 Pod 의 egress, 다음 받는 Pod 의 ingress */
export function check(c: Cluster, from: Peer, to: Peer, port: number | undefined, proto: Proto): Verdict {
  const allowedBy: Verdict["allowedBy"] = {};
  if (from.pod) {
    const iso = isolation(c, from.pod).egress;
    const toNode = !to.pod && !to.labels && from.pod.status.hostIP === to.ip;
    if (iso.length && !toNode) {
      const hit = iso.find((np) => (np.spec.egress ?? []).some((r) => (!r.to?.length || r.to.some((p) => peerMatches(p, np.metadata.namespace ?? "default", to))) && portMatches(r.ports, port, proto)));
      if (!hit) return { allowed: false, blockedAt: "egress", policies: iso.map((p) => p.metadata.name), allowedBy };
      allowedBy.egress = hit.metadata.name;
    }
  }
  if (to.pod) {
    const iso = isolation(c, to.pod).ingress;
    const fromNode = !from.pod && to.pod.status.hostIP === from.ip;
    if (iso.length && !fromNode) {
      const hit = iso.find((np) => (np.spec.ingress ?? []).some((r) => (!r.from?.length || r.from.some((p) => peerMatches(p, np.metadata.namespace ?? "default", from))) && portMatches(r.ports, port, proto)));
      if (!hit) return { allowed: false, blockedAt: "ingress", policies: iso.map((p) => p.metadata.name), allowedBy };
      allowedBy.ingress = hit.metadata.name;
    }
  }
  return { allowed: true, policies: [], allowedBy };
}

/** 사람이 읽는 끝 이름: Pod 이름(app=…), CoreDNS, 또는 IP */
export function peerName(p: Peer): string {
  if (p.pod) return `${p.pod.metadata.name}${p.pod.metadata.labels.app ? ` (app=${p.pod.metadata.labels.app})` : ""}`;
  if (p.labels) return `CoreDNS (${p.ns})`;
  return p.ip;
}
