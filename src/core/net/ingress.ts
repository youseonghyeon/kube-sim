// 바깥에서 들어오는 길의 부품들 (4단계).
// - MetalLB(L2): LoadBalancer Service 에 주소 풀(192.168.0.240~250)에서 IP 를 주고, 노드 하나가 그 IP 를 ARP 로 맡는다(announce).
//   externalTrafficPolicy: Local 이면 그 Service 의 Ready Pod 가 있는 노드만 맡을 수 있다.
// - ingress-nginx 의 상태 기록: ingressClassName nginx 인 Ingress 의 ADDRESS 에 ingress-nginx-controller Service 의 LoadBalancer IP 를 적는다.
// - Tailscale 오퍼레이터: ingressClassName tailscale 인 Ingress 마다 프록시 Pod(ts-<이름>)를 만들고, ADDRESS 에 <이름>.<tailnet>.ts.net 을 적는다.
// 축소판: MetalLB·오퍼레이터는 Pod 없이 클러스터 부가 기능으로 돈다(MetalLB speaker 는 노드 전원으로 산다고 본다), 프록시는 StatefulSet 대신 Deployment,
//         네임스페이스는 default 하나, tailnet 이름은 가짜(TAILNET).
import { refOf } from "../api/server";
import { SERVICE_NAME_LABEL, type Ingress, type IngressBackend, type Service } from "../api/types";
import type { ComponentContext } from "../controllers/base";
import { Controller, nsKey, splitKey } from "../controllers/base";
import { stableJson } from "../rng";

export const LB_POOL = Array.from({ length: 11 }, (_, i) => `192.168.0.${240 + i}`);
export const TAILNET = "tailnet-1234.ts.net";
export const NGINX_SERVICE = "ingress-nginx-controller";
export const TS_PROXY_IMAGE = "tailscale/tailscale:v1.76.6";
const FUNNEL = "tailscale.com/funnel";

export function lbIP(svc: Service): string | undefined {
  return svc.status.loadBalancer?.ingress?.[0]?.ip;
}

export function ingressAddress(ing: Ingress): string | undefined {
  const a = ing.status.loadBalancer.ingress?.[0];
  return a?.ip ?? a?.hostname;
}

export function funnelOn(ing: Ingress): boolean {
  return ing.metadata.annotations?.[FUNNEL] === "true";
}

/** MetalLB: IP 할당(controller) + 어느 노드가 그 IP 를 맡는지(speaker) */
export class MetalLB extends Controller {
  private readonly announce = new Map<string, string | undefined>();

