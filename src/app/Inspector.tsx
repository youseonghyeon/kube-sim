// 오른쪽 인스펙터: 고른 오브젝트의 개요·설정·describe·YAML. 아무것도 안 골랐으면 예제의 "해 볼 것".
import { useSignal } from "@preact/signals";
import { useEffect, useMemo } from "preact/hooks";
import { controllerOf, isNodeReady, NODE_LEASE_NS, type Deployment, type KObject, type Node, type Pod, type ReplicaSet, type Service } from "../core/api/types";
import { eventSource, nodeStatusText, podRestartsText, podStatusText, rolloutStatusLine, runKubectl } from "../core/kubectl";
import { fmtAge, fmtCpu, fmtMem, parseCpu, parseMem } from "../core/units";
import { IMAGE_NAMES, IMAGES } from "../core/workloads";
import { NODE_MONITOR_GRACE_MS } from "../core/controllers/nodelifecycle";
import { exampleById, resolveCommand, type TryAction } from "../model/examples";
import { deploymentHash, HASH_LABEL, revisionOf } from "../core/controllers/deployment";
import { sim, simVersion } from "../model/sim";
import { clusterDef, drawerOpen, drawerTab, exampleId, findManifest, removeManifest, selection, updateManifest, updateNodeDef, updateServiceManifest } from "../model/store";
import { toneOf } from "../model/view";
import { toYaml } from "../model/yaml";
import { Icon } from "./Icons";

type Tab = "overview" | "settings" | "iptables" | "describe" | "yaml";

export function runAndShow(cmd: string): void {
  sim.kubectl(cmd);
  drawerTab.value = "kubectl";
  drawerOpen.value = true;
}

export function Inspector() {
  simVersion.value;
  const sel = selection.value;
  const tab = useSignal<Tab>("overview");
  const obj = sel ? sim.cluster.api.get(sel.kind as KObject["kind"], sel.name, sel.namespace ?? "default") : undefined;
  const hasSettings = obj?.kind === "Deployment" || obj?.kind === "Node" || (obj?.kind === "Service" && !!findManifest("Service", obj.metadata.name));
  const hasIptables = obj?.kind === "Node";
  useEffect(() => {
    if ((tab.value === "settings" && !hasSettings) || (tab.value === "iptables" && !hasIptables)) tab.value = "overview";
  }, [sel?.kind, sel?.name, hasSettings, hasIptables]);

  if (!sel) return <aside class="inspector">{<ExamplePanel />}</aside>;
  if (!obj) {
    return (
      <aside class="inspector">
        <div class="insp-head">
          <div class="insp-kind">{sel.kind}</div>
          <div class="insp-name mono">{sel.name}</div>
        </div>
        <div class="insp-body">
          <p class="note">이 오브젝트는 지금 API 서버에 없습니다 (지워졌거나 아직 만들어지지 않음).</p>
          <button class="btn" onClick={() => (selection.value = null)}>
            선택 해제
          </button>
        </div>
      </aside>
    );
  }
  const tabs: [Tab, string][] = [
    ["overview", "개요"],
    ...(hasSettings ? ([["settings", "설정"]] as [Tab, string][]) : []),
    ...(hasIptables ? ([["iptables", "iptables"]] as [Tab, string][]) : []),
    ["describe", "describe"],
    ["yaml", "YAML"],
  ];
  return (
    <aside class="inspector">
      <div class="insp-head">
        <div class="insp-kind">{obj.kind}</div>
        <div class="insp-title">
          <span class="insp-name mono">{obj.metadata.name}</span>
          <StatusBadge obj={obj} />
        </div>
        <button class="icon-btn sm insp-close" onClick={() => (selection.value = null)} title="선택 해제 (Esc)" aria-label="선택 해제">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div class="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab.value === id} class={tab.value === id ? "on" : ""} onClick={() => (tab.value = id)}>
            {label}
          </button>
        ))}
      </div>
      <div class="insp-body">
        {tab.value === "overview" && <Overview obj={obj} />}
        {tab.value === "settings" && obj.kind === "Deployment" && <DeploymentSettings d={obj} />}
        {tab.value === "settings" && obj.kind === "Node" && <NodeSettings n={obj} />}
        {tab.value === "settings" && obj.kind === "Service" && <ServiceSettings name={obj.metadata.name} />}
        {tab.value === "iptables" && obj.kind === "Node" && <IptablesView node={obj.metadata.name} />}
        {tab.value === "describe" && <pre class="term">{runKubectl(sim.cluster, `describe ${obj.kind.toLowerCase()} ${obj.metadata.name}`).output}</pre>}
        {tab.value === "yaml" && <pre class="term">{toYaml(obj)}</pre>}
      </div>
    </aside>
  );
}

