// 오른쪽 인스펙터: 고른 오브젝트의 개요·설정·describe·YAML. 아무것도 안 골랐으면 예제의 "해 볼 것".
import { useSignal } from "@preact/signals";
import { useEffect, useMemo } from "preact/hooks";
import { controllerOf, type Deployment, type KObject, type Node, type Pod, type ReplicaSet } from "../core/api/types";
import { eventSource, podRestartsText, podStatusText, runKubectl } from "../core/kubectl";
import { fmtAge, fmtCpu, fmtMem, parseCpu, parseMem } from "../core/units";
import { IMAGE_NAMES, IMAGES } from "../core/workloads";
import { exampleById, resolveCommand } from "../model/examples";
import { sim, simVersion } from "../model/sim";
import { clusterDef, drawerOpen, drawerTab, exampleId, removeManifest, selection, updateManifest, updateNodeDef } from "../model/store";
import { toneOf } from "../model/view";
import { toYaml } from "../model/yaml";
import { Icon } from "./Icons";

type Tab = "overview" | "settings" | "describe" | "yaml";

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
  const hasSettings = obj?.kind === "Deployment" || obj?.kind === "Node";
  useEffect(() => {
    if (tab.value === "settings" && !hasSettings) tab.value = "overview";
  }, [sel?.kind, sel?.name, hasSettings]);

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
  const tabs: [Tab, string][] = [["overview", "개요"], ...(hasSettings ? ([["settings", "설정"]] as [Tab, string][]) : []), ["describe", "describe"], ["yaml", "YAML"]];
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
  if (obj.kind === "Node") return <span class={`badge t-${obj.spec.unschedulable ? "wait" : "ok"}`}>{obj.spec.unschedulable ? "SchedulingDisabled" : "Ready"}</span>;
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
      </div>
      <h3>이벤트</h3>
      <Events uid={p.metadata.uid} />
    </>
  );
}

function DeploymentOverview({ d }: { d: Deployment }) {
  const c = sim.cluster;
  const rss = c.api.list("ReplicaSet", "default").filter((r) => controllerOf(r.metadata)?.uid === d.metadata.uid);
  const drift = sim.drift(d.metadata.name);
  const inManifest = clusterDef.value.manifests.some((m) => m.metadata.name === d.metadata.name);
  return (
    <>
      {inManifest && drift.length > 0 && <DriftNote name={d.metadata.name} drift={drift} />}
      <Rows
        rows={[
          ["replicas", `원하는 ${d.spec.replicas} · 있는 ${d.status.replicas} · Ready ${d.status.readyReplicas}`],
          ["selector", <span class="mono">{Object.entries(d.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(",")}</span>],
          ["이미지", <span class="mono">{d.spec.template.spec.containers[0]?.image}</span>],
          ["generation", `${d.metadata.generation} (관찰 ${d.status.observedGeneration})`],
        ]}
      />
      <h3>ReplicaSet</h3>
      <p class="muted small">템플릿 해시마다 하나. 지금 템플릿의 것만 replicas 를 가집니다.</p>
      <ul class="list">
        {rss.map((r) => (
          <li key={r.metadata.uid}>
            <Link kind="ReplicaSet" name={r.metadata.name} />
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
  return (
    <>
      <Rows
        rows={[
          ["상태", n.spec.unschedulable ? "Ready, SchedulingDisabled (cordon)" : "Ready"],
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
  const m = clusterDef.value.manifests.find((x) => x.metadata.name === d.metadata.name);
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
      <div class="actions">
        <button
          class="btn danger"
          onClick={() => {
            removeManifest(name);
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
                {t.command && (
                  <div class="try-cmd">
                    <code class="mono">{cmd ?? t.command}</code>
                    <button class="btn sm" disabled={!cmd} onClick={() => cmd && runAndShow(cmd)} title={cmd ? "kubectl 창에서 실행" : "지금은 대상이 없습니다"}>
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
