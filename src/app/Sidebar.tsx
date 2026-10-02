// 왼쪽: 오브젝트 나무 (Deployment → ReplicaSet → Pod 수) 와 노드 목록. 고르면 인스펙터에 보인다.
import { deployment, service } from "../core/cluster";
import type { ClusterView } from "../model/view";
import { currentView, sim } from "../model/sim";
import { addManifest, addNodeDef, clusterDef, removeNodeDef, selection, uniqueDeploymentName } from "../model/store";
import { Icon } from "./Icons";

export function Sidebar() {
  const view = currentView();
  const pdbs = sim.cluster.api.list("PodDisruptionBudget", "default");
  const ings = sim.cluster.api.list("Ingress", "default");
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
              {!manifestNames.has(d.name) && (d.d.metadata.ownerReferences[0] ? (
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
      {ings.length > 0 && (
        <div class="side-section">
          <div class="side-head">
            <span>Ingress</span>
          </div>
          {ings.map((i) => (
            <button key={i.metadata.uid} class={`tree-row${isSel("Ingress", i.metadata.name) ? " sel" : ""}`} onClick={() => (selection.value = { kind: "Ingress", namespace: "default", name: i.metadata.name })}>
              <span class="tree-name">{i.metadata.name}</span>
              <span class="tree-kind">{i.spec.ingressClassName}</span>
            </button>
          ))}
        </div>
      )}
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

/** Service 가 아직 가리키지 않는 첫 Deployment */
function exposable(view: ClusterView) {
  return view.deployments.find((d) => !view.services.some((s) => Object.entries(s.svc.spec.selector).every(([k, v]) => d.d.spec.template.metadata.labels[k] === v)));
}
