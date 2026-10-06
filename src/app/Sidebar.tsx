// 왼쪽: 오브젝트 나무 (Deployment → ReplicaSet → Pod 수) 와 노드 목록. 고르면 인스펙터에 보인다.
import { configMap, deployment, hpa, networkPolicy, service, statefulSet } from "../core/cluster";
import { hpaTargets } from "../core/kubectl";
import type { ClusterView } from "../model/view";
import { currentView, sim } from "../model/sim";
import { addManifest, addNodeDef, clusterDef, removeNodeDef, selection, uniqueDeploymentName } from "../model/store";
import { newIngress } from "../model/ingressForm";
import { NGINX_SERVICE } from "../core/net/ingress";
import { Icon } from "./Icons";

export function Sidebar() {
  const view = currentView();
  const pdbs = sim.cluster.api.list("PodDisruptionBudget", "default");
  const ings = sim.cluster.api.list("Ingress", "default");
  const apps = sim.cluster.api.list("Application", "argocd");
  const netpols = sim.cluster.api.list("NetworkPolicy", "default");
  const hpas = sim.cluster.api.list("HorizontalPodAutoscaler", "default");
  const unscaled = view.deployments.find((d) => !hpas.some((h) => h.spec.scaleTargetRef.kind === "Deployment" && h.spec.scaleTargetRef.name === d.name));
  const configs = [...sim.cluster.api.list("ConfigMap", "default"), ...sim.cluster.api.list("Secret", "default")];
  const sel = selection.value;
  const isSel = (kind: string, name: string) => sel?.kind === kind && sel.name === name;
  const manifestNames = new Set(clusterDef.value.manifests.filter((m) => m.kind === "Deployment").map((m) => m.metadata.name));

  return (
    <aside class="sidebar">
      <div class="side-section">
        <div class="side-head">
          <span>Deployment</span>
          <button
            class="icon-btn sm"
            title="Deployment 추가 (nginx, replicas 2)"
            aria-label="Deployment 추가"
            onClick={() => {
              const name = uniqueDeploymentName("app");
              addManifest(deployment(name, { replicas: 2, image: "nginx:1.27", cpu: 250, memory: 128 }));
              selection.value = { kind: "Deployment", namespace: "default", name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {view.deployments.map((d) => (
          <div key={d.name} class="tree">
            <button class={`tree-row${isSel("Deployment", d.name) ? " sel" : ""}`} data-tree={`deployment/${d.name}`} onClick={() => (selection.value = { kind: "Deployment", namespace: "default", name: d.name })}>
              <span class="own-swatch" style={{ background: `var(--own-${d.colorIndex})` }} />
              <span class="tree-name">{d.name}</span>
              {!manifestNames.has(d.name) && (d.d.metadata.labels["app.kubernetes.io/instance"] ? (
                <span class="tag" title={`Argo CD Application ${d.d.metadata.labels["app.kubernetes.io/instance"]} 이 Git 을 보고 만든 것`}>
                  Argo CD
                </span>
              ) : d.d.metadata.ownerReferences[0] ? (
                <span class="tag" title={`${d.d.metadata.ownerReferences[0].kind} ${d.d.metadata.ownerReferences[0].name} 를 보고 컨트롤러가 만든 것`}>
                  {d.d.metadata.ownerReferences[0].kind} 가 만듦
                </span>
              ) : (
                <span class="tag" title="매니페스트에 없고 kubectl 로만 만든 것">
                  kubectl
                </span>
              ))}
              <span class={`tree-count ${d.d.status.readyReplicas === d.d.spec.replicas ? "ok" : "wait"}`}>
                {d.d.status.readyReplicas}/{d.d.spec.replicas}
              </span>
            </button>
            {d.replicaSets.map((rs) => (
              <button
                key={rs.metadata.uid}
                class={`tree-row sub${isSel("ReplicaSet", rs.metadata.name) ? " sel" : ""}${rs.spec.replicas === 0 && rs.status.replicas === 0 ? " faded" : ""}`}
                data-tree={`replicaset/${rs.metadata.name}`}
                onClick={() => (selection.value = { kind: "ReplicaSet", namespace: "default", name: rs.metadata.name })}
              >
                <span class="tree-kind">rs</span>
                <span class="tree-name mono">{rs.metadata.name.slice(d.name.length + 1)}</span>
                <span class="tree-count">
                  {rs.status.readyReplicas}/{rs.spec.replicas}
                </span>
              </button>
            ))}
          </div>
        ))}
        {!view.deployments.length && <div class="side-empty">없음. + 로 추가하거나 kubectl create deployment</div>}
      </div>
      <div class="side-section">
        <div class="side-head">
          <span>StatefulSet</span>
          <button
            class="icon-btn sm"
            title="StatefulSet 추가 — 방문 수 DB (Pod 마다 1Gi 디스크) + headless Service"
            aria-label="StatefulSet 추가"
            onClick={() => {
              const name = uniqueDeploymentName("db", "StatefulSet");
              addManifest(service(name, { selector: { app: name }, port: 8080, headless: true }));
              addManifest(statefulSet(name, { replicas: 2, image: "example/kv:1.0", cpu: 100, memory: 64, port: 8080, storage: [{ name: "data", mountPath: "/data", size: 1024 }] }));
              selection.value = { kind: "StatefulSet", namespace: "default", name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {view.statefulSets.map((s) => (
          <div key={s.name} class="tree">
            <button class={`tree-row${isSel("StatefulSet", s.name) ? " sel" : ""}`} data-tree={`statefulset/${s.name}`} onClick={() => (selection.value = { kind: "StatefulSet", namespace: "default", name: s.name })}>
              <span class="own-swatch" style={{ background: `var(--own-${s.colorIndex})` }} />
              <span class="tree-name">{s.name}</span>
              <span class={`tree-count ${s.sts.status.readyReplicas === s.sts.spec.replicas ? "ok" : "wait"}`}>
                {s.sts.status.readyReplicas}/{s.sts.spec.replicas}
              </span>
            </button>
            {s.ordinals.flatMap((o) =>
              o.pvcs.map((v) => (
                <button
                  key={v.metadata.uid}
                  class={`tree-row sub${isSel("PersistentVolumeClaim", v.metadata.name) ? " sel" : ""}${o.i >= s.sts.spec.replicas ? " faded" : ""}`}
                  data-tree={`pvc/${v.metadata.name}`}
                  title={o.i >= s.sts.spec.replicas ? "줄여서 Pod 는 없지만 PVC(디스크)는 남아 있음 — 다시 늘리면 이 데이터로" : undefined}
                  onClick={() => (selection.value = { kind: "PersistentVolumeClaim", namespace: "default", name: v.metadata.name })}
                >
                  <span class="tree-kind">pvc</span>
                  <span class="tree-name mono">{v.metadata.name}</span>
                  <span class={`tree-count ${v.status.phase === "Bound" ? "ok" : "wait"}`}>{v.status.phase}</span>
                </button>
              )),
            )}
          </div>
        ))}
        {!view.statefulSets.length && <div class="side-empty">없음. + 로 DB 하나 띄우기</div>}
      </div>
      <div class="side-section">
        <div class="side-head">
          <span>Service</span>
          <button
            class="icon-btn sm"
            title="Service 추가 — Service 가 없는 첫 Deployment 를 가리키게 만듭니다 (kubectl expose 와 같음)"
            aria-label="Service 추가"
            disabled={!exposable(view)}
            onClick={() => {
              const d = exposable(view);
              if (!d) return;
              const ct = d.d.spec.template.spec.containers[0];
              const target = ct?.ports?.[0]?.containerPort ?? 80;
              const name = uniqueDeploymentName(d.name, "Service");
              addManifest(service(name, { selector: d.d.spec.selector.matchLabels, port: 80, targetPort: target }));
              selection.value = { kind: "Service", namespace: "default", name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {view.services.map((s) => (
          <button key={s.name} class={`tree-row${isSel("Service", s.name) ? " sel" : ""}`} data-tree={`service/${s.name}`} onClick={() => (selection.value = { kind: "Service", namespace: "default", name: s.name })}>
            <span class="svc-swatch" />
            <span class="tree-name">{s.name}</span>
            <span class="tree-kind mono">{s.svc.spec.clusterIP}</span>
            <span class={`tree-count ${s.ready.length ? "ok" : "wait"}`}>{s.ready.length}</span>
          </button>
        ))}
        {!view.services.length && <div class="side-empty">없음. + 또는 kubectl expose</div>}
      </div>
      <div class="side-section">
        <div class="side-head">
          <span>HPA</span>
          <button
            class="icon-btn sm"
            title={unscaled ? `HPA 추가 — Deployment ${unscaled.name} 를 CPU 50% 목표로 1~10개 (kubectl autoscale 과 같음). requests.cpu 가 없으면 사용률을 못 냅니다` : "HPA 추가 — HPA 가 없는 Deployment 가 먼저 있어야 합니다"}
            aria-label="HPA 추가"
            disabled={!unscaled}
            onClick={() => {
              if (!unscaled) return;
              const name = uniqueDeploymentName(unscaled.name, "HorizontalPodAutoscaler");
              addManifest(hpa(name, { target: unscaled.name, min: 1, max: 10, cpuPercent: 50 }));
              selection.value = { kind: "HorizontalPodAutoscaler", namespace: "default", name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {hpas.map((h) => (
          <button key={h.metadata.uid} class={`tree-row${isSel("HorizontalPodAutoscaler", h.metadata.name) ? " sel" : ""}`} data-tree={`hpa/${h.metadata.name}`} onClick={() => (selection.value = { kind: "HorizontalPodAutoscaler", namespace: "default", name: h.metadata.name })}>
            <span class="tree-name">{h.metadata.name}</span>
            <span class="tree-kind mono">{hpaTargets(h).replace(/^cpu: /, "")}</span>
            <span class={`tree-count ${h.status.currentMetrics ? "ok" : "wait"}`} title="지금 replicas">
              {h.status.currentReplicas}
            </span>
          </button>
        ))}
        {!hpas.length && <div class="side-empty">없음. + 또는 kubectl autoscale</div>}
      </div>
      <div class="side-section">
        <div class="side-head">
          <span>ConfigMap · Secret</span>
          <button
            class="icon-btn sm"
            title="ConfigMap 추가 (GREETING=hello) — Deployment 가 env·파일로 읽게 하려면 매니페스트에 envFrom·volume 이 필요합니다 (예제 '설정' 묶음 참고)"
            aria-label="ConfigMap 추가"
            onClick={() => {
              const name = uniqueDeploymentName("app-config", "ConfigMap");
              addManifest(configMap(name, { GREETING: "hello" }));
              selection.value = { kind: "ConfigMap", namespace: "default", name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {configs.map((o) => (
          <button key={o.metadata.uid} class={`tree-row${isSel(o.kind, o.metadata.name) ? " sel" : ""}`} data-tree={`${o.kind.toLowerCase()}/${o.metadata.name}`} onClick={() => (selection.value = { kind: o.kind, namespace: "default", name: o.metadata.name })}>
            <span class="tree-name">{o.metadata.name}</span>
            <span class="tree-kind">{o.kind === "Secret" ? "secret" : "cm"}</span>
            <span class="tree-count">{Object.keys(o.data).length}</span>
          </button>
        ))}
        {!configs.length && <div class="side-empty">없음. + 또는 kubectl create configmap</div>}
      </div>
      <div class="side-section">
        <div class="side-head">
          <span>NetworkPolicy</span>
          <button
            class="icon-btn sm"
            title={view.deployments[0] ? `NetworkPolicy 추가 — app=${view.deployments[0].d.spec.template.metadata.labels.app} 로 들어오는 것을 막는 정책 (설정 탭에서 허용 규칙을 더하세요)` : "NetworkPolicy 추가 — 고를 Deployment 가 먼저 있어야 합니다"}
            aria-label="NetworkPolicy 추가"
            disabled={!view.deployments[0]}
            onClick={() => {
              const app = view.deployments[0]!.d.spec.template.metadata.labels.app ?? view.deployments[0]!.name;
              const name = uniqueDeploymentName(`deny-${app}`, "NetworkPolicy");
              addManifest(networkPolicy(name, { podSelector: { matchLabels: { app } }, policyTypes: ["Ingress"] }));
              selection.value = { kind: "NetworkPolicy", namespace: "default", name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {netpols.map((n) => (
          <button key={n.metadata.uid} class={`tree-row${isSel("NetworkPolicy", n.metadata.name) ? " sel" : ""}`} data-tree={`networkpolicy/${n.metadata.name}`} onClick={() => (selection.value = { kind: "NetworkPolicy", namespace: "default", name: n.metadata.name })}>
            <span class="tree-name">{n.metadata.name}</span>
            <span class="tree-kind mono">{Object.entries(n.spec.podSelector.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(",") || "모든 Pod"}</span>
          </button>
        ))}
        {!netpols.length && <div class="side-empty">없음 — 모든 트래픽 허용. + 로 추가</div>}
      </div>
      {apps.length > 0 && (
        <div class="side-section">
          <div class="side-head">
            <span>Argo CD</span>
          </div>
          {apps.map((a) => (
            <button key={a.metadata.uid} class={`tree-row${isSel("Application", a.metadata.name) ? " sel" : ""}`} onClick={() => (selection.value = { kind: "Application", namespace: "argocd", name: a.metadata.name })}>
              <span class="tree-name">{a.metadata.name}</span>
              <span class={`tree-count ${a.status.sync.status === "Synced" ? "ok" : "wait"}`}>{a.status.sync.status}</span>
            </button>
          ))}
        </div>
      )}
      <div class="side-section">
        <div class="side-head">
          <span>Ingress</span>
          <button
            class="icon-btn sm"
            title={
              ingressTarget(view)
                ? `Ingress 추가 — Service 를 바깥에 엽니다 (${view.services.some((s) => s.name === NGINX_SERVICE) ? "ingress-nginx 가 있어 nginx 클래스" : "ingress-nginx 가 없어 설치가 필요 없는 tailscale 클래스"})`
                : "Ingress 추가 — 가리킬 Service 가 먼저 있어야 합니다"
            }
            aria-label="Ingress 추가"
            disabled={!ingressTarget(view)}
            onClick={() => {
              const svcs = ingressTarget(view)!;
              const used = new Set(ings.flatMap((i) => [i.spec.defaultBackend?.service.name, ...(i.spec.rules ?? []).flatMap((r) => r.http.paths.map((p) => p.backend.service.name))].filter((x): x is string => !!x)));
              const first = svcs.find((s) => !used.has(s.name)) ?? svcs[0]!;
              const m = newIngress(uniqueDeploymentName(first.name, "Ingress"), svcs, used, view.services.some((s) => s.name === NGINX_SERVICE));
              if (!m) return;
              addManifest(m);
              selection.value = { kind: "Ingress", namespace: "default", name: m.metadata.name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {ings.map((i) => (
          <button key={i.metadata.uid} class={`tree-row${isSel("Ingress", i.metadata.name) ? " sel" : ""}`} data-tree={`ingress/${i.metadata.name}`} onClick={() => (selection.value = { kind: "Ingress", namespace: "default", name: i.metadata.name })}>
            <span class="tree-name">{i.metadata.name}</span>
            <span class="tree-kind">{i.spec.ingressClassName}</span>
          </button>
        ))}
        {!ings.length && <div class="side-empty">없음. + 또는 kubectl create ingress</div>}
      </div>
      {pdbs.length > 0 && (
        <div class="side-section">
          <div class="side-head">
            <span>PodDisruptionBudget</span>
          </div>
          {pdbs.map((b) => (
            <button key={b.metadata.uid} class={`tree-row${isSel("PodDisruptionBudget", b.metadata.name) ? " sel" : ""}`} onClick={() => (selection.value = { kind: "PodDisruptionBudget", namespace: "default", name: b.metadata.name })}>
              <span class="tree-name">{b.metadata.name}</span>
              <span class={`tree-count ${b.status.disruptionsAllowed > 0 ? "ok" : "wait"}`} title="지금 허용되는 자발적 중단 수">
                허용 {b.status.disruptionsAllowed}
              </span>
            </button>
          ))}
        </div>
      )}
      <div class="side-section">
        <div class="side-head">
          <span>노드</span>
          <button
            class="icon-btn sm"
            title="노드 추가 — kubelet 이 자기 노드를 API 에 등록합니다"
            aria-label="노드 추가"
            onClick={() => {
              const n = addNodeDef();
              selection.value = { kind: "Node", name: n.name };
            }}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {view.nodes.map((n) => (
          <div key={n.name} class="tree-line">
            <button class={`tree-row${isSel("Node", n.name) ? " sel" : ""}`} data-tree={`node/${n.name}`} onClick={() => (selection.value = { kind: "Node", name: n.name })}>
              <span class={`dot ${n.ready ? (n.powered ? (n.cordoned ? "wait" : "ok") : "wait") : "bad"}`} />
              <span class="tree-name">{n.name}</span>
              {!n.powered && <span class="tag">꺼짐</span>}
              <span class="tree-count">Pod {n.pods.length}</span>
            </button>
            <span class="row-actions">
            <button
              class={`icon-btn sm row-action power${n.powered ? "" : " is-off"}`}
              title={n.powered ? `${n.name} 끄기 — kubelet 이 멈추고 heartbeat 가 끊깁니다 (노드는 클러스터에 남음)` : `${n.name} 다시 켜기`}
              aria-label={n.powered ? `${n.name} 끄기` : `${n.name} 켜기`}
              onClick={() => sim.setNodePower(n.name, !n.powered)}
            >
              <Icon name="power" size={14} />
            </button>
            <button
              class="icon-btn sm row-action"
              title={`${n.name} 빼기 — kubelet 을 멈추고 Node 를 지웁니다`}
              aria-label={`${n.name} 빼기`}
              onClick={() => {
                removeNodeDef(n.name);
                if (sel?.kind === "Node" && sel.name === n.name) selection.value = null;
              }}
            >
              <Icon name="trash" size={14} />
            </button>
            </span>
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Ingress 가 가리킬 수 있는 Service (ingress-nginx 의 것은 빼고). 없으면 undefined */
function ingressTarget(view: ClusterView): { name: string; port: number }[] | undefined {
  const out = view.services.filter((s) => s.name !== NGINX_SERVICE).map((s) => ({ name: s.name, port: s.svc.spec.ports[0]?.port ?? 80 }));
  return out.length ? out : undefined;
}

/** Service 가 아직 가리키지 않는 첫 Deployment */
function exposable(view: ClusterView) {
  return view.deployments.find((d) => !view.services.some((s) => Object.entries(s.svc.spec.selector).every(([k, v]) => d.d.spec.template.metadata.labels[k] === v)));
}