function StatusBadge({ obj }: { obj: KObject }) {
  if (obj.kind === "Pod") {
    const s = podStatusText(obj);
    return <span class={`badge t-${toneOf(obj, s)}`}>{s}</span>;
  }
  if (obj.kind === "Node") {
    const s = nodeStatusText(obj);
    return <span class={`badge t-${!isNodeReady(obj) ? "bad" : obj.spec.unschedulable ? "wait" : "ok"}`}>{s}</span>;
  }
  if (obj.kind === "Lease" || obj.kind === "EndpointSlice") return null;
  if (obj.kind === "Service") return <span class="badge">{obj.spec.type}</span>;
  if (obj.kind === "PodDisruptionBudget") return <span class={`badge t-${obj.status.disruptionsAllowed > 0 ? "ok" : "wait"}`}>{`허용 ${obj.status.disruptionsAllowed}`}</span>;
  const ready = obj.status.readyReplicas;
  return <span class={`badge t-${ready === obj.spec.replicas ? "ok" : "wait"}`}>{`${ready}/${obj.spec.replicas} Ready`}</span>;
}

// ---------- 개요 ----------

function Overview({ obj }: { obj: KObject }) {
  switch (obj.kind) {
    case "Pod":
      return <PodOverview p={obj} />;
    case "Deployment":
      return <DeploymentOverview d={obj} />;
    case "ReplicaSet":
      return <ReplicaSetOverview rs={obj} />;
    case "Node":
      return <NodeOverview n={obj} />;
    case "Service":
      return <ServiceOverview svc={obj} />;
    case "PodDisruptionBudget":
      return (
        <>
          <Rows
            rows={[
              ["selector", <span class="mono">{Object.entries(obj.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",")}</span>],
              ["조건", obj.spec.minAvailable !== undefined ? `minAvailable ${obj.spec.minAvailable}` : `maxUnavailable ${obj.spec.maxUnavailable}`],
              ["지금", `Ready ${obj.status.currentHealthy} · 최소 ${obj.status.desiredHealthy} · 기대 ${obj.status.expectedPods}`],
              ["중단 허용", String(obj.status.disruptionsAllowed)],
            ]}
          />
          <p class="note">drain 같은 자발적 중단(Eviction API)은 허용 수가 0 이면 거절됩니다. 노드가 죽는 것 같은 비자발적 중단은 막지 못합니다.</p>
        </>
      );
    default:
      return null;
  }
}

