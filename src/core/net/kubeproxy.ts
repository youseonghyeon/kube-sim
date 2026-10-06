// kube-proxy (iptables 모드 흉내): 노드마다 하나. Service·EndpointSlice 를 watch 해서 그 노드의 iptables 규칙을 다시 쓴다.
// 요청을 처리하는 것은 kube-proxy 가 아니라 커널(netfilter)이다 — kube-proxy 는 규칙만 써 두고, 패킷은 규칙을 따라 DNAT 된다.
// 그래서 ClusterIP 는 어떤 장치에도 붙어 있지 않은 "가상" 주소이고, 규칙은 TCP 포트에만 있어 ping(ICMP)에는 아무도 답하지 않는다.
// 축소판: KUBE-MARK-MASQ·KUBE-POSTROUTING 은 출력에만 보이고 동작은 단순화, sessionAffinity·externalTrafficPolicy 없음.
import { NODE_LEASE_NS, type EndpointSlice, type Service } from "../api/types";
import type { ComponentContext } from "../controllers/base";
import { stableJson } from "../rng";

/**
 * 엔드포인트가 바뀐 뒤 이 노드의 규칙에 반영되기까지 (학습용 값, 축소판).
 * 실제로는 watch 전달 + minSyncPeriod(기본 1초) + iptables-restore 시간이 겹쳐 큰 클러스터에서 1~수 초가 걸린다.
 * 이 틈 때문에 Pod 를 지우면 SIGTERM 으로 앱이 먼저 멈추고, 아직 남은 규칙으로 온 요청이 실패한다 (preStop sleep 으로 해결).
 */
export const RULE_SYNC_MS = 1000;

export interface SepRule {
  chain: string;
  ip: string;
  port: number;
  pod: string;
  nodeName?: string;
  /** false 면 지워지는 중(terminating)이지만 아직 serving — ready 인 것이 없을 때만 쓴다 */
  ready: boolean;
}

export interface SvcRule {
  ns: string;
  name: string;
  portName?: string;
  clusterIP: string;
  port: number;
  nodePort?: number;
  /** MetalLB 가 준 LoadBalancer IP */
  lbIP?: string;
  externalTrafficPolicy?: "Cluster" | "Local";
  chain: string;
  /** 보낼 엔드포인트: ready 인 것, 하나도 없으면 terminating·serving 인 것 (ProxyTerminatingEndpoints, 1.28 GA) */
  seps: SepRule[];
  /** ready 이거나 terminating·serving 인 엔드포인트 전부 — Local 의 노드별 고르기에 쓴다 */
  candidates: SepRule[];
}

