// kube-proxy (iptables 모드 흉내): 노드마다 하나. Service·EndpointSlice 를 watch 해서 그 노드의 iptables 규칙을 다시 쓴다.
// 요청을 처리하는 것은 kube-proxy 가 아니라 커널(netfilter)이다 — kube-proxy 는 규칙만 써 두고, 패킷은 규칙을 따라 DNAT 된다.
// 그래서 ClusterIP 는 어떤 장치에도 붙어 있지 않은 "가상" 주소이고, 규칙은 TCP 포트에만 있어 ping(ICMP)에는 아무도 답하지 않는다.
// 축소판: KUBE-MARK-MASQ·KUBE-POSTROUTING 은 출력에만 보이고 동작은 단순화, sessionAffinity·externalTrafficPolicy 없음.
import { NODE_LEASE_NS, type EndpointSlice, type Service } from "../api/types";
import type { ComponentContext } from "../controllers/base";
import { stableJson } from "../rng";

export interface SepRule {
  chain: string;
  ip: string;
  port: number;
  pod: string;
  nodeName?: string;
}

export interface SvcRule {
  ns: string;
  name: string;
  portName?: string;
  clusterIP: string;
  port: number;
  nodePort?: number;
  chain: string;
  /** ready 인 엔드포인트만 (iptables 모드) */
  seps: SepRule[];
}

export class KubeProxy {
  readonly actor: string;
  private rules: SvcRule[] = [];
  private scheduled = false;
  private powered = true;
  private readonly unwatch: (() => void)[] = [];

  constructor(
    private readonly ctx: ComponentContext,
    readonly nodeName: string,
  ) {
    this.actor = `kube-proxy@${nodeName}`;
    this.unwatch.push(ctx.api.watch("Service", () => this.requestSync()));
    this.unwatch.push(ctx.api.watch("EndpointSlice", () => this.requestSync()));
    this.requestSync();
  }

  get currentRules(): readonly SvcRule[] {
    return this.rules;
  }

  setPower(on: boolean): void {
    this.powered = on;
    if (on) this.requestSync();
  }

  stop(): void {
    for (const u of this.unwatch) u();
    this.powered = false;
  }

  private requestSync(): void {
    if (!this.powered || this.scheduled) return;
    this.scheduled = true;
    // 같은 순간의 변화를 모아 한 번에 (실제 kube-proxy 도 minSyncPeriod 로 모아서 iptables-restore)
    this.ctx.clock.after(0, this.actor, () => {
      this.scheduled = false;
      if (this.powered) this.sync();
    });
  }

  private sync(): void {
    const next = buildRules(this.ctx.api.peekList("Service"), this.ctx.api.peekList("EndpointSlice"));
    const before = new Map(this.rules.map((r) => [r.chain, r]));
    for (const r of next) {
      const old = before.get(r.chain);
      if (old && stableJson(old.seps) === stableJson(r.seps)) continue;
      const what = r.seps.length
        ? `엔드포인트 ${r.seps.length}개 (${r.seps.map((s) => `${s.ip}:${s.port}`).join(", ")}) 로 ${r.chain} 다시 씀`
        : `ready 엔드포인트 없음 → REJECT 규칙 ("has no endpoints")`;
      this.ctx.trace.add(this.actor, "net.rules", `Service ${r.name}${r.portName ? `:${r.portName}` : ""} (${r.clusterIP}:${r.port}) → ${what}`, { kind: "Service", namespace: r.ns, name: r.name });
    }
    for (const [chain, old] of before) {
      if (!next.some((r) => r.chain === chain)) this.ctx.trace.add(this.actor, "net.rules", `Service ${old.name} 이(가) 사라짐 → ${chain} 규칙 삭제`, { kind: "Service", namespace: old.ns, name: old.name });
    }
    this.rules = next;
  }