function Rows({ rows }: { rows: [string, preact.ComponentChildren][] }) {
  return (
    <dl class="rows">
      {rows.map(([k, v]) => (
        <div key={k} class="row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Link({ kind, name }: { kind: string; name: string }) {
  return (
    <button class="link mono" onClick={() => (selection.value = { kind, namespace: kind === "Node" ? undefined : "default", name })}>
      {name}
    </button>
  );
}

function OwnerChain({ meta }: { meta: KObject["metadata"] }) {
  const chain: { kind: string; name: string }[] = [];
  let ref = controllerOf(meta);
  while (ref) {
    chain.unshift({ kind: ref.kind, name: ref.name });
    const parent = sim.cluster.api.get(ref.kind as KObject["kind"], ref.name, "default");
    ref = parent ? controllerOf(parent.metadata) : undefined;
  }
  if (!chain.length) return <span class="muted">없음 (직접 만든 것)</span>;
  return (
    <span class="chain">
      {chain.map((c, i) => (
        <span key={c.name}>
          {i > 0 && <span class="chain-sep">→</span>}
          <span class="chain-kind">{c.kind}</span> <Link kind={c.kind} name={c.name} />
        </span>
      ))}
    </span>
  );
}

function Events({ uid }: { uid: string }) {
  const c = sim.cluster;
  const evs = c.api.eventsFor(uid).slice(-8);
  if (!evs.length) return <p class="muted small">이벤트 없음</p>;
  return (
    <ul class="events">
      {evs.map((e) => (
        <li key={e.key} class={e.type === "Warning" ? "warn" : ""}>
          <div class="ev-head">
            <span class="ev-reason">{e.reason}</span>
            <span class="ev-meta">
              {eventSource(e.source)} · {fmtAge(c.now - e.lastTimestamp)} 전{e.count > 1 ? ` · ×${e.count}` : ""}
            </span>
          </div>
          <div class="ev-msg">{e.message}</div>
        </li>
      ))}
    </ul>
  );
}

function PodOverview({ p }: { p: Pod }) {
  const c = sim.cluster;
  const cs = p.status.containerStatuses[0];
  const ct = p.spec.containers[0];
  const scheduled = p.status.conditions.find((x) => x.type === "PodScheduled");
  const deleting = p.metadata.deletionTimestamp !== undefined;
  const sick = c.podSick(p.metadata.name);
  return (
    <>
      {!p.spec.nodeName && scheduled?.status === "False" && (
        <div class="callout warn">
          <div class="callout-title">왜 Pending 인가요?</div>
          <div class="mono small">{scheduled.message}</div>
          <div class="small">requests 를 줄이거나, 노드를 더하거나, 다른 Pod 를 줄이면 스케줄러가 다시 시도합니다.</div>
        </div>
      )}
      {cs && "waiting" in cs.state && cs.state.waiting.reason === "CrashLoopBackOff" && (
        <div class="callout bad">
          <div class="callout-title">CrashLoopBackOff</div>
          <div class="small">컨테이너가 시작 후 계속 종료됩니다. kubelet 은 10초부터 두 배씩(최대 5분) 기다렸다가 다시 띄웁니다. 아래 이벤트의 BackOff 횟수를 보세요.</div>
        </div>
      )}
      {cs && "waiting" in cs.state && (cs.state.waiting.reason === "ImagePullBackOff" || cs.state.waiting.reason === "ErrImagePull") && (
        <div class="callout bad">
          <div class="callout-title">{cs.state.waiting.reason}</div>
          <div class="small">이미지 "{ct?.image}" 를 받지 못했습니다. 이름·태그를 확인하고 Deployment 의 이미지를 고치세요.</div>
        </div>
      )}
      <Rows
        rows={[
          ["상태", `${podStatusText(p)} · phase ${p.status.phase}`],
          ["Ready", p.status.conditions.find((x) => x.type === "Ready")?.status ?? "—"],
          ["노드", p.spec.nodeName ? <Link kind="Node" name={p.spec.nodeName} /> : <span class="muted">아직 없음</span>],
          ["Pod IP", <span class="mono">{p.status.podIP ?? "—"}</span>],
          ["재시작", podRestartsText(p, c.now)],
          ["이미지", <span class="mono">{ct?.image}</span>],
          ["requests", <span class="mono">{ct ? `cpu ${fmtCpu(ct.resources.requests.cpu)} · memory ${fmtMem(ct.resources.requests.memory)}` : "—"}</span>],
          ["주인", <OwnerChain meta={p.metadata} />],
          ["나이", fmtAge(c.now - p.metadata.creationTimestamp)],
        ]}
      />
      <div class="actions">
        <button class="btn" disabled={deleting} onClick={() => runAndShow(`kubectl delete pod ${p.metadata.name}`)} title="kubectl delete pod — Terminating 이 되고 kubelet 이 컨테이너를 멈춘 뒤 사라집니다">
          <Icon name="trash" size={14} />
          Pod 지우기
        </button>
        <button class="btn ghost" onClick={() => runAndShow(`kubectl delete pod ${p.metadata.name} --force --grace-period=0`)} title="kubelet 을 기다리지 않고 API 에서 바로 지웁니다">
          강제 삭제
        </button>
        {cs && "running" in cs.state && !deleting && (
          <button
            class={`btn${sick ? " danger" : ""}`}
            onClick={() => {
              c.setPodHealth(p.metadata.name, sick);
              sim.touch();
            }}
            title="DB 연결이 끊긴 것처럼 앱이 503 을 돌려주게 합니다. readiness probe 가 있으면 Ready 가 빠집니다"
          >
            {sick ? "앱 고치기" : "앱 고장 내기"}
          </button>
        )}
      </div>
      {cs && "running" in cs.state && !deleting && <CurlFrom pod={p.metadata.name} />}
      <h3>이벤트</h3>
      <Events uid={p.metadata.uid} />
    </>
  );
}

function DeploymentOverview({ d }: { d: Deployment }) {
  const c = sim.cluster;
  const rss = c.api.list("ReplicaSet", "default").filter((r) => controllerOf(r.metadata)?.uid === d.metadata.uid);
  const drift = sim.drift(d.metadata.name);
  const inManifest = !!findManifest("Deployment", d.metadata.name);
  const st = rolloutStatusLine(d);
  const hash = deploymentHash(d);
  const strategy = d.spec.strategy?.type === "Recreate" ? "Recreate" : `RollingUpdate (maxSurge ${d.spec.strategy?.rollingUpdate?.maxSurge ?? "25%"} · maxUnavailable ${d.spec.strategy?.rollingUpdate?.maxUnavailable ?? "25%"})`;
  const prestop = d.spec.template.spec.containers[0]?.lifecycle?.preStop?.sleep.seconds;
  return (
    <>
      {inManifest && drift.length > 0 && <DriftNote name={d.metadata.name} drift={drift} />}
      <div class={`callout${st.text.startsWith("error") ? " bad" : st.done ? "" : " warn"}`}>
        <div class="small muted">kubectl rollout status</div>
        <div class="mono small">{st.text}</div>
        {!st.done && st.text.includes("new replicas have been updated") && d.status.availableReplicas < d.spec.replicas && (
          <div class="small">새 Pod 가 Ready 가 되어야 옛 Pod 를 더 줄일 수 있습니다. 멈춰 있다면 새 Pod 의 readiness 를 보세요.</div>
        )}
      </div>
      <Rows
        rows={[
          ["replicas", `원하는 ${d.spec.replicas} · 있는 ${d.status.replicas} · 새 템플릿 ${d.status.updatedReplicas} · Ready ${d.status.readyReplicas}`],
          ["전략", <span class="small">{strategy}</span>],
          ["이미지", <span class="mono">{d.spec.template.spec.containers[0]?.image}</span>],
          ["preStop", prestop ? `sleep ${prestop}초` : <span class="muted">없음</span>],
          ["revision", d.metadata.annotations?.["deployment.kubernetes.io/revision"] ?? "—"],
        ]}
      />
      <div class="actions">
        <button class="btn sm" onClick={() => runAndShow(`kubectl rollout status deployment/${d.metadata.name}`)}>
          rollout status
        </button>
        <button class="btn sm" onClick={() => runAndShow(`kubectl rollout restart deployment/${d.metadata.name}`)} title="템플릿에 restartedAt 을 붙여 새 ReplicaSet 으로 모두 교체합니다">
          rollout restart
        </button>
        <button class="btn sm" disabled={rss.length < 2} onClick={() => runAndShow(`kubectl rollout undo deployment/${d.metadata.name}`)} title="바로 전 리비전의 템플릿으로 되돌립니다">
          rollout undo
        </button>
      </div>
      <h3>ReplicaSet (리비전)</h3>
      <p class="muted small">템플릿 해시마다 하나. 지금 템플릿의 것(새)이 늘고 옛것이 줄어드는 것이 롤아웃입니다.</p>
      <ul class="list">
        {[...rss]
          .sort((a, b) => revisionOf(b) - revisionOf(a))
          .map((r) => (
            <li key={r.metadata.uid}>
              <span>
                <span class="mono small muted">rev {revisionOf(r)} </span>
                <Link kind="ReplicaSet" name={r.metadata.name} />
                {r.metadata.labels[HASH_LABEL] === hash && <span class="tag">새</span>}
              </span>
              <span class="muted">
                {r.status.readyReplicas}/{r.spec.replicas}
              </span>
            </li>
          ))}
      </ul>
      <h3>이벤트</h3>
      <Events uid={d.metadata.uid} />
    </>
  );
}

function DriftNote({ name, drift }: { name: string; drift: string[] }) {
  return (
    <div class="callout warn">
      <div class="callout-title">라이브가 매니페스트와 다릅니다</div>
      <ul class="small">
        {drift.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div class="small">kubectl 로 직접 바꾼 값입니다. 매니페스트를 다시 적용하면 되돌아갑니다 (GitOps 의 self-heal 이 하는 일 — 6단계).</div>
      <button class="btn sm" onClick={() => sim.reapply(name)}>
        매니페스트 다시 적용
      </button>
    </div>
  );
}

function ReplicaSetOverview({ rs }: { rs: ReplicaSet }) {
  const c = sim.cluster;
  const pods = c.api.list("Pod", "default").filter((p) => controllerOf(p.metadata)?.uid === rs.metadata.uid);
  const owner = controllerOf(rs.metadata);
  return (
    <>
      <Rows
        rows={[
          ["replicas", `원하는 ${rs.spec.replicas} · 있는 ${rs.status.replicas} · Ready ${rs.status.readyReplicas}`],
          ["selector", <span class="mono">{Object.entries(rs.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",")}</span>],
          ["주인", <OwnerChain meta={rs.metadata} />],
        ]}
      />
      {owner?.kind === "Deployment" && (
        <div class="callout">
          <div class="small">이 ReplicaSet 은 Deployment {owner.name} 가 관리합니다. 직접 replicas 를 바꾸면 deployment-controller 가 곧 되돌립니다.</div>
          <button class="btn sm" onClick={() => runAndShow(`kubectl scale rs/${rs.metadata.name} --replicas=${rs.spec.replicas + 2}`)}>
            직접 {rs.spec.replicas + 2} 로 바꿔 보기
          </button>
        </div>
      )}
      <h3>Pod</h3>
      <ul class="list">
        {pods.map((p) => (
          <li key={p.metadata.uid}>
            <Link kind="Pod" name={p.metadata.name} />
            <span class="muted">{podStatusText(p)}</span>
          </li>
        ))}
        {!pods.length && <li class="muted">없음</li>}
      </ul>
      <h3>이벤트</h3>
      <Events uid={rs.metadata.uid} />
    </>
  );
}

function NodeOverview({ n }: { n: Node }) {
  const c = sim.cluster;
  const pods = c.api.list("Pod").filter((p) => p.spec.nodeName === n.metadata.name);
  const powered = c.nodePowered(n.metadata.name);
  const lease = c.api.get("Lease", n.metadata.name, NODE_LEASE_NS);
  const ready = n.status.conditions.find((x) => x.type === "Ready");
  return (
    <>
      {!powered && (
        <div class="callout warn">
          <div class="callout-title">꺼진 노드</div>
          <div class="small">API 서버는 노드가 꺼진 것을 직접 알 수 없습니다. kubelet 의 heartbeat(Lease)가 {NODE_MONITOR_GRACE_MS / 1000}초 넘게 끊기면 그때 NotReady 로 봅니다.</div>
        </div>
      )}
      <Rows
        rows={[
          ["상태", nodeStatusText(n)],
          ["Ready", <span>{`${ready?.status ?? "—"}${ready?.reason ? ` (${ready.reason})` : ""}`}</span>],
          ["heartbeat", lease ? `${fmtAge(c.now - lease.spec.renewTime)} 전 (Lease, 10초마다)` : "—"],
          [
            "taints",
            n.spec.taints?.length ? (
              <span class="lines mono small">
                {n.spec.taints.map((t) => (
                  <span key={`${t.key}:${t.effect}`}>{`${t.key}:${t.effect}`}</span>
                ))}
              </span>
            ) : (
              "없음"
            ),
          ],
          ["InternalIP", <span class="mono">{n.status.addresses.find((a) => a.type === "InternalIP")?.address}</span>],
          ["PodCIDR", <span class="mono">{n.spec.podCIDR}</span>],
          ["allocatable", <span class="mono">{`cpu ${fmtCpu(n.status.allocatable.cpu)} · memory ${fmtMem(n.status.allocatable.memory)} · pods ${n.status.allocatable.pods}`}</span>],
          ["받아 둔 이미지", <span class="mono small">{n.status.images.join(", ") || "없음"}</span>],
        ]}
      />
      <div class="actions">
        <button class="btn" onClick={() => runAndShow(`kubectl ${n.spec.unschedulable ? "uncordon" : "cordon"} ${n.metadata.name}`)}>
          {n.spec.unschedulable ? "uncordon" : "cordon"}
        </button>
        <button class="btn" onClick={() => sim.setNodePower(n.metadata.name, !powered)} title="전원·kubelet 을 끄고 켭니다. API 는 heartbeat(Lease)가 끊긴 것으로만 알아챕니다">
          <Icon name="power" size={14} />
          {powered ? "노드 끄기" : "다시 켜기"}
        </button>
      </div>
      <h3>Pod ({pods.length})</h3>
      <ul class="list">
        {pods.map((p) => (
          <li key={p.metadata.uid}>
            <Link kind="Pod" name={p.metadata.name} />
            <span class="muted">{podStatusText(p)}</span>
          </li>
        ))}
      </ul>
      <h3>이벤트</h3>
      <Events uid={n.metadata.uid} />
    </>
  );
}

// ---------- 설정 (매니페스트) ----------

function DeploymentSettings({ d }: { d: Deployment }) {
  const m = findManifest("Deployment", d.metadata.name);
  if (!m) {
    return <p class="note">이 Deployment 는 매니페스트에 없습니다 (kubectl 로 만듦). kubectl scale · set image 로 바꾸세요.</p>;
  }
  const ct = m.spec.template.spec.containers[0]!;
  const name = m.metadata.name;
  return (
    <>
      <p class="note">여기서 바꾸면 매니페스트를 고쳐 <span class="mono">kubectl apply</span> 한 것과 같습니다. 선언을 바꾸면 컨트롤러가 맞춥니다.</p>
      <Field label="replicas" hint="원하는 Pod 수">
        <div class="stepper">
          <button class="btn sm" disabled={m.spec.replicas <= 0} onClick={() => updateManifest(name, (x) => (x.spec.replicas = Math.max(0, x.spec.replicas - 1)))} aria-label="replicas 줄이기">
            −
          </button>
          <span class="mono stepper-num">{m.spec.replicas}</span>
          <button class="btn sm" disabled={m.spec.replicas >= 30} onClick={() => updateManifest(name, (x) => (x.spec.replicas = Math.min(30, x.spec.replicas + 1)))} aria-label="replicas 늘리기">
            +
          </button>
        </div>
      </Field>
      <Field label="이미지" hint={IMAGES[ct.image]?.description ?? "레지스트리에 없는 이미지 — pull 이 실패합니다"}>
        <TextInput
          value={ct.image}
          list="kube-sim-images"
          onCommit={(v) => updateManifest(name, (x) => (x.spec.template.spec.containers[0]!.image = v))}
          validate={(v) => (v.trim() ? undefined : "이미지 이름을 쓰세요")}
        />
        <datalist id="kube-sim-images">
          {IMAGE_NAMES.map((i) => (
            <option key={i} value={i} />
          ))}
        </datalist>
      </Field>
      <Field label="requests.cpu" hint="스케줄러가 자리를 찾을 때 보는 값 (예: 250m, 1)">
        <TextInput
          value={fmtCpu(ct.resources.requests.cpu)}
          onCommit={(v) => updateManifest(name, (x) => (x.spec.template.spec.containers[0]!.resources.requests.cpu = parseCpu(v)!))}
          validate={(v) => (parseCpu(v) === undefined ? "250m · 1 · 1.5 처럼 쓰세요" : undefined)}
        />
      </Field>
      <Field label="requests.memory" hint="예: 128Mi, 1Gi">
        <TextInput
          value={fmtMem(ct.resources.requests.memory)}
          onCommit={(v) => updateManifest(name, (x) => (x.spec.template.spec.containers[0]!.resources.requests.memory = parseMem(v)!))}
          validate={(v) => (parseMem(v) === undefined ? "128Mi · 1Gi 처럼 쓰세요" : undefined)}
        />
      </Field>
      <Field label="strategy" hint="RollingUpdate: 조금씩 바꿈 · Recreate: 옛 Pod 를 다 지운 뒤 새로 (그동안 서비스 중단)">
        <select
          class="input"
          value={m.spec.strategy?.type ?? "RollingUpdate"}
          onChange={(e) => updateManifest(name, (x) => (x.spec.strategy = e.currentTarget.value === "Recreate" ? { type: "Recreate" } : { type: "RollingUpdate", rollingUpdate: { maxSurge: "25%", maxUnavailable: "25%" } }))}
        >
          <option value="RollingUpdate">RollingUpdate</option>
          <option value="Recreate">Recreate</option>
        </select>
      </Field>
      {(m.spec.strategy?.type ?? "RollingUpdate") === "RollingUpdate" && (
        <div class="field-row">
          <Field label="maxSurge" hint="replicas 보다 더 둘 수 있는 수 (1 · 25%)">
            <TextInput
              value={String(m.spec.strategy?.rollingUpdate?.maxSurge ?? "25%")}
              validate={intOrPct}
              onCommit={(v) => updateManifest(name, (x) => (x.spec.strategy = { type: "RollingUpdate", rollingUpdate: { maxSurge: parseIntOrPct(v), maxUnavailable: x.spec.strategy?.rollingUpdate?.maxUnavailable ?? "25%" } }))}
            />
          </Field>
          <Field label="maxUnavailable" hint="동시에 빠져도 되는 수 (0 · 25%)">
            <TextInput
              value={String(m.spec.strategy?.rollingUpdate?.maxUnavailable ?? "25%")}
              validate={intOrPct}
              onCommit={(v) => updateManifest(name, (x) => (x.spec.strategy = { type: "RollingUpdate", rollingUpdate: { maxSurge: x.spec.strategy?.rollingUpdate?.maxSurge ?? "25%", maxUnavailable: parseIntOrPct(v) } }))}
            />
          </Field>
        </div>
      )}
      <Field label="preStop sleep (초)" hint="SIGTERM 전에 기다리는 시간 — 그사이 엔드포인트가 빠져 요청 실패가 없어진다. 0 이면 없음">
        <TextInput
          value={String(ct.lifecycle?.preStop?.sleep.seconds ?? 0)}
          validate={(v) => (/^\d+$/.test(v) && Number(v) <= 60 ? undefined : "0~60 사이 정수")}
          onCommit={(v) =>
            updateManifest(name, (x) => {
              const c0 = x.spec.template.spec.containers[0]!;
              if (Number(v) > 0) c0.lifecycle = { preStop: { sleep: { seconds: Number(v) } } };
              else delete c0.lifecycle;
            })
          }
        />
      </Field>
      <div class="actions">
        <button
          class="btn danger"
          onClick={() => {
            removeManifest("Deployment", name);
            selection.value = null;
          }}
        >
          <Icon name="trash" size={14} />
          Deployment 지우기
        </button>
      </div>
    </>
  );
}

function NodeSettings({ n }: { n: Node }) {
  const def = clusterDef.value.nodes.find((x) => x.name === n.metadata.name);
  if (!def) return <p class="note">정의에 없는 노드입니다.</p>;
  const cpuOpts = [500, 1000, 2000, 4000, 8000];
  const memOpts = [1024, 2048, 4096, 8192, 16384];
  return (
    <>
      <p class="note">노드 자원(allocatable)을 바꿉니다. 스케줄러가 바뀐 노드를 보고 기다리던 Pod 를 다시 시도합니다.</p>
      <Field label="cpu">
        <select class="input" value={String(def.cpu)} onChange={(e) => updateNodeDef(def.name, { cpu: Number(e.currentTarget.value) })}>
          {[...new Set([...cpuOpts, def.cpu])].sort((a, b) => a - b).map((v) => (
            <option key={v} value={String(v)}>
              {fmtCpu(v)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="memory">
        <select class="input" value={String(def.memory)} onChange={(e) => updateNodeDef(def.name, { memory: Number(e.currentTarget.value) })}>
          {[...new Set([...memOpts, def.memory])].sort((a, b) => a - b).map((v) => (
            <option key={v} value={String(v)}>
              {fmtMem(v)}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: preact.ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint && <span class="field-hint">{hint}</span>}
    </label>
  );
}

/** Enter·포커스 아웃에 확정. 잘못된 값이면 이유를 보이고 확정하지 않는다 */
function TextInput({ value, onCommit, validate, list }: { value: string; onCommit: (v: string) => void; validate?: (v: string) => string | undefined; list?: string }) {
  const draft = useSignal(value);
  const err = useSignal<string | undefined>(undefined);
  useEffect(() => {
    draft.value = value;
    err.value = undefined;
  }, [value]);
  const commit = () => {
    const v = draft.value.trim();
    if (v === value) return;
    const e = validate?.(v);
    err.value = e;
    if (!e) onCommit(v);
  };
  return (
    <>
      <input
        class={`input mono${err.value ? " invalid" : ""}`}
        value={draft.value}
        list={list}
        onInput={(e) => (draft.value = e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            draft.value = value;
            err.value = undefined;
          }
        }}
      />
      {err.value && <span class="field-err">{err.value}</span>}
    </>
  );
}

// ---------- 예제 안내 ----------

function ExamplePanel() {
  simVersion.value;
  const ex = exampleId.value ? exampleById(exampleId.value) : undefined;
  const pods = useMemo(() => sim.cluster.api.list("Pod"), [simVersion.value]);
  if (!ex) {
    return (
      <div class="insp-body">
        <p class="note">캔버스의 Pod·노드나 왼쪽 목록을 고르면 여기에 자세히 보입니다.</p>
      </div>
    );
  }
  return (
    <>
      <div class="insp-head">
        <div class="insp-kind">예제</div>
        <div class="insp-name">{ex.title}</div>
      </div>
      <div class="insp-body">
        <p class="lead">{ex.summary}</p>
        <h3>해 볼 것</h3>
        <ol class="tries">
          {ex.tries.map((t, i) => {
            const cmd = t.command ? resolveCommand(pods, t.command) : undefined;
            return (
              <li key={i} class="try">
                <div class="try-title">{t.title}</div>
                {t.action && <TryActionRow action={t.action} />}
                {t.command && (
                  <div class="try-cmd">
                    <code class="mono">{cmd ?? t.command}</code>
                    <button class="btn sm" disabled={!cmd} onClick={() => cmd && runAndShow(cmd)} title={cmd ? `kubectl 창에서 실행${t.expectFail ? " (실패하는 것이 정상입니다)" : ""}` : "지금은 대상이 없습니다"}>
                      실행
                    </button>
                  </div>
                )}
                <div class="try-expect">{t.expect}</div>
              </li>
            );
          })}
        </ol>
        <p class="muted small">캔버스의 Pod·노드나 왼쪽 목록을 고르면 개요·describe·YAML 을 볼 수 있습니다.</p>
      </div>
    </>
  );
}

function actionLabel(a: TryAction): string {
  if (a.type === "power") return a.on ? `노드 ${a.node} 다시 켜기` : `노드 ${a.node} 끄기`;
  if (a.type === "sick") return a.healthy ? `${a.deployment} 의 고장 난 Pod 고치기` : `${a.deployment} Pod 하나의 앱 고장 내기`;
  if (a.type === "traffic") return a.on ? `client 에서 ${a.service} 로 0.1초마다 curl (부하)` : "부하 멈추기";
  if (a.type === "prestop") return `${a.deployment} 에 preStop sleep ${a.seconds}초 넣기 (apply)`;
  return `(클러스터 밖에서) curl ${a.node}:<${a.service} 의 NodePort>`;
}

function intOrPct(v: string): string | undefined {
  return /^\d+%?$/.test(v.trim()) ? undefined : "1 처럼 개수나 25% 처럼 퍼센트";
}

function parseIntOrPct(v: string): number | string {
  const t = v.trim();
  return t.endsWith("%") ? t : Number(t);
}

function TryActionRow({ action }: { action: TryAction }) {
  simVersion.value;
  const blocked = sim.actionBlocked(action);
  return (
    <div class="try-cmd">
      <code class="mono">{actionLabel(action)}</code>
      <button
        class="btn sm"
        disabled={!!blocked}
        title={blocked ?? "실행"}
        onClick={() => {
          sim.runAction(action);
          if (action.type === "nodeport") {
            drawerTab.value = "kubectl";
            drawerOpen.value = true;
          }
        }}
      >
        실행
      </button>
    </div>
  );
}

// ---------- 네트워크 ----------

function CurlFrom({ pod }: { pod: string }) {
  const services = sim.cluster.api.list("Service", "default");
  const target = useSignal("");
  const first = services[0] ? `http://${services[0].metadata.name}` : "";
  const value = target.value || first;
  return (
    <>
      <h3>이 Pod 에서 요청 보내기</h3>
      <form
        class="curl-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) runAndShow(`kubectl exec ${pod} -- curl ${value.trim()}`);
        }}
      >
        <span class="mono small muted">curl</span>
        <input class="input mono" value={value} placeholder="http://web" list="kube-sim-svc-names" onInput={(e) => (target.value = e.currentTarget.value)} />
        <datalist id="kube-sim-svc-names">
          {services.map((s) => (
            <option key={s.metadata.name} value={`http://${s.metadata.name}`} />
          ))}
        </datalist>
        <button class="btn sm" type="submit">
          보내기
        </button>
      </form>
      <p class="muted small">Service 이름 · ClusterIP · Pod IP 로 보내 보세요. 경로가 캔버스에 그려집니다.</p>
    </>
  );
}

function ServiceOverview({ svc }: { svc: Service }) {
  const c = sim.cluster;
  const slices = c.api.list("EndpointSlice", "default").filter((s) => s.metadata.labels["kubernetes.io/service-name"] === svc.metadata.name);
  const eps = slices.flatMap((s) => s.endpoints);
  const client = sim.clientPod(svc.metadata.name);
  const traffic = c.traffic && !c.traffic.stopped ? c.traffic : undefined;
  const p = svc.spec.ports[0];
  return (
    <>
      <Rows
        rows={[
          ["type", svc.spec.type],
          ["ClusterIP", <span class="mono">{svc.spec.clusterIP}</span>],
          ["포트", <span class="mono">{svc.spec.ports.map((x) => `${x.port} → ${x.targetPort}${x.nodePort ? ` (NodePort ${x.nodePort})` : ""}`).join(", ")}</span>],
          ["selector", <span class="mono">{Object.entries(svc.spec.selector).map(([k, v]) => `${k}=${v}`).join(",") || "없음"}</span>],
          ["DNS", <span class="mono small">{svc.metadata.name}.default.svc.cluster.local</span>],
        ]}
      />
      <h3>엔드포인트 ({slices[0]?.metadata.name ?? "EndpointSlice 없음"})</h3>
      <ul class="ep-list">
        {eps.map((e) => (
          <li key={e.targetRef.uid}>
            <span class={`dot ${e.conditions.ready ? "ok" : "bad"}`} />
            <span class="ep-main">
              <Link kind="Pod" name={e.targetRef.name} />
              <span class="mono small muted">{`${e.addresses[0]}:${p?.targetPort}`}</span>
            </span>
            <span class={e.conditions.ready ? "muted small" : "warn-text"}>{e.conditions.ready ? "ready" : e.conditions.terminating ? "terminating" : "not ready"}</span>
          </li>
        ))}
        {!eps.length && <li class="muted small">셀렉터에 맞고 IP 가 있는 Pod 가 없습니다 → kube-proxy 가 REJECT 규칙을 씁니다</li>}
      </ul>
      <p class="muted small">ready 인 것만 kube-proxy 규칙에 들어가 트래픽을 받습니다.</p>
      <div class="actions">
        <button class="btn" disabled={!client} onClick={() => client && runAndShow(`kubectl exec ${client} -- curl http://${svc.metadata.name}${p && p.port !== 80 ? `:${p.port}` : ""}`)} title={client ? `${client} 에서 curl` : "요청을 보낼 돌고 있는 Pod 가 없습니다"}>
          curl 보내기{client ? ` (${client.length > 18 ? `${client.slice(0, 16)}…` : client} 에서)` : ""}
        </button>
        <button class="btn ghost" disabled={!client} onClick={() => client && runAndShow(`kubectl exec ${client} -- ping ${svc.metadata.name}`)}>
          ping
        </button>
        {traffic ? (
          <button class="btn danger" onClick={() => sim.stopTraffic()}>
            부하 멈추기
          </button>
        ) : (
          <button class="btn" disabled={!client} onClick={() => sim.startTraffic(svc.metadata.name)} title="0.1초마다 curl 을 계속 보내 성공·실패를 셉니다 (롤아웃·Pod 삭제 중 실패를 보려고)">
            부하 보내기
          </button>
        )}
      </div>
      {svc.spec.type === "NodePort" && p?.nodePort && (
        <>
          <h3>바깥에서 NodePort 로</h3>
          <div class="actions">
            {c.api.list("Node").map((n) => (
              <button
                key={n.metadata.name}
                class="btn sm"
                onClick={() => {
                  sim.curlNodePort(n.metadata.name, p.nodePort!);
                  drawerTab.value = "kubectl";
                  drawerOpen.value = true;
                }}
              >
                {n.metadata.name}:{p.nodePort}
              </button>
            ))}
          </div>
        </>
      )}
      <h3>이벤트</h3>
      <Events uid={svc.metadata.uid} />
    </>
  );
}

function ServiceSettings({ name }: { name: string }) {
  const m = findManifest("Service", name);
  if (!m) return <p class="note">이 Service 는 매니페스트에 없습니다 (kubectl 로 만듦).</p>;
  const p = m.spec.ports[0]!;
  const num = (v: string) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : "1~65535 사이 숫자");
  return (
    <>
      <p class="note">여기서 바꾸면 매니페스트를 고쳐 kubectl apply 한 것과 같습니다.</p>
      <Field label="type" hint="NodePort 면 모든 노드의 30000-32767 중 한 포트가 열립니다">
        <select class="input" value={m.spec.type} onChange={(e) => updateServiceManifest(name, (x) => (x.spec.type = e.currentTarget.value as "ClusterIP" | "NodePort"))}>
          <option value="ClusterIP">ClusterIP</option>
          <option value="NodePort">NodePort</option>
        </select>
      </Field>
      <Field label="port" hint="ClusterIP 에서 받는 포트">
        <TextInput value={String(p.port)} validate={num} onCommit={(v) => updateServiceManifest(name, (x) => (x.spec.ports[0]!.port = Number(v)))} />
      </Field>
      <Field label="targetPort" hint="Pod 의 앱이 듣는 포트. 틀리면 연결 거부">
        <TextInput value={String(p.targetPort)} validate={num} onCommit={(v) => updateServiceManifest(name, (x) => (x.spec.ports[0]!.targetPort = Number(v)))} />
      </Field>
      <div class="actions">
        <button
          class="btn danger"
          onClick={() => {
            removeManifest("Service", name);
            selection.value = null;
          }}
        >
          <Icon name="trash" size={14} />
          Service 지우기
        </button>
      </div>
    </>
  );
}

function IptablesView({ node }: { node: string }) {
  const proxy = sim.cluster.kubeProxies.get(node);
  const powered = sim.cluster.nodePowered(node);
  return (
    <>
      <p class="note">
        이 노드의 kube-proxy 가 써 둔 규칙 (<span class="mono">iptables-save | grep KUBE</span> — ready 엔드포인트가 없는 Service 의 REJECT 는 filter, DNAT 은 nat 테이블). 이 노드에서 나가는 요청은 이 규칙을 따라 DNAT 됩니다.
        {!powered && " 노드가 꺼져 있어 마지막으로 쓴 규칙에서 멈춰 있습니다."}
      </p>
      <pre class="term">{proxy ? proxy.iptablesSave() : "kube-proxy 없음"}</pre>
    </>
  );
}