/** externalTrafficPolicy: Local 에서 이 노드가 보낼 엔드포인트: 이 노드의 ready, 없으면 이 노드의 terminating·serving (pkg/proxy/topology.go) */
export function localSeps(rule: SvcRule, node: string | undefined): SepRule[] {
  const mine = rule.candidates.filter((s) => s.nodeName === node);
  const ready = mine.filter((s) => s.ready);
  return ready.length ? ready : mine;
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
    // 변화를 모아 RULE_SYNC_MS 뒤에 한 번에 iptables-restore (그사이 노드의 규칙은 옛것 그대로)
    this.ctx.clock.after(RULE_SYNC_MS, this.actor, () => {
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
      const what = !r.seps.length
        ? `ready 엔드포인트 없음 → REJECT 규칙 ("has no endpoints")`
        : r.seps[0]!.ready
          ? `엔드포인트 ${r.seps.length}개 (${r.seps.map((s) => `${s.ip}:${s.port}`).join(", ")}) 로 ${r.chain} 다시 씀`
          : `ready 엔드포인트 없음 → 지워지는 중이지만 아직 serving 인 ${r.seps.length}개 (${r.seps.map((s) => `${s.ip}:${s.port}`).join(", ")}) 로 보냄 (ProxyTerminatingEndpoints) — ${r.chain} 다시 씀`;
      this.ctx.trace.add(this.actor, "net.rules", `Service ${r.name}${r.portName ? `:${r.portName}` : ""} (${r.clusterIP}:${r.port}) → ${what}`, { kind: "Service", namespace: r.ns, name: r.name });
    }
    for (const [chain, old] of before) {
      if (!next.some((r) => r.chain === chain)) this.ctx.trace.add(this.actor, "net.rules", `Service ${old.name} 이(가) 사라짐 → ${chain} 규칙 삭제`, { kind: "Service", namespace: old.ns, name: old.name });
    }
    this.rules = next;
  }

  /** `iptables-save | grep KUBE` 모양: ready 엔드포인트가 없는 Service 의 REJECT 는 filter 테이블, 나머지(DNAT)는 nat 테이블 */
  iptablesSave(): string {
    const filter: string[] = ["*filter", ":KUBE-SERVICES - [0:0]", ":KUBE-EXTERNAL-SERVICES - [0:0]"];
    for (const r of this.rules) {
      if (r.seps.length) continue;
      const svc = `${r.ns}/${r.name}${r.portName ? `:${r.portName}` : ""}`;
      filter.push(`-A KUBE-SERVICES -d ${r.clusterIP}/32 -p tcp -m comment --comment "${svc} has no endpoints" -m tcp --dport ${r.port} -j REJECT --reject-with icmp-port-unreachable`);
      // 바깥으로 열린 주소(LoadBalancer IP·NodePort)도 같은 이유로 거절
      if (r.lbIP) filter.push(`-A KUBE-EXTERNAL-SERVICES -d ${r.lbIP}/32 -p tcp -m comment --comment "${svc} has no endpoints" -m tcp --dport ${r.port} -j REJECT --reject-with icmp-port-unreachable`);
      if (r.nodePort) filter.push(`-A KUBE-EXTERNAL-SERVICES -p tcp -m comment --comment "${svc} has no endpoints" -m addrtype --dst-type LOCAL -m tcp --dport ${r.nodePort} -j REJECT --reject-with icmp-port-unreachable`);
    }
    // Local 인데 이 노드에 엔드포인트가 없으면: 바깥에서 온 것은 filter 테이블에서 버린다 (nat 의 KUBE-SVL 점프는 생략)
    for (const r of this.rules) {
      if (!r.seps.length || r.externalTrafficPolicy !== "Local" || localSeps(r, this.nodeName).length) continue;
      const svc = `${r.ns}/${r.name}${r.portName ? `:${r.portName}` : ""}`;
      if (r.lbIP) filter.push(`-A KUBE-EXTERNAL-SERVICES -d ${r.lbIP}/32 -p tcp -m comment --comment "${svc} has no local endpoints" -m tcp --dport ${r.port} -j DROP`);
      if (r.nodePort) filter.push(`-A KUBE-EXTERNAL-SERVICES -p tcp -m comment --comment "${svc} has no local endpoints" -m addrtype --dst-type LOCAL -m tcp --dport ${r.nodePort} -j DROP`);
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
      if (r.nodePort || r.lbIP) {
        // 바깥에서 온 것: KUBE-EXT → Cluster 면 SNAT 표시 후 모든 엔드포인트, Local 이면 이 노드의 엔드포인트만(KUBE-SVL)
        const ext = r.chain.replace("KUBE-SVC-", "KUBE-EXT-");
        if (r.lbIP) lines.push(`-A KUBE-SERVICES -d ${r.lbIP}/32 -p tcp -m comment --comment "${svc} loadbalancer IP" -m tcp --dport ${r.port} -j ${ext}`);
        if (r.nodePort) lines.push(`-A KUBE-NODEPORTS -p tcp -m comment --comment "${svc}" -m tcp --dport ${r.nodePort} -j ${ext}`);
        if (r.externalTrafficPolicy === "Local") {
          const svl = r.chain.replace("KUBE-SVC-", "KUBE-SVL-");
          // 클러스터 안(Pod 대역)에서 온 것은 Local 과 상관없이 모든 엔드포인트로
          lines.push(`-A ${ext} -s 10.244.0.0/16 -m comment --comment "pod traffic for ${svc} external destinations" -j ${r.chain}`);
          const local = localSeps(r, this.nodeName);
          // 로컬 엔드포인트가 없으면 KUBE-SVL 로 넘기지 않는다 (filter 테이블의 DROP 이 맡음)
          if (local.length) lines.push(`-A ${ext} -m comment --comment "${svc} (externalTrafficPolicy: Local)" -j ${svl}`);
          local.forEach((s, i) => {
            const left = local.length - i;
            const prob = left > 1 ? ` -m statistic --mode random --probability ${iptablesProbability(1 / left)}` : "";
            lines.push(`-A ${svl} -m comment --comment "${svc} -> ${s.ip}:${s.port}"${prob} -j ${s.chain}`);
          });
        } else {
          lines.push(`-A ${ext} -m comment --comment "masquerade traffic for ${svc} external destinations" -j KUBE-MARK-MASQ`);
          lines.push(`-A ${ext} -j ${r.chain}`);
        }
      }
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
    // headless(clusterIP: None) 는 가상 주소가 없어 규칙도 없다 — DNS 가 Pod IP 를 바로 준다
    if (!svc.spec.clusterIP || svc.spec.clusterIP === "None" || svc.metadata.namespace === NODE_LEASE_NS) continue;
    const ns = svc.metadata.namespace ?? "default";
    const mine = slices.filter((s) => (s.metadata.namespace ?? "default") === ns && s.metadata.labels["kubernetes.io/service-name"] === svc.metadata.name);
    for (const p of svc.spec.ports) {
      const key = `${ns}/${svc.metadata.name}${p.name ? `:${p.name}` : ""}`;
      const candidates: SepRule[] = [];
      for (const sl of mine) {
        for (const e of sl.endpoints) {
          const ready = e.conditions.ready;
          if (!ready && !(e.conditions.serving && e.conditions.terminating)) continue;
          const ip = e.addresses[0]!;
          candidates.push({ chain: `KUBE-SEP-${chainHash(`${key}/tcp/${ip}:${p.targetPort}`)}`, ip, port: p.targetPort, pod: e.targetRef.name, nodeName: e.nodeName, ready });
        }
      }
      candidates.sort((a, b) => (a.ip < b.ip ? -1 : 1));
      const readySeps = candidates.filter((s) => s.ready);
      const seps = readySeps.length ? readySeps : candidates;
      out.push({
        ns,
        name: svc.metadata.name,
        portName: p.name,
        clusterIP: svc.spec.clusterIP,
        port: p.port,
        nodePort: p.nodePort,
        lbIP: svc.status.loadBalancer?.ingress?.[0]?.ip,
        externalTrafficPolicy: svc.spec.externalTrafficPolicy,
        chain: `KUBE-SVC-${chainHash(`${key}/tcp`)}`,
        seps,
        candidates,
      });
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
