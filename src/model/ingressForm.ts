// Ingress 를 화면에서 만들고 고치기 위한 순수 도우미 (인스펙터 폼 ↔ 매니페스트).
// 규칙은 host 아래 경로들로 묶여 있지만(rules[].http.paths[]) 폼에서는 한 줄 = host·경로·Service·포트 로 편다.
import type { IngressPath } from "../core/api/types";
import { deployment, ingress, service, type IngressManifest, type Manifest } from "../core/cluster";
import { NGINX_SERVICE } from "../core/net/ingress";

export interface RuleRow {
  /** 비우면 모든 Host (*) */
  host: string;
  path: string;
  pathType: IngressPath["pathType"];
  service: string;
  port: number;
}

export function flattenRules(m: IngressManifest): RuleRow[] {
  return (m.spec.rules ?? []).flatMap((r) =>
    r.http.paths.map((p) => ({ host: r.host ?? "", path: p.path, pathType: p.pathType, service: p.backend.service.name, port: p.backend.service.port.number })),
  );
}

/** 폼의 줄들을 host 별로 다시 묶는다 (처음 나온 순서대로) */
export function buildRules(rows: RuleRow[]): IngressManifest["spec"]["rules"] {
  const byHost = new Map<string, IngressPath[]>();
  for (const r of rows) {
    const paths = byHost.get(r.host) ?? byHost.set(r.host, []).get(r.host)!;
    paths.push({ path: r.path, pathType: r.pathType, backend: { service: { name: r.service, port: { number: r.port } } } });
  }
  return [...byHost].map(([host, paths]) => ({ ...(host ? { host } : {}), http: { paths } }));
}

/** 폼에서 줄 하나를 바꿔 매니페스트에 다시 쓴다 (빈 규칙이면 rules 를 지운다) */
export function setRules(m: IngressManifest, rows: RuleRow[]): void {
  const rules = buildRules(rows);
  if (rules?.length) m.spec.rules = rules;
  else delete m.spec.rules;
}

/** Host 는 비우거나(모든 Host) 소문자 도메인 (실제 API 검사: RFC 1123 서브도메인, IP 는 안 됨) */
export function hostError(v: string): string | undefined {
  if (!v) return undefined;
  if (v.length > 253 || v.split(".").some((l) => l.length > 63)) return "도메인은 253자, 점 사이 한 칸은 63자 이하여야 합니다";
  if (/^\d+(\.\d+){3}$/.test(v)) return "Host 에 IP 는 쓸 수 없습니다 (도메인을 쓰거나 비워 두세요)";
  return /^(\*\.)?[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(v) ? undefined : "소문자 도메인으로 쓰세요 (예: shop.example.com)";
}

export function pathError(v: string): string | undefined {
  return v.startsWith("/") ? undefined : "경로는 / 로 시작해야 합니다";
}

/**
 * "+ Ingress": 첫 Service(ingress-nginx 의 것은 빼고, 아직 어느 Ingress 도 가리키지 않는 것 먼저)를 가리키는 Ingress.
 * ingress-nginx 컨트롤러가 있으면 nginx 클래스(Host 규칙), 없으면 따로 설치할 것 없이 도는 tailscale 클래스(기본 backend).
 */
export function newIngress(name: string, services: { name: string; port: number }[], used: Set<string>, hasNginx: boolean): IngressManifest | undefined {
  const candidates = services.filter((s) => s.name !== NGINX_SERVICE);
  const svc = candidates.find((s) => !used.has(s.name)) ?? candidates[0];
  if (!svc) return undefined;
  const backend = { service: { name: svc.name, port: { number: svc.port } } };
  return hasNginx
    ? ingress(name, { className: "nginx", rules: [{ host: `${svc.name}.example.com`, http: { paths: [{ path: "/", pathType: "Prefix", backend }] } }] })
    : ingress(name, { className: "tailscale", defaultBackend: backend, tls: [name] });
}

/** ingress-nginx 설치 (helm install ingress-nginx 의 축소판): 컨트롤러 Deployment + LoadBalancer Service — 예제 "도메인 둘을 Ingress 하나로" 와 같은 모양 */
export function ingressNginxManifests(): Manifest[] {
  return [
    deployment(NGINX_SERVICE, { replicas: 1, image: "registry.k8s.io/ingress-nginx/controller:v1.11.2", cpu: 100, memory: 128, port: 80 }),
    service(NGINX_SERVICE, { selector: { app: NGINX_SERVICE }, port: 80, type: "LoadBalancer" }),
  ];
}
