// 편집 중인 정의(노드 + 매니페스트)를 살아 있는 클러스터에 반영한다 (net-sim netSync 처럼 diff).
// 처리 순서가 곧 의미다: 노드를 먼저 더하고(새 Pod 가 갈 곳), 매니페스트를 적용하고, 지운 노드는 마지막에 뺀다.
// 매니페스트가 바뀌면 kubectl apply 와 같다 — 라이브에서 kubectl 로 바꾼 값은 매니페스트에 있는 필드만 덮인다.
import { ApiError } from "../core/api/server";
import { Cluster, type DeploymentManifest, type Manifest } from "../core/cluster";
import { stableJson } from "../core/rng";
import type { ClusterDef } from "./examples";

export class DefSync {
  cluster = new Cluster();
  private nodes = new Map<string, string>();
  private manifests = new Map<string, string>();

  /** 처음부터: 새 클러스터에 정의를 그대로 올린다 */
  reset(def: ClusterDef, why: string): void {
    this.cluster = new Cluster();
    this.nodes.clear();
    this.manifests.clear();
    this.cluster.trace.add("user", "user", why);
    for (const g of def.git ?? []) this.cluster.gitCommit(g.url, g.files, g.message, "you");
    this.sync(def);
  }

  /** 바뀐 것만 반영. 반영한 것이 있으면 true */
  sync(def: ClusterDef): boolean {
    const c = this.cluster;
    let changed = false;
    const wantNodes = new Map(def.nodes.map((n) => [n.name, n]));
    for (const n of def.nodes) {
      const prev = this.nodes.get(n.name);
      const json = stableJson({ cpu: n.cpu, memory: n.memory });
      if (prev === json) continue;
      if (prev === undefined) {
        c.addNode(n);
        if (this.nodes.size) c.trace.add("user", "user", `노드 ${n.name} 추가`, { kind: "Node", name: n.name });
      } else {
        c.trace.add("user", "user", `노드 ${n.name} 자원 변경`, { kind: "Node", name: n.name });
        c.resizeNode(n.name, n.cpu, n.memory);
      }
      this.nodes.set(n.name, json);
      changed = true;
    }
    const wantManifests = new Map(def.manifests.map((m) => [manifestKey(m), m]));
    // Deployment 를 먼저 (Service 가 가리킬 Pod 가 먼저 생기게 — 순서가 바뀌어도 결과는 같지만 로그가 읽기 쉽다)
    for (const m of [...def.manifests].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "Deployment" ? -1 : 1))) {
      const key = manifestKey(m);
      const json = stableJson(m);
      if (this.manifests.get(key) === json) continue;
      try {
        const r = c.apply(m, "kubectl");
        c.trace.add("user", "user", `매니페스트 적용 (kubectl apply): ${resourceName(m.kind)}/${m.metadata.name} ${r}`, { kind: m.kind, namespace: "default", name: m.metadata.name });
      } catch (e) {
        // API 서버가 거절한 매니페스트 (예: 규칙도 기본 backend 도 없는 Ingress) — 실제 kubectl apply 처럼 오류만 남기고 라이브는 그대로
        if (!(e instanceof ApiError)) throw e;
        c.trace.add("user", "user", `매니페스트 적용 실패 (kubectl apply): ${resourceName(m.kind)}/${m.metadata.name} — Error from server (${e.reason}): ${e.message}`, { kind: m.kind, namespace: "default", name: m.metadata.name });
      }
      this.manifests.set(key, json);
      changed = true;
    }
    for (const key of [...this.manifests.keys()]) {
      if (wantManifests.has(key)) continue;
      this.manifests.delete(key);
      const [kind, name] = key.split("/") as [Manifest["kind"], string];
      const ns = kind === "Application" ? "argocd" : "default";
      if (c.api.get(kind, name, ns)) {
        c.trace.add("user", "user", `매니페스트 삭제 (kubectl delete): ${resourceName(kind)}/${name}`);
        c.api.delete(kind, name, ns, "kubectl");
      }
      changed = true;
    }
    for (const name of [...this.nodes.keys()]) {
      if (wantNodes.has(name)) continue;
      this.nodes.delete(name);
      c.trace.add("user", "user", `노드 ${name} 빼기 (kubelet 멈춤 → Node 삭제)`);
      c.removeNode(name, "user");
      changed = true;
    }
    return changed;
  }

  /** 매니페스트와 라이브 Deployment 의 replicas·이미지·requests·limits 가 다른지 (kubectl 로 바꾼 흔적) */
  drift(m: DeploymentManifest): string[] {
    const live = this.cluster.api.get("Deployment", m.metadata.name, "default");
    if (!live) return ["라이브에 없음 (kubectl 로 지워짐)"];
    const out: string[] = [];
    if (live.spec.replicas !== m.spec.replicas) out.push(`replicas: 매니페스트 ${m.spec.replicas} · 라이브 ${live.spec.replicas}`);
    const mi = m.spec.template.spec.containers[0]?.image;
    const li = live.spec.template.spec.containers[0]?.image;
    if (mi !== li) out.push(`image: 매니페스트 ${mi} · 라이브 ${li}`);
    const mr = m.spec.template.spec.containers[0]?.resources.requests;
    const lr = live.spec.template.spec.containers[0]?.resources.requests;
    if (mr && lr && (mr.cpu !== lr.cpu || mr.memory !== lr.memory)) out.push("requests 가 다름");
    const ml = m.spec.template.spec.containers[0]?.resources.limits;
    const ll = live.spec.template.spec.containers[0]?.resources.limits;
    if ((ml?.cpu ?? -1) !== (ll?.cpu ?? -1) || (ml?.memory ?? -1) !== (ll?.memory ?? -1)) out.push("limits 가 다름");
    return out;
  }

  /** 다음 sync 가 이 매니페스트를 다시 적용하게 (드리프트를 매니페스트로 되돌리기) */
  forget(kind: Manifest["kind"], name: string): void {
    this.manifests.delete(`${kind}/${name}`);
  }
}

export function manifestKey(m: Manifest): string {
  return `${m.kind}/${m.metadata.name}`;
}

function resourceName(kind: Manifest["kind"]): string {
  return kind === "Deployment"
    ? "deployment.apps"
    : kind === "Service"
      ? "service"
      : kind === "Ingress"
        ? "ingress.networking.k8s.io"
        : kind === "Application"
          ? "application.argoproj.io"
          : kind === "ConfigMap"
            ? "configmap"
            : kind === "Secret"
              ? "secret"
              : "poddisruptionbudget.policy";
}