  constructor(
    ctx: ComponentContext,
    private readonly powered: (node: string) => boolean,
  ) {
    super("metallb-controller", ctx);
    ctx.api.watch("Service", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("EndpointSlice", (ev) => {
      const svc = ev.object.metadata.labels[SERVICE_NAME_LABEL];
      if (svc) this.enqueue(nsKey(ev.object.metadata.namespace, svc));
    });
    ctx.api.watch("Node", () => this.all());
  }

  /** 노드 전원이 바뀐 것은 API 가 모르므로 클러스터가 직접 알린다 */
  all(): void {
    for (const s of this.api.peekList("Service")) if (s.spec.type === "LoadBalancer") this.enqueue(nsKey(s.metadata.namespace, s.metadata.name));
  }

  /** 지금 이 LoadBalancer IP 를 ARP 로 맡은 노드 */
  announcer(ns: string, name: string): string | undefined {
    return this.announce.get(nsKey(ns, name));
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const svc = this.api.get("Service", name, ns);
    if (!svc || svc.spec.type !== "LoadBalancer") {
      this.announce.delete(key);
      if (svc && svc.status.loadBalancer?.ingress?.length) {
        this.api.patch("Service", name, ns, this.name, (o) => {
          o.status = {};
        });
        this.ctx.trace.add(this.name, "net.lb", `Service ${name} 이(가) LoadBalancer 가 아님 → IP ${lbIP(svc)} 반납`, refOf(svc));
      }
      return;
    }
    let ip = lbIP(svc);
    if (!ip) {
      const used = new Set(this.api.peekList("Service").map(lbIP).filter(Boolean));
      ip = LB_POOL.find((x) => !used.has(x));
      if (!ip) {
        this.api.recordEvent(svc, "Warning", "AllocationFailed", "Failed to allocate IP for \"default/" + name + "\": no available IPs", this.name);
        this.ctx.trace.add(this.name, "net.lb", `Service ${name} 에 줄 IP 가 풀에 없음 (192.168.0.240~250 모두 사용 중) → EXTERNAL-IP <pending>`, refOf(svc));
        return;
      }
      const assigned = ip;
      this.api.patch("Service", name, ns, this.name, (o) => {
        o.status = { loadBalancer: { ingress: [{ ip: assigned }] } };
      });
      this.api.recordEvent(svc, "Normal", "IPAllocated", `Assigned IP ["${assigned}"]`, this.name);
      this.ctx.trace.add(this.name, "net.lb", `LoadBalancer Service ${name} → 주소 풀에서 ${assigned} 할당 (EXTERNAL-IP)`, refOf(svc));
    }
    // speaker: 맡을 수 있는 노드 중 하나 (이름·Service 로 정한 순서 — 결정론). Local 이면 Ready Pod 가 있는 노드만
    const local = svc.spec.externalTrafficPolicy === "Local";
    const readyNodes = new Set(
      this.api
        .peekList("EndpointSlice", ns)
        .filter((s) => s.metadata.labels[SERVICE_NAME_LABEL] === name)
        .flatMap((s) => s.endpoints.filter((e) => e.conditions.ready).map((e) => e.nodeName)),
    );
    const candidates = this.api
      .peekList("Node")
      .filter((n) => this.powered(n.metadata.name) && (!local || readyNodes.has(n.metadata.name)))
      .map((n) => n.metadata.name)
      .sort((a, b) => hash(`${a}/${name}`) - hash(`${b}/${name}`) || (a < b ? -1 : 1));
    const prev = this.announce.get(key);
    // 이미 맡은 노드가 계속 자격이 있으면 바꾸지 않는다 (불필요한 ARP 전환 방지)
    const next = prev && candidates.includes(prev) ? prev : candidates[0];
    if (next === prev) return;
    this.announce.set(key, next);
    if (next) {
      this.api.recordEvent(svc, "Normal", "nodeAssigned", `announcing from node "${next}" with protocol "layer2"`, "metallb-speaker");
      this.ctx.trace.add(
        `metallb-speaker@${next}`,
        "net.lb",
        `${ip} 를 ${next} 가 맡음 (L2: ARP 에 이 노드 MAC 으로 답함)${prev ? ` — 전에 맡던 ${prev} ${this.powered(prev) ? "는 자격 없음 (Local: Pod 가 없음)" : "가 꺼짐"}` : ""}${local ? " · Local 이라 Ready Pod 가 있는 노드만 후보" : ""}`,
        refOf(svc),
      );
    } else {
      this.ctx.trace.add("metallb-speaker", "net.lb", `${ip} 를 맡을 노드가 없음${local ? " (Local: Ready Pod 가 있는 노드가 없음)" : ""} → 바깥에서 이 IP 로 오는 요청은 갈 곳이 없다`, refOf(svc));
    }
  }
}

/** ingress-nginx: nginx 클래스 Ingress 의 ADDRESS 를 컨트롤러 Service 의 LoadBalancer IP 로 */
export class IngressNginxStatus extends Controller {
  constructor(ctx: ComponentContext) {
    super("ingress-nginx-controller", ctx);
    ctx.api.watch("Ingress", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("Service", (ev) => {
      if (ev.object.metadata.name !== NGINX_SERVICE) return;
      for (const i of ctx.api.peekList("Ingress")) this.enqueue(nsKey(i.metadata.namespace, i.metadata.name));
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const ing = this.api.get("Ingress", name, ns);
    if (!ing || ing.spec.ingressClassName !== "nginx") return;
    const svc = this.api.get("Service", NGINX_SERVICE, ns);
    const ip = svc ? lbIP(svc) : undefined;
    const want = ip ? { ingress: [{ ip }] } : {};
    if (stableJson(ing.status.loadBalancer) === stableJson(want)) return;
    this.api.patch("Ingress", name, ns, this.name, (o) => {
      o.status = { loadBalancer: want };
    });
    if (ip) this.ctx.trace.add(this.name, "net.lb", `Ingress ${name} 의 ADDRESS ← ${NGINX_SERVICE} Service 의 LoadBalancer IP ${ip}`, refOf(ing));
  }
}

/** Tailscale 오퍼레이터: tailscale 클래스 Ingress 마다 프록시 Pod 를 띄우고 tailnet 이름을 ADDRESS 에 */
export class TailscaleOperator extends Controller {
  constructor(ctx: ComponentContext) {
    super("tailscale-operator", ctx);
    ctx.api.watch("Ingress", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const ing = this.api.get("Ingress", name, ns);
    if (!ing || ing.spec.ingressClassName !== "tailscale") return;
    const proxy = proxyName(name);
    if (!this.api.get("Deployment", proxy, ns)) {
      this.api.create<"Deployment">(
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          metadata: { name: proxy, namespace: ns, labels: { "tailscale.com/parent-resource": name }, ownerReferences: [{ apiVersion: "networking.k8s.io/v1", kind: "Ingress", name, uid: ing.metadata.uid, controller: true }] },
          spec: {
            replicas: 1,
            selector: { matchLabels: { "tailscale.com/parent-resource": name } },
            template: {
              metadata: { labels: { "tailscale.com/parent-resource": name } },
              spec: { containers: [{ name: "tailscale", image: TS_PROXY_IMAGE, resources: { requests: { cpu: 50, memory: 64 } } }], restartPolicy: "Always", terminationGracePeriodSeconds: 30 },
            },
          },
        },
        this.name,
      );
      this.ctx.trace.add(this.name, "net.lb", `Ingress ${name} (class tailscale) → 프록시 ${proxy} 생성 — tailnet 기기 ${hostOf(ing)} 로 붙어 TLS 를 끝내고 backend Service 로 보낸다${funnelOn(ing) ? " · funnel 켜짐: 공인 인터넷에서도 접근" : ""}`, refOf(ing));
    }
    const host = `${hostOf(ing)}.${TAILNET}`;
    if (ing.status.loadBalancer.ingress?.[0]?.hostname === host) return;
    this.api.patch("Ingress", name, ns, this.name, (o) => {
      o.status = { loadBalancer: { ingress: [{ hostname: host }] } };
    });
  }
}

export function proxyName(ingress: string): string {
  return `ts-${ingress}`;
}

/** tailnet 기기 이름: tls.hosts 첫 번째, 없으면 Ingress 이름 */
function hostOf(ing: Ingress): string {
  return ing.spec.tls?.[0]?.hosts[0] ?? ing.metadata.name;
}

/** ingress-nginx 의 규칙 고르기: 호스트가 같은 규칙에서 Exact 우선, 그다음 가장 긴 Prefix, 없으면 defaultBackend */
export function matchIngress(ings: readonly Ingress[], host: string, path: string): { ing: Ingress; backend: IngressBackend; how: string } | undefined {
  let best: { ing: Ingress; backend: IngressBackend; how: string; score: number } | undefined;
  for (const ing of ings) {
    for (const r of ing.spec.rules ?? []) {
      if (r.host && r.host !== host) continue;
      for (const p of r.http.paths) {
        const exact = p.pathType === "Exact" && path === p.path;
        const prefix = p.pathType === "Prefix" && (p.path === "/" || path === p.path || path.startsWith(p.path.endsWith("/") ? p.path : `${p.path}/`));
        if (!exact && !prefix) continue;
        const score = (exact ? 10_000 : 0) + p.path.length + (r.host ? 1000 : 0);
        if (!best || score > best.score) best = { ing, backend: p.backend, how: `${r.host ?? "*"} ${p.path} (${p.pathType})`, score };
      }
    }
  }
  if (best) return best;
  const def = ings.find((i) => i.spec.defaultBackend);
  return def ? { ing: def, backend: def.spec.defaultBackend!, how: "defaultBackend" } : undefined;
}

/** Service 의 ready 엔드포인트 (Pod IP:targetPort) — ingress-nginx 는 ClusterIP 를 거치지 않고 이것으로 바로 보낸다 */
export function readyEndpoints(ctx: { api: ComponentContext["api"] }, ns: string, svc: Service, port: number): { ip: string; port: number; pod: string }[] {
  const sp = svc.spec.ports.find((p) => p.port === port);
  if (!sp) return [];
  return ctx.api
    .peekList("EndpointSlice", ns)
    .filter((s) => s.metadata.labels[SERVICE_NAME_LABEL] === svc.metadata.name)
    .flatMap((s) => s.endpoints.filter((e) => e.conditions.ready).map((e) => ({ ip: e.addresses[0]!, port: sp.targetPort, pod: e.targetRef.name })));
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