  /** `iptables-save | grep KUBE` 모양: ready 엔드포인트가 없는 Service 의 REJECT 는 filter 테이블, 나머지(DNAT)는 nat 테이블 */
  iptablesSave(): string {
    const filter: string[] = ["*filter", ":KUBE-SERVICES - [0:0]"];
    for (const r of this.rules) {
      if (r.seps.length) continue;
      const svc = `${r.ns}/${r.name}${r.portName ? `:${r.portName}` : ""}`;
      filter.push(`-A KUBE-SERVICES -d ${r.clusterIP}/32 -p tcp -m comment --comment "${svc} has no endpoints" -m tcp --dport ${r.port} -j REJECT --reject-with icmp-port-unreachable`);
    }
    filter.push("COMMIT");
    const lines: string[] = ["*nat", ":KUBE-SERVICES - [0:0]", ":KUBE-NODEPORTS - [0:0]", ":KUBE-MARK-MASQ - [0:0]"];
    for (const r of this.rules) {
      lines.push(`:${r.chain} - [0:0]`);
      for (const s of r.seps) lines.push(`:${s.chain} - [0:0]`);
    }
    for (const r of this.rules) {
      const svc = `${r.ns}/${r.name}${r.portName ? `:${r.portName}` : ""}`;
      if (!r.seps.length) continue; // filter 테이블의 REJECT 가 맡는다
      lines.push(`-A KUBE-SERVICES -d ${r.clusterIP}/32 -p tcp -m comment --comment "${svc} cluster IP" -m tcp --dport ${r.port} -j ${r.chain}`);
      if (r.nodePort) lines.push(`-A KUBE-NODEPORTS -p tcp -m comment --comment "${svc}" -m tcp --dport ${r.nodePort} -j ${r.chain}`);
      r.seps.forEach((s, i) => {
        const left = r.seps.length - i;
        const prob = left > 1 ? ` -m statistic --mode random --probability ${iptablesProbability(1 / left)}` : "";
        lines.push(`-A ${r.chain} -m comment --comment "${svc} -> ${s.ip}:${s.port}"${prob} -j ${s.chain}`);
      });
      for (const s of r.seps) {
        lines.push(`-A ${s.chain} -s ${s.ip}/32 -m comment --comment "${svc}" -j KUBE-MARK-MASQ`);
        lines.push(`-A ${s.chain} -p tcp -m comment --comment "${svc}" -m tcp -j DNAT --to-destination ${s.ip}:${s.port}`);
      }
    }
    lines.push("-A KUBE-SERVICES -m comment --comment \"kubernetes service nodeports; NOTE: this must be the last rule in this chain\" -m addrtype --dst-type LOCAL -j KUBE-NODEPORTS", "COMMIT");
    return [...filter, ...lines].join("\n");
  }
}

export function buildRules(services: readonly Service[], slices: readonly EndpointSlice[]): SvcRule[] {
  const out: SvcRule[] = [];
  for (const svc of [...services].sort((a, b) => (a.metadata.name < b.metadata.name ? -1 : 1))) {
    if (!svc.spec.clusterIP || svc.metadata.namespace === NODE_LEASE_NS) continue;
    const ns = svc.metadata.namespace ?? "default";
    const mine = slices.filter((s) => (s.metadata.namespace ?? "default") === ns && s.metadata.labels["kubernetes.io/service-name"] === svc.metadata.name);
    for (const p of svc.spec.ports) {
      const key = `${ns}/${svc.metadata.name}${p.name ? `:${p.name}` : ""}`;
      const seps: SepRule[] = [];
      for (const sl of mine) {
        for (const e of sl.endpoints) {
          if (!e.conditions.ready) continue;
          const ip = e.addresses[0]!;
          seps.push({ chain: `KUBE-SEP-${chainHash(`${key}/tcp/${ip}:${p.targetPort}`)}`, ip, port: p.targetPort, pod: e.targetRef.name, nodeName: e.nodeName });
        }
      }
      seps.sort((a, b) => (a.ip < b.ip ? -1 : 1));
      out.push({ ns, name: svc.metadata.name, portName: p.name, clusterIP: svc.spec.clusterIP, port: p.port, nodePort: p.nodePort, chain: `KUBE-SVC-${chainHash(`${key}/tcp`)}`, seps });
    }
  }
  return out;
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** kube-proxy 의 체인 이름처럼 16자 base32 (실제는 sha256 — 여기서는 FNV 두 번, 모양만 같다) */
export function chainHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ s.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 16; i++) {
    const v = i < 8 ? h1 >>> ((i * 4) % 28) : h2 >>> (((i - 8) * 4) % 28);
    out += B32[(v ^ (i * 7)) & 31];
  }
  return out;
}

/** iptables statistic 모듈이 저장·출력하는 확률 (2^31 단위로 반올림, 소수 11자리) — 1/3 → 0.33333333349 */
export function iptablesProbability(p: number): string {
  return (Math.round(p * 2 ** 31) / 2 ** 31).toFixed(11);
}
