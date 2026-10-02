// EndpointSlice 컨트롤러: Service 의 셀렉터에 맞는 Pod 중 IP 가 있는 것을 모아 엔드포인트 목록을 만든다.
// 엔드포인트마다 ready(= Pod Ready 이고 지워지는 중이 아님)·terminating 을 적는다 — kube-proxy 는 ready 인 것으로만 보낸다.
// 그래서 Running 이어도 Ready 가 아니면 트래픽을 받지 않는다 (readiness).
// 축소판: Service 하나에 슬라이스 하나 (실제는 엔드포인트 100개마다 나눔), 포트 이름 매핑 없음.
import { refOf } from "../api/server";
import { isPodReady, isPodTerminal, matchesSelector, SERVICE_NAME_LABEL, type Endpoint, type Service } from "../api/types";
import { randomSuffix, stableJson, type Rng } from "../rng";
import { Controller, nsKey, splitKey, type ComponentContext } from "./base";

export class EndpointSliceController extends Controller {
  constructor(
    ctx: ComponentContext,
    private readonly rng: Rng,
  ) {
    super("endpointslice-controller", ctx);
    ctx.api.watch("Service", (ev) => this.enqueue(nsKey(ev.object.metadata.namespace, ev.object.metadata.name)));
    ctx.api.watch("Pod", (ev) => {
      const p = ev.object;
      for (const s of ctx.api.peekList("Service", p.metadata.namespace ?? "default")) {
        if (Object.keys(s.spec.selector).length && matchesSelector(p.metadata.labels, { matchLabels: s.spec.selector })) this.enqueue(nsKey(s.metadata.namespace, s.metadata.name));
      }
    });
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const svc = this.api.get("Service", name, ns);
    if (!svc) return; // Service 가 지워지면 슬라이스는 ownerReference 로 가비지 컬렉터가 지운다
    const endpoints = this.endpointsFor(svc, ns);
    const ports = svc.spec.ports.map((p) => ({ name: p.name, port: p.targetPort, protocol: p.protocol }));
    const slice = this.api.peekList("EndpointSlice", ns).find((s) => s.metadata.labels[SERVICE_NAME_LABEL] === name);
    if (!slice) {
      const sliceName = `${`${name}-`.slice(0, 58)}${randomSuffix(this.rng)}`;
      this.api.create<"EndpointSlice">(
        {
          apiVersion: "discovery.k8s.io/v1",
          kind: "EndpointSlice",
          metadata: {
            name: sliceName,
            namespace: ns,
            labels: { [SERVICE_NAME_LABEL]: name },
            ownerReferences: [{ apiVersion: "v1", kind: "Service", name, uid: svc.metadata.uid, controller: true }],
          },
          addressType: "IPv4",
          endpoints,
          ports,
        },
        this.name,
      );
      this.ctx.trace.add(this.name, "controller.reconcile", `Service ${name} 셀렉터 ${selText(svc)} → EndpointSlice ${sliceName} 생성 (${summary(endpoints)})`, refOf(svc));
      return;
    }
    if (stableJson(slice.endpoints) === stableJson(endpoints) && stableJson(slice.ports) === stableJson(ports)) return;
    const before = summary(slice.endpoints);
    this.api.patch("EndpointSlice", slice.metadata.name, ns, this.name, (o) => {
      o.endpoints = endpoints;
      o.ports = ports;
    });
    this.ctx.trace.add(this.name, "controller.reconcile", `Service ${name} 의 엔드포인트가 바뀜: ${before} → ${summary(endpoints)}`, refOf(svc));
  }

  private endpointsFor(svc: Service, ns: string): Endpoint[] {
    if (!Object.keys(svc.spec.selector).length) return [];
    return this.api
      .peekList("Pod", ns)
      .filter((p) => matchesSelector(p.metadata.labels, { matchLabels: svc.spec.selector }) && p.status.podIP && !isPodTerminal(p))
      .map((p) => {
        const terminating = p.metadata.deletionTimestamp !== undefined;
        const ready = isPodReady(p) && !terminating;
        return {
          addresses: [p.status.podIP!],
          conditions: { ready, serving: isPodReady(p), terminating },
          nodeName: p.spec.nodeName,
          targetRef: { kind: "Pod" as const, name: p.metadata.name, uid: p.metadata.uid },
        };
      })
      .sort((a, b) => (a.targetRef.name < b.targetRef.name ? -1 : 1));
  }
}

function selText(svc: Service): string {
  return Object.entries(svc.spec.selector)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

/** "ready 2 (10.244.1.2, 10.244.2.3) · not ready 1" */
export function summary(eps: Endpoint[]): string {
  const ready = eps.filter((e) => e.conditions.ready);
  const not = eps.length - ready.length;
  if (!eps.length) return "엔드포인트 없음";
  return `ready ${ready.length}${ready.length ? ` (${ready.map((e) => e.addresses[0]).join(", ")})` : ""}${not ? ` · not ready ${not}` : ""}`;
}

