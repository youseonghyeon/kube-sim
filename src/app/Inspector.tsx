// 오른쪽 인스펙터: 고른 오브젝트의 개요·설정·describe·YAML. 아무것도 안 골랐으면 예제의 "해 볼 것".
import { useSignal } from "@preact/signals";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { controllerOf, isNodeReady, limitOf, NODE_LEASE_NS, qosClass, type Application, type ConfigMap, type Secret, type Deployment, type Ingress, type KObject, type Node, type Pod, type ReplicaSet, type Service } from "../core/api/types";
import type { DeploymentManifest, Manifest } from "../core/cluster";
import { eventSource, nodeStatusText, podRestartsText, podStatusText, rolloutStatusLine, runKubectl } from "../core/kubectl";
import { fmtAge, fmtCpu, fmtMem, parseCpu, parseMem } from "../core/units";
import { IMAGE_NAMES, IMAGES } from "../core/workloads";
import { NODE_MONITOR_GRACE_MS } from "../core/controllers/nodelifecycle";
import { exampleById, resolveCommand, type TryAction } from "../model/examples";
import { appGet } from "../core/gitops/cli";
import { deploymentHash, HASH_LABEL, revisionOf } from "../core/controllers/deployment";
import { sim, simTime, simVersion } from "../model/sim";
import { addManifest, clusterDef, drawerOpen, drawerTab, exampleId, findManifest, updateConfigManifest, updateIngressManifest, INSPECTOR_MIN, INSPECTOR_WIDE, inspectorOpen, inspectorWidth, setInspectorWidth, toggleInspector, toggleInspectorWide, removeManifest, selection, updateManifest, updateNodeDef, updateServiceManifest } from "../model/store";
import { toneOf } from "../model/view";
import { toYaml } from "../core/yaml";
import { flattenRules, hostError, ingressNginxManifests, pathError, setRules, type RuleRow } from "../model/ingressForm";
import { NGINX_SERVICE } from "../core/net/ingress";
import { b64decode } from "../core/base64";
import { configUsers } from "../model/configUse";
import { Icon } from "./Icons";

type Tab = "overview" | "settings" | "iptables" | "describe" | "yaml";

export function runAndShow(cmd: string): void {
  sim.kubectl(cmd);
  drawerTab.value = "kubectl";
  drawerOpen.value = true;
}

/**
 * 오른쪽 틀: 왼쪽 가장자리를 끌어 폭 조절(두 번 누르면 보통 ↔ 넓게), 최소보다 한참 더 끌면 접힘(레일만), ⌘\ 로 접기·펴기.
 * net-sim 의 인스펙터와 같은 방식. 폭·접힘은 브라우저에 저장한다.
 */
export function Inspector() {
  const resizing = useRef<{ start: number; grab: number } | null>(null);
  if (!inspectorOpen.value) {
    return (
      <div class="inspector-frame collapsed">
        <button class="icon-btn" onClick={toggleInspector} title="오른쪽 패널 펼치기 (⌘\)" aria-label="오른쪽 패널 펼치기">
          <Icon name="panel" size={18} />
        </button>
      </div>
    );
  }
  // 패널 오른쪽 끝은 창에 붙어 있으므로 폭 = 창 오른쪽 - 포인터 x (- 잡은 자리)
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // 잡은 자리와 실제 가장자리의 차이 — 누르기만 해도 폭이 튀지 않게
    resizing.current = { start: inspectorWidth.peek(), grab: window.innerWidth - e.clientX - inspectorWidth.peek() };
    document.body.classList.add("resizing-col");
  };
  const onMove = (e: PointerEvent) => {
    const r = resizing.current;
    if (!r) return;
    const w = window.innerWidth - e.clientX - r.grab;
    if (w < INSPECTOR_MIN - 70) {
      // 최소 폭보다 한참 더 끌면 접는다 — 다시 펴면 끌기 전 폭으로
      onUp(e);
      setInspectorWidth(r.start);
      toggleInspector();
      return;
    }
    setInspectorWidth(w);
  };
  const onUp = (e: PointerEvent) => {
    if (!resizing.current) return;
    resizing.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("resizing-col");
  };
  const wide = inspectorWidth.value >= INSPECTOR_WIDE - 40;
  return (
    <div class="inspector-frame">
      <div
        class="inspector-resize"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onDblClick={toggleInspectorWide}
        title="끌어서 폭 조절 · 두 번 눌러 보통/넓게 · 오른쪽 끝까지 끌면 접힘"
      />
      <InspectorPanel />
      <div class="inspector-tools">
        <button class="icon-btn sm" onClick={toggleInspectorWide} title={wide ? "보통 폭" : "넓게 (describe·YAML 이 한눈에)"} aria-label={wide ? "보통 폭" : "넓게"}>
          <Icon name="widen" size={15} />
        </button>
        <button class="icon-btn sm" onClick={toggleInspector} title="오른쪽 패널 접기 (⌘\)" aria-label="오른쪽 패널 접기">
          <Icon name="panel" size={15} />
        </button>
      </div>
    </div>
  );
}

function InspectorPanel() {
  simVersion.value;
  const sel = selection.value;
  const tab = useSignal<Tab>("overview");
  const obj = sel ? sim.cluster.api.get(sel.kind as KObject["kind"], sel.name, sel.namespace ?? "default") : undefined;
  const hasSettings =
    obj?.kind === "Deployment" ||
    obj?.kind === "Node" ||
    (obj?.kind === "Service" && !!findManifest("Service", obj.metadata.name)) ||
    (obj?.kind === "Ingress" && !!findManifest("Ingress", obj.metadata.name)) ||
    ((obj?.kind === "ConfigMap" || obj?.kind === "Secret") && !!findManifest(obj.kind, obj.metadata.name));
  const hasIptables = obj?.kind === "Node";
  useEffect(() => {
    if ((tab.value === "settings" && !hasSettings) || (tab.value === "iptables" && !hasIptables)) tab.value = "overview";
  }, [sel?.kind, sel?.name, hasSettings, hasIptables]);

  if (!sel) return <aside class="inspector">{<ExamplePanel />}</aside>;
  if (sel.kind === "GitRepo") return <GitPanel url={sel.name} />;
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
        {tab.value === "settings" && obj.kind === "Ingress" && <IngressSettings name={obj.metadata.name} />}
        {tab.value === "settings" && (obj.kind === "ConfigMap" || obj.kind === "Secret") && <ConfigSettings kind={obj.kind} name={obj.metadata.name} />}
        {tab.value === "iptables" && obj.kind === "Node" && <IptablesView node={obj.metadata.name} />}
        {tab.value === "describe" && (
          <pre class="term">{obj.kind === "Application" ? appGet(sim.cluster, obj) : runKubectl(sim.cluster, `describe ${obj.kind.toLowerCase()} ${obj.metadata.name}`).output}</pre>
        )}
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
  if (obj.kind === "Ingress") return <span class="badge">{obj.spec.ingressClassName ?? "class 없음"}</span>;
  if (obj.kind === "Application")
    return (
      <>
        <span class={`badge t-${obj.status.sync.status === "Synced" ? "ok" : "wait"}`}>{obj.status.sync.status}</span>
        <span class={`badge t-${obj.status.health.status === "Healthy" ? "ok" : obj.status.health.status === "Degraded" || obj.status.health.status === "Missing" ? "bad" : "wait"}`}>{obj.status.health.status}</span>
      </>
    );
  if (obj.kind === "PodDisruptionBudget") return <span class={`badge t-${obj.status.disruptionsAllowed > 0 ? "ok" : "wait"}`}>{`허용 ${obj.status.disruptionsAllowed}`}</span>;
  if (obj.kind === "ConfigMap" || obj.kind === "Secret") return <span class="badge">{`키 ${Object.keys(obj.data).length}`}</span>;
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
    case "Ingress":
      return <IngressOverview ing={obj} />;
    case "Application":
      return <ApplicationOverview app={obj} />;
    case "ConfigMap":
    case "Secret":
      return <ConfigOverview obj={obj} />;
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
      {cs?.lastState && "terminated" in cs.lastState && cs.lastState.terminated.reason === "OOMKilled" && <OomNote p={p} />}
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
      <PodResources p={p} />
      <PodConfig p={p} />
      <h3>이벤트</h3>
      <Events uid={p.metadata.uid} />
    </>
  );
}

/** 지난번 OOMKilled 가 컨테이너 자신의 limit 때문인지, 노드 메모리가 넘쳐서인지 (마지막 kubelet.oom 트레이스로 가린다) */
function OomNote({ p }: { p: Pod }) {
  const evs = sim.cluster.trace.events;
  let last: (typeof evs)[number] | undefined;
  for (let i = evs.length - 1; i >= 0 && !last; i--) if (evs[i]!.kind === "kubelet.oom" && evs[i]!.ref?.name === p.metadata.name) last = evs[i];
  const node = last?.msg.includes("노드의 커널 OOM killer");
  return (
    <div class="callout bad">
      <div class="callout-title">OOMKilled (exit 137)</div>
      <div class="small">
        {node
          ? "노드 메모리가 넘쳐 노드의 커널 OOM killer 가 이 컨테이너를 골랐습니다 (oom_score 가 가장 큼). 이 Pod 잘못이 아닐 수도 있습니다 — limits 없이 많이 쓰는 이웃이 있는지 kubectl top pods 로 보세요."
          : "메모리 사용이 limits.memory 에 닿아 커널(cgroup)이 컨테이너를 죽였습니다. limit 을 올리거나 앱의 메모리 사용(힙 크기·누수)을 줄이세요."}
      </div>
    </div>
  );
}

/** Pod 의 자원: requests(예약) · limits(상한) · 실사용(kubectl top) 을 한 막대에. 메모리 누수처럼 이벤트 없이 변하는 값이라 화면 시계마다 다시 그린다 */
function PodResources({ p }: { p: Pod }) {
  simTime.value;
  const ct = p.spec.containers[0];
  if (!ct) return null;
  const m = sim.cluster.podMetrics(p);
  const req = ct.resources.requests;
  const lim = { cpu: limitOf(ct, "cpu"), memory: limitOf(ct, "memory") };
  const cpu = m?.cpuState;
  return (
    <>
      <h3>자원 · QoS {qosClass(p.spec)}</h3>
      <div class="usage">
        <UsageBar label="memory" use={m?.memory} request={req.memory} limit={lim.memory} fmt={fmtMem} />
        <UsageBar label="cpu" use={cpu?.got} want={cpu?.want} request={req.cpu} limit={lim.cpu} fmt={fmtCpu} />
      </div>
      <div class="usage-legend">
        <span>
          <i class="lg use" />
          실사용
        </span>
        <span>
          <i class="lg req" />
          requests (예약)
        </span>
        <span>
          <i class="lg lim" />
          limits (상한)
        </span>
      </div>
      {cpu?.reason && (
        <p class="note">
          {cpu.reason === "limit"
            ? `CPU throttling: 앱은 ${fmtCpu(cpu.want)} 를 원하지만 limits.cpu ${fmtCpu(cpu.limit ?? 0)} 에 막혀 그만큼만 받습니다. 죽지는 않지만 응답이 ${cpu.got ? `${(cpu.want / cpu.got).toFixed(1)}배` : "아주 많이"} 느려집니다.`
            : `노드 CPU 가 모자라 requests 비율로 나눠 받습니다 (원하는 ${fmtCpu(cpu.want)} 중 ${fmtCpu(cpu.got)}). requests 가 클수록 더 받습니다.`}
        </p>
      )}
      {!m && <p class="muted small">컨테이너가 돌고 있지 않아 실사용이 없습니다 (kubectl top 에도 안 보임).</p>}
    </>
  );
}

/** 막대 하나: 채움 = 실사용, 눈금 = requests(예약)·limits(상한). 원하는 CPU 가 받는 것보다 크면 옅은 채움으로 */
function UsageBar({ label, use, want, request, limit, fmt }: { label: string; use?: number; want?: number; request: number; limit?: number; fmt: (n: number) => string }) {
  const scale = Math.max(limit ?? 0, request, use ?? 0, want ?? 0, 1) * 1.15;
  const pct = (n: number) => `${Math.min(100, (n / scale) * 100)}%`;
  const near = use !== undefined && limit !== undefined && use / limit >= 0.8;
  return (
    <div class="usage-row">
      <div class="usage-head">
        <span class="usage-label">{label}</span>
        <span class="mono small">
          {use !== undefined ? `사용 ${fmt(use)}` : "사용 —"}
          {want !== undefined && use !== undefined && want > use ? ` (원함 ${fmt(want)})` : ""} · requests {request ? fmt(request) : "없음"} · limits {limit !== undefined ? fmt(limit) : "없음"}
        </span>
      </div>
      <div class="usage-bar">
        {want !== undefined && use !== undefined && want > use && <span class="usage-want" style={{ width: pct(want) }} />}
        {use !== undefined && <span class={`usage-fill${near ? " hot" : ""}`} style={{ width: pct(use) }} />}
        {request > 0 && <span class="usage-tick req" style={{ left: pct(request) }} title={`requests ${fmt(request)} — 스케줄러가 잡아 두는 몫`} />}
        {limit !== undefined && <span class="usage-tick lim" style={{ left: pct(limit) }} title={`limits ${fmt(limit)} — 커널이 거는 상한`} />}
      </div>
    </div>
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

function sumOf(pods: Pod[], f: (p: Pod) => number): number {
  return pods.reduce((n, p) => n + f(p), 0);
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
          ["requests 합", <span class="mono">{`cpu ${fmtCpu(sumOf(pods, (p) => p.spec.containers[0]?.resources.requests.cpu ?? 0))} · memory ${fmtMem(sumOf(pods, (p) => p.spec.containers[0]?.resources.requests.memory ?? 0))}`}</span>],
          [
            "실사용 (top)",
            powered ? (
              <span class="mono">{`cpu ${fmtCpu(sumOf(pods, (p) => c.podMetrics(p)?.cpu ?? 0))} · memory ${fmtMem(sumOf(pods, (p) => c.podMetrics(p)?.memory ?? 0))}`}</span>
            ) : (
              <span class="muted">알 수 없음 (꺼짐)</span>
            ),
          ],
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
          validate={(v) => (parseCpu(v) === undefined ? "250m · 1 · 1.5 처럼 쓰세요" : overLimit(parseCpu(v)!, ct.resources.limits?.cpu, fmtCpu, "cpu"))}
        />
      </Field>
      <Field label="requests.memory" hint="예: 128Mi, 1Gi">
        <TextInput
          value={fmtMem(ct.resources.requests.memory)}
          onCommit={(v) => updateManifest(name, (x) => (x.spec.template.spec.containers[0]!.resources.requests.memory = parseMem(v)!))}
          validate={(v) => (parseMem(v) === undefined ? "128Mi · 1Gi 처럼 쓰세요" : overLimit(parseMem(v)!, ct.resources.limits?.memory, fmtMem, "memory"))}
        />
      </Field>
      <div class="field-row">
        <Field label="limits.cpu" hint="넘으면 죽지 않고 느려짐 (throttling). 비우면 상한 없음">
          <TextInput
            value={ct.resources.limits?.cpu !== undefined ? fmtCpu(ct.resources.limits.cpu) : ""}
            placeholder="없음"
            onCommit={(v) => updateManifest(name, (x) => setLimit(x, "cpu", v ? parseCpu(v) : undefined))}
            validate={(v) => (!v ? undefined : parseCpu(v) === undefined ? "200m · 1 처럼 쓰세요" : overLimit(ct.resources.requests.cpu, parseCpu(v), fmtCpu, "cpu"))}
          />
        </Field>
        <Field label="limits.memory" hint="넘으면 OOMKilled (exit 137). 비우면 상한 없음">
          <TextInput
            value={ct.resources.limits?.memory !== undefined ? fmtMem(ct.resources.limits.memory) : ""}
            placeholder="없음"
            onCommit={(v) => updateManifest(name, (x) => setLimit(x, "memory", v ? parseMem(v) : undefined))}
            validate={(v) => (!v ? undefined : parseMem(v) === undefined ? "256Mi · 1Gi 처럼 쓰세요" : overLimit(ct.resources.requests.memory, parseMem(v), fmtMem, "memory"))}
          />
        </Field>
      </div>
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

/** requests 가 limits 보다 크면 API 서버가 거절한다 — 고치기 전에 알려 준다 */
function overLimit(request: number, limit: number | undefined, fmt: (n: number) => string, what: string): string | undefined {
  return limit !== undefined && request > limit ? `requests ${fmt(request)} 가 limits ${fmt(limit)} 보다 큽니다 — API 서버가 거절합니다 (${what} 둘 다 맞추세요)` : undefined;
}

function setLimit(m: DeploymentManifest, key: "cpu" | "memory", v: number | undefined): void {
  const r = m.spec.template.spec.containers[0]!.resources;
  const next = { ...r.limits };
  if (v === undefined) delete next[key];
  else next[key] = v;
  if (next.cpu === undefined && next.memory === undefined) delete r.limits;
  else r.limits = next;
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
function TextInput({ value, onCommit, validate, list, placeholder }: { value: string; onCommit: (v: string) => void; validate?: (v: string) => string | undefined; list?: string; placeholder?: string }) {
  const draft = useSignal(value);
  const err = useSignal<string | undefined>(undefined);
  // 바깥 값이 실제로 바뀌었을 때만 고쳐 쓰던 글자를 덮는다 — 처음 그린 뒤 늦게 도는 effect 가 그사이 입력을 지우지 않게
  const shown = useRef(value);
  useEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    draft.value = value;
    err.value = undefined;
  }, [value]);
  const commit = () => {
    const v = draft.value.trim();
    if (v === value) {
      err.value = undefined;
      return;
    }
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
        placeholder={placeholder}
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
  if (a.type === "ci-bump") return `CI: 새 이미지 빌드 → Git 의 ${a.file.split("/").pop()} 태그 커밋`;
  if (a.type === "git-rm") return `Git 에서 ${a.file.split("/").pop()} 지우고 커밋`;
  if (a.type === "helm-upgrade") return `helm upgrade — ${Object.entries(a.data).map(([k, v]) => `${k}=${v}`).join(", ")}${a.checksum ? " (checksum/config 주석 있음)" : " (checksum 주석 없음)"}`;
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
      {svc.spec.type !== "ClusterIP" && <ExternalAccess svc={svc} />}
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

// ---------- 바깥에서 들어오는 길 (4단계) ----------

/** NodePort·LoadBalancer Service: 바깥 주소, 맡은 노드, externalTrafficPolicy 바꾸기, 바깥에서 curl */
function ExternalAccess({ svc }: { svc: Service }) {
  const c = sim.cluster;
  const p = svc.spec.ports[0];
  const ip = svc.status.loadBalancer?.ingress?.[0]?.ip;
  const announcer = ip ? c.metallb.announcer(svc.metadata.namespace ?? "default", svc.metadata.name) : undefined;
  const etp = svc.spec.externalTrafficPolicy ?? "Cluster";
  const other = etp === "Cluster" ? "Local" : "Cluster";
  return (
    <>
      <h3>바깥에서</h3>
      <Rows
        rows={[
          ...(svc.spec.type === "LoadBalancer"
            ? ([
                ["LoadBalancer IP", <span class="mono">{ip ?? "<pending> (MetalLB 풀이 다 참)"}</span>],
                ["맡은 노드", announcer ? `${announcer} (L2: ARP 에 이 노드가 답함)` : <span class="warn-text">없음{etp === "Local" ? " — Local 인데 Ready Pod 가 있는 노드가 없음" : ""}</span>],
              ] as [string, preact.ComponentChildren][])
            : []),
          ["NodePort", <span class="mono">{p?.nodePort ?? "—"} (모든 노드)</span>],
          [
            "externalTrafficPolicy",
            <span class="small">
              {etp === "Cluster" ? "Cluster — 아무 노드의 Pod 로, 출발지는 노드 IP 로 SNAT (클라이언트 IP 사라짐)" : "Local — 들어온 노드의 Pod 로만, 출발지 보존 (Pod 없는 노드로 오면 버림)"}
            </span>,
          ],
        ]}
      />
      <div class="actions">
        <button class="btn sm" onClick={() => runAndShow(`kubectl patch svc ${svc.metadata.name} -p '{"spec":{"externalTrafficPolicy":"${other}"}}'`)}>
          {other} 로 바꾸기
        </button>
        {ip && (
          <button class="btn sm" onClick={() => runAndShow(`curl http://${ip}${p && p.port !== 80 ? `:${p.port}` : ""}/`)}>
            바깥에서 curl {ip}
          </button>
        )}
        {p?.nodePort &&
          c.api.list("Node").map((n) => (
            <button key={n.metadata.name} class="btn sm ghost" onClick={() => runAndShow(`curl http://${n.status.addresses[0]?.address}:${p.nodePort}/`)}>
              {n.metadata.name}:{p.nodePort}
            </button>
          ))}
      </div>
    </>
  );
}

function IngressOverview({ ing }: { ing: Ingress }) {
  const address = ing.status.loadBalancer.ingress?.[0]?.ip ?? ing.status.loadBalancer.ingress?.[0]?.hostname;
  const ts = ing.spec.ingressClassName === "tailscale";
  const funnel = ing.metadata.annotations?.["tailscale.com/funnel"] === "true";
  const hosts = [...new Set((ing.spec.rules ?? []).map((r) => r.host).filter((h): h is string => !!h))];
  const urls = ts && address ? [`https://${address}/`] : hosts.map((h) => `http://${h}/`);
  return (
    <>
      <NoControllerNote ing={ing} />
      <div class="callout">
        <div class="small">
          {ts
            ? "Tailscale 오퍼레이터가 이 Ingress 마다 프록시 Pod 를 띄워 tailnet 기기로 붙입니다. 프록시가 TLS 를 끝내고 backend Service 로 보냅니다 — NodePort·LoadBalancer·노드 공인 IP 가 필요 없습니다."
            : "ingress-nginx 컨트롤러 Pod 가 Host·경로를 보고 규칙에 맞는 Service 의 Pod 로 직접 프록시합니다. 바깥에서는 컨트롤러의 LoadBalancer IP 로 들어옵니다."}
        </div>
      </div>
      <Rows
        rows={[
          ["class", ing.spec.ingressClassName ?? "없음 (아무 컨트롤러도 처리하지 않음)"],
          ["ADDRESS", <span class="mono">{address ?? "아직 없음"}</span>],
          ...(ts ? ([["funnel", funnel ? "켜짐 — 공인 인터넷에서 접근" : "꺼짐 — tailnet 안에서만"]] as [string, preact.ComponentChildren][]) : []),
        ]}
      />
      <h3>규칙</h3>
      <ul class="list">
        {(ing.spec.rules ?? []).flatMap((r) =>
          r.http.paths.map((p) => (
            <li key={`${r.host}${p.path}`}>
              <span class="mono small">
                {r.host ?? "*"}
                {p.path} ({p.pathType})
              </span>
              <span>
                → <Link kind="Service" name={p.backend.service.name} />:{p.backend.service.port.number}
              </span>
            </li>
          )),
        )}
        {ing.spec.defaultBackend && (
          <li>
            <span class="mono small">(기본)</span>
            <span>
              → <Link kind="Service" name={ing.spec.defaultBackend.service.name} />:{ing.spec.defaultBackend.service.port.number}
            </span>
          </li>
        )}
      </ul>
      <div class="actions">
        {urls.map((u) => (
          <button key={u} class="btn sm" onClick={() => runAndShow(`curl ${u}`)}>
            바깥에서 curl {u}
          </button>
        ))}
      </div>
      <h3>이벤트</h3>
      <Events uid={ing.metadata.uid} />
    </>
  );
}

/** class 를 처리할 컨트롤러가 없으면 아무도 이 Ingress 를 보지 않는다 — 주소가 안 붙는 이유와 고치는 법 */
function NoControllerNote({ ing }: { ing: Ingress }) {
  const cls = ing.spec.ingressClassName;
  if (cls === "tailscale") return null;
  if (cls === "nginx" && sim.cluster.api.get("Service", NGINX_SERVICE, "default")) return null;
  return (
    <div class="callout warn">
      <div class="callout-title">{cls === "nginx" ? "ingress-nginx 컨트롤러가 없습니다" : `class "${cls ?? "(없음)"}" 를 처리할 컨트롤러가 없습니다`}</div>
      <div class="small">
        Ingress 는 규칙일 뿐이고, 그 class 를 맡은 컨트롤러가 있어야 ADDRESS 가 붙고 요청이 갑니다. 이 시뮬레이터에는 nginx(설치 필요)와 tailscale(오퍼레이터가 있음) 두 가지가 있습니다.
      </div>
      {cls === "nginx" && (
        <button class="btn sm" onClick={() => ingressNginxManifests().forEach((m) => addManifest(m))} title="helm install ingress-nginx 의 축소판: 컨트롤러 Deployment + LoadBalancer Service 를 매니페스트에 더합니다">
          ingress-nginx 설치
        </button>
      )}
    </div>
  );
}

/** Ingress 매니페스트 편집: class · funnel · 규칙(Host·경로 → Service:포트) · 기본 backend */
function IngressSettings({ name }: { name: string }) {
  const m = findManifest("Ingress", name);
  if (!m) return <p class="note">이 Ingress 는 매니페스트에 없습니다 (kubectl 로 만듦).</p>;
  const ing = sim.cluster.api.get("Ingress", name, "default");
  const services = sim.cluster.api.list("Service", "default").filter((s) => s.metadata.name !== NGINX_SERVICE);
  const portOf = (svc: string) => services.find((s) => s.metadata.name === svc)?.spec.ports[0]?.port ?? 80;
  const rows = flattenRules(m);
  const ts = m.spec.ingressClassName === "tailscale";
  const setRow = (i: number, patch: Partial<RuleRow>) =>
    updateIngressManifest(name, (x) => {
      const next = flattenRules(x);
      next[i] = { ...next[i]!, ...patch };
      setRules(x, next);
    });
  const svcOptions = (cur: string) => (
    <>
      {!services.some((s) => s.metadata.name === cur) && <option value={cur}>{cur} (없음)</option>}
      {services.map((s) => (
        <option key={s.metadata.uid} value={s.metadata.name}>
          {s.metadata.name}
        </option>
      ))}
    </>
  );
  return (
    <>
      <p class="note">여기서 바꾸면 매니페스트를 고쳐 kubectl apply 한 것과 같습니다.</p>
      {ing && <NoControllerNote ing={ing} />}
      <Field label="ingressClassName" hint="어느 컨트롤러가 이 규칙을 처리하나 — nginx: LoadBalancer IP 로 들어옴 · tailscale: 프록시 Pod 가 tailnet 기기로 붙음">
        <select
          class="input"
          value={m.spec.ingressClassName ?? "nginx"}
          onChange={(e) =>
            updateIngressManifest(name, (x) => {
              x.spec.ingressClassName = e.currentTarget.value;
              // tailnet 기기 이름은 tls.hosts 에서 온다
              if (x.spec.ingressClassName === "tailscale" && !x.spec.tls?.length) x.spec.tls = [{ hosts: [name] }];
            })
          }
        >
          <option value="nginx">nginx</option>
          <option value="tailscale">tailscale</option>
        </select>
      </Field>
      {ts && (
        <label class="check field">
          <input
            type="checkbox"
            checked={m.metadata.annotations?.["tailscale.com/funnel"] === "true"}
            onChange={(e) =>
              updateIngressManifest(name, (x) => {
                const ann = { ...x.metadata.annotations };
                if (e.currentTarget.checked) ann["tailscale.com/funnel"] = "true";
                else delete ann["tailscale.com/funnel"];
                if (Object.keys(ann).length) x.metadata.annotations = ann;
                else delete x.metadata.annotations;
              })
            }
          />
          funnel — 공인 인터넷에서도 접근 (끄면 tailnet 안에서만)
        </label>
      )}
      <h3>규칙 (Host · 경로 → Service:포트)</h3>
      {ts && <p class="muted small">tailscale 은 Host 를 보지 않습니다 (주소는 기기 이름 하나). 경로로만 나눕니다.</p>}
      <div class="rules">
        {rows.map((r, i) => (
          <div key={i} class="rule-row" data-rule={i}>
            <div class="rule-cell r-host">
              <TextInput value={r.host} placeholder="* (모든 Host)" validate={hostError} onCommit={(v) => setRow(i, { host: v })} />
            </div>
            <div class="rule-cell r-path">
              <TextInput value={r.path} validate={pathError} onCommit={(v) => setRow(i, { path: v })} />
            </div>
            <span class="r-arrow">→</span>
            <select class="input r-svc" value={r.service} onChange={(e) => setRow(i, { service: e.currentTarget.value, port: portOf(e.currentTarget.value) })} aria-label="Service">
              {svcOptions(r.service)}
            </select>
            <div class="rule-cell r-port">
              <TextInput value={String(r.port)} validate={(v) => (/^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 ? undefined : "1~65535")} onCommit={(v) => setRow(i, { port: Number(v) })} />
            </div>
            <button
              class="icon-btn sm r-del"
              disabled={rows.length === 1 && !m.spec.defaultBackend}
              title={rows.length === 1 && !m.spec.defaultBackend ? "규칙이나 기본 backend 중 하나는 있어야 합니다 (API 서버가 거절)" : "이 규칙 지우기"}
              aria-label="규칙 지우기"
              onClick={() =>
                updateIngressManifest(name, (x) => {
                  const next = flattenRules(x);
                  next.splice(i, 1);
                  setRules(x, next);
                })
              }
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        {!rows.length && <p class="muted small">규칙 없음 — 아래 기본 backend 로만 보냅니다.</p>}
      </div>
      <div class="actions">
        <button
          class="btn sm"
          disabled={!services.length}
          onClick={() =>
            updateIngressManifest(name, (x) => {
              const svc = services[0]!.metadata.name;
              setRules(x, [...flattenRules(x), { host: ts ? "" : `${svc}.example.com`, path: "/", pathType: "Prefix", service: svc, port: portOf(svc) }]);
            })
          }
        >
          <Icon name="plus" size={14} />
          규칙 더하기
        </button>
      </div>
      <Field label="기본 backend (defaultBackend)" hint="어느 규칙에도 맞지 않는 요청이 가는 곳. 없으면 nginx 는 404">
        <select
          class="input"
          value={m.spec.defaultBackend?.service.name ?? ""}
          onChange={(e) =>
            updateIngressManifest(name, (x) => {
              const v = e.currentTarget.value;
              if (v) x.spec.defaultBackend = { service: { name: v, port: { number: portOf(v) } } };
              else delete x.spec.defaultBackend;
            })
          }
        >
          <option value="" disabled={!rows.length} title={!rows.length ? "규칙이 없으면 기본 backend 가 있어야 합니다" : undefined}>
            없음
          </option>
          {svcOptions(m.spec.defaultBackend?.service.name ?? "")}
        </select>
      </Field>
      <div class="actions">
        <button
          class="btn danger"
          onClick={() => {
            removeManifest("Ingress", name);
            selection.value = null;
          }}
        >
          <Icon name="trash" size={14} />
          Ingress 지우기
        </button>
      </div>
    </>
  );
}

// ---------- 설정: ConfigMap·Secret (5b) ----------

/** ConfigMap·Secret 개요: 값, 쓰는 곳(env/파일/subPath — 바뀔 때 반영되는 방식이 다름), 쓰는 Deployment 재시작 */
function ConfigOverview({ obj }: { obj: ConfigMap | Secret }) {
  const reveal = useSignal(false);
  const c = sim.cluster;
  const secretKind = obj.kind === "Secret";
  const users = configUsers(c.api.list("Pod", "default").filter((p) => p.metadata.deletionTimestamp === undefined), obj.kind, obj.metadata.name);
  const deployments = [...new Set(users.map((u) => u.pod.metadata.labels.app).filter((x): x is string => !!x && !!c.api.get("Deployment", x, "default")))];
  const entries = Object.entries(obj.data);
  return (
    <>
      <div class="callout">
        <div class="small">
          바꿔도 돌고 있는 Pod 에 바로 반영되지 않습니다. <b>env</b> 로 읽는 컨테이너는 시작할 때 한 번 읽어 재시작해야 새 값이 되고, <b>파일</b>로 마운트한 것은 kubelet 이 잠시 뒤(축소판 1분) 파일을 바꿉니다 — 앱이 다시 읽어야 반영됩니다. <b>subPath</b> 파일은 영영 그대로입니다.
        </div>
      </div>
      <h3>{secretKind ? "data (base64 로 저장 — 암호화 아님)" : "data"}</h3>
      <ul class="list kv-list">
        {entries.map(([k, v]) => (
          <li key={k}>
            <span class="mono small">{k}</span>
            <span class="mono small kv-val">{secretKind ? (reveal.value ? `${b64decode(v) ?? "(base64 아님)"}  ← ${v}` : "••••••") : v}</span>
          </li>
        ))}
        {!entries.length && <li class="muted small">키 없음</li>}
      </ul>
      {secretKind && entries.length > 0 && (
        <div class="actions">
          <button class="btn sm" onClick={() => (reveal.value = !reveal.value)} title="base64 를 풀어 보여 줍니다 — get secret -o yaml 을 볼 수 있는 사람은 누구나 할 수 있습니다">
            {reveal.value ? "값 가리기" : "값 보기 (base64 풀기)"}
          </button>
        </div>
      )}
      <h3>쓰는 곳 ({users.length})</h3>
      <ul class="list config-users">
        {users.map(({ pod, use }) => (
          <li key={pod.metadata.uid}>
            <Link kind="Pod" name={pod.metadata.name} />
            <span class="small">
              {[...use.env.map((x) => `env ${x}`), ...use.volume.map((x) => `파일 ${x}`), ...use.subPath.map((x) => `subPath ${x}`)].join(" · ")}
            </span>
          </li>
        ))}
        {!users.length && <li class="muted small">이 {obj.kind} 를 쓰는 Pod 가 없습니다</li>}
      </ul>
      {deployments.length > 0 && (
        <div class="actions">
          {deployments.map((d) => (
            <button key={d} class="btn sm" onClick={() => runAndShow(`kubectl rollout restart deployment/${d}`)} title="새 Pod 가 지금의 값으로 env 를 만듭니다">
              {d} 재시작 (rollout restart)
            </button>
          ))}
        </div>
      )}
      <h3>이벤트</h3>
      <Events uid={obj.metadata.uid} />
    </>
  );
}

/** ConfigMap(data)·Secret(stringData — 평문으로 쓰면 API 서버가 base64 로) 의 키·값 편집 */
function ConfigSettings({ kind, name }: { kind: "ConfigMap" | "Secret"; name: string }) {
  const m = findManifest(kind, name);
  if (!m) return <p class="note">이 {kind} 는 매니페스트에 없습니다 (kubectl 로 만듦). kubectl patch 로 바꾸세요.</p>;
  const data = m.kind === "ConfigMap" ? m.data : (m.stringData ?? {});
  const keyErr = (v: string) => (/^[-._a-zA-Z0-9]+$/.test(v) ? undefined : "키는 영문·숫자·-·_·. 만 (실제 API 검사)");
  return (
    <>
      <p class="note">
        여기서 바꾸면 매니페스트를 고쳐 kubectl apply 한 것과 같습니다. {kind === "Secret" ? "Secret 은 stringData(평문)로 적고, 저장은 base64 data 로 됩니다. " : ""}돌고 있는 Pod 의 env 는 바뀌지 않습니다 (개요 탭 참고).
      </p>
      <div class="kv-edit">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} class="kv-row" data-key={k}>
            <span class="mono small kv-key">{k}</span>
            <TextInput value={v} onCommit={(nv) => updateConfigManifest(kind, name, (d) => (d[k] = nv))} />
            <button class="icon-btn sm" title={`${k} 지우기`} aria-label={`${k} 지우기`} onClick={() => updateConfigManifest(kind, name, (d) => delete d[k])}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
      <NewKey onAdd={(k, v) => updateConfigManifest(kind, name, (d) => (d[k] = v))} exists={(k) => k in data} keyErr={keyErr} />
      <div class="actions">
        <button
          class="btn danger"
          onClick={() => {
            removeManifest(kind, name);
            selection.value = null;
          }}
        >
          <Icon name="trash" size={14} />
          {kind} 지우기
        </button>
      </div>
    </>
  );
}

function NewKey({ onAdd, exists, keyErr }: { onAdd: (k: string, v: string) => void; exists: (k: string) => boolean; keyErr: (k: string) => string | undefined }) {
  const key = useSignal("");
  const val = useSignal("");
  const err = key.value ? keyErr(key.value) ?? (exists(key.value) ? "이미 있는 키" : undefined) : undefined;
  const add = () => {
    if (!key.value || err) return;
    onAdd(key.value, val.value);
    key.value = "";
    val.value = "";
  };
  return (
    <div class="kv-row kv-new">
      <input class={`input mono${err ? " invalid" : ""}`} placeholder="새 키" value={key.value} onInput={(e) => (key.value = e.currentTarget.value.trim())} onKeyDown={(e) => e.key === "Enter" && add()} />
      <input class="input mono" placeholder="값" value={val.value} onInput={(e) => (val.value = e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
      <button class="icon-btn sm" disabled={!key.value || !!err} title={err ?? "키 더하기"} aria-label="키 더하기" onClick={add}>
        <Icon name="plus" size={14} />
      </button>
      {err && <span class="field-err kv-err">{err}</span>}
    </div>
  );
}

/** Pod 의 설정 출처와, 컨테이너가 지금 가진 env (시작할 때 만든 것) */
function PodConfig({ p }: { p: Pod }) {
  const ct = p.spec.containers[0];
  if (!ct || (!ct.env?.length && !ct.envFrom?.length && !ct.volumeMounts?.length)) return null;
  const view = sim.cluster.containerConfig(p);
  const sources = [
    ...(ct.envFrom ?? []).map((f) => (f.configMapRef ? { kind: "ConfigMap", name: f.configMapRef.name, how: "env (모든 키)" } : { kind: "Secret", name: f.secretRef!.name, how: "env (모든 키)" })),
    ...(ct.env ?? []).flatMap((e) => {
      const ref = e.valueFrom?.configMapKeyRef ?? e.valueFrom?.secretKeyRef;
      return ref ? [{ kind: e.valueFrom?.configMapKeyRef ? "ConfigMap" : "Secret", name: ref.name, how: `env ${e.name} ← ${ref.key}` }] : [];
    }),
    ...(ct.volumeMounts ?? []).flatMap((m) => {
      const v = p.spec.volumes?.find((x) => x.name === m.name);
      if (!v?.configMap && !v?.secret) return [];
      return [{ kind: v.configMap ? "ConfigMap" : "Secret", name: v.configMap?.name ?? v.secret!.secretName, how: m.subPath ? `subPath ${m.mountPath}` : `파일 ${m.mountPath}/` }];
    }),
  ];
  return (
    <>
      <h3>설정</h3>
      <ul class="list config-users">
        {sources.map((s, i) => (
          <li key={i}>
            <Link kind={s.kind} name={s.name} />
            <span class="small">{s.how}</span>
          </li>
        ))}
      </ul>
      {view && view.env.length > 0 && (
        <>
          <div class="muted small">컨테이너의 env — 시작할 때 만든 값 (kubectl exec -- env)</div>
          <pre class="term small-term">{view.env.map(([k, v]) => `${k}=${maskIfSecret(p, k, v)}`).join("\n")}</pre>
        </>
      )}
    </>
  );
}

/** Secret 에서 온 env 는 화면에서 가린다 (실제로는 exec 로 다 보이지만, 화면에 늘 띄워 두지는 않는다) */
function maskIfSecret(p: Pod, key: string, v: string): string {
  const ct = p.spec.containers[0]!;
  const fromSecret = ct.env?.some((e) => e.name === key && e.valueFrom?.secretKeyRef) || (ct.envFrom ?? []).some((f) => f.secretRef && sim.cluster.api.get("Secret", f.secretRef.name, "default")?.data[key] !== undefined);
  return fromSecret ? "•••••• (Secret)" : v;
}

// ---------- GitOps (6단계) ----------

function ApplicationOverview({ app }: { app: Application }) {
  const c = sim.cluster;
  const name = app.metadata.name;
  const auto = app.spec.syncPolicy?.automated;
  const seen = c.argocd.fetchedRevision(name);
  const head = c.git.get(app.spec.source.repoURL)?.head?.sha;
  const diffs = c.argocd.diffs(name);
  const setPolicy = (args: string) => runAndShow(`argocd app set ${name} ${args}`);
  return (
    <>
      {head && seen && head !== seen && (
        <div class="callout warn">
          <div class="callout-title">Git 에 새 커밋이 있지만 Argo CD 는 아직 모릅니다</div>
          <div class="small">
            Argo CD 는 Git 을 3분마다 확인합니다 (보는 것 {seen.slice(0, 7)} · Git {head.slice(0, 7)}). Refresh 하거나 기다리세요 — 실제로는 GitHub webhook 을 달면 바로 압니다.
          </div>
          <button class="btn sm" onClick={() => runAndShow(`argocd app get ${name} --refresh`)}>
            Refresh
          </button>
        </div>
      )}
      <Rows
        rows={[
          ["Git", <span class="mono small">{app.spec.source.repoURL.replace(/^https:\/\//, "")} · {app.spec.source.targetRevision} · {app.spec.source.path}/</span>],
          ["보는 리비전", <span class="mono">{seen?.slice(0, 7) ?? "—"}</span>],
          ["마지막 sync", <span class="mono">{app.status.operationState?.syncResult?.revision.slice(0, 7) ?? "아직 없음"}</span>],
        ]}
      />
      <h3>Sync Policy</h3>
      <div class="policy">
        <label class="check">
          <input type="checkbox" checked={!!auto} onChange={(e) => setPolicy(e.currentTarget.checked ? "--sync-policy automated" : "--sync-policy none")} />
          자동 sync — 새 커밋을 보면 스스로 sync
        </label>
        <label class={`check${auto ? "" : " off"}`}>
          <input type="checkbox" disabled={!auto} checked={!!auto?.prune} onChange={(e) => setPolicy(`--auto-prune=${e.currentTarget.checked}`)} />
          prune — Git 에서 지운 리소스도 지움
        </label>
        <label class={`check${auto ? "" : " off"}`}>
          <input type="checkbox" disabled={!auto} checked={!!auto?.selfHeal} onChange={(e) => setPolicy(`--self-heal=${e.currentTarget.checked}`)} />
          selfHeal — kubectl 로 바꾼 것을 5초 뒤 되돌림
        </label>
      </div>
      <div class="actions">
        <button class="btn sm" onClick={() => runAndShow(`argocd app get ${name} --refresh`)}>
          Refresh
        </button>
        <button class="btn sm" onClick={() => runAndShow(`argocd app sync ${name}`)}>
          Sync
        </button>
        <button class="btn sm" onClick={() => runAndShow(`argocd app sync ${name} --prune`)}>
          Sync (prune)
        </button>
        <button class="btn sm ghost" onClick={() => runAndShow(`argocd app diff ${name}`)}>
          diff
        </button>
        <button class="btn sm ghost" onClick={() => runAndShow(`argocd app history ${name}`)}>
          history
        </button>
      </div>
      <h3>리소스</h3>
      <ul class="ep-list">
        {app.status.resources.map((r) => (
          <li key={`${r.kind}/${r.name}`}>
            <span class={`dot ${r.status === "Synced" ? "ok" : "wait"}`} />
            <span class="ep-main">
              <Link kind={r.kind} name={r.name} />
              <span class="small muted">
                {r.kind} · {r.health ?? "—"}
                {r.requiresPruning ? " · Git 에 없음 (prune 대상)" : ""}
              </span>
            </span>
            <span class={r.status === "Synced" ? "muted small" : "warn-text"}>{r.status}</span>
          </li>
        ))}
      </ul>
      {diffs.length > 0 && (
        <>
          <h3>Git 과 다른 곳</h3>
          <ul class="list">
            {diffs.map((d) => (
              <li key={`${d.kind}/${d.name}`}>
                <span class="small">
                  {d.kind} {d.name}: {d.lines.join(", ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>이벤트</h3>
      <Events uid={app.metadata.uid} />
    </>
  );
}

/** Git 저장소: 커밋 기록과 작업 사본 편집 (replicas·image·파일 지우기) → 커밋 & push */
function GitPanel({ url }: { url: string }) {
  simVersion.value;
  const repo = sim.cluster.git.get(url);
  const draft = useSignal<Record<string, Manifest> | null>(null);
  const message = useSignal("");
  const head = repo?.head;
  useEffect(() => {
    draft.value = null;
  }, [head?.sha]);
  if (!repo || !head) return <aside class="inspector"><div class="insp-body"><p class="note">Git 저장소가 없습니다.</p></div></aside>;
  const files = draft.value ?? head.files;
  const edit = (f: (x: Record<string, Manifest>) => void) => {
    const next = structuredClone(files);
    f(next);
    draft.value = next;
  };
  const changed = draft.value !== null && JSON.stringify(draft.value) !== JSON.stringify(head.files);
  return (
    <aside class="inspector">
      <div class="insp-head">
        <div class="insp-kind">Git 저장소</div>
        <div class="insp-name mono">{url.replace(/^https:\/\//, "")}</div>
        <button class="icon-btn sm insp-close" onClick={() => (selection.value = null)} aria-label="선택 해제">
          <Icon name="close" size={15} />
        </button>
      </div>
      <div class="insp-body">
        <p class="note">여기서 고치고 커밋하면 git push 한 것과 같습니다. Argo CD 는 다음 폴링(3분)이나 Refresh 때 알게 됩니다.</p>
        <h3>파일 (main · {head.sha.slice(0, 7)})</h3>
        {Object.entries(head.files).map(([path]) => {
          const m = files[path];
          return (
            <div key={path} class={`git-file${m ? "" : " removed"}`}>
              <div class="git-file-head">
                <span class="mono small">{path}</span>
                <span class="muted small">{head.files[path]!.kind}</span>
                <button class="btn sm ghost" onClick={() => edit((x) => (m ? delete x[path] : (x[path] = structuredClone(head.files[path]!))))}>
                  {m ? "지우기" : "되살리기"}
                </button>
              </div>
              {m?.kind === "Deployment" && (
                <>
                  <Field label="replicas">
                    <div class="stepper">
                      <button class="btn sm" onClick={() => edit((x) => ((x[path] as DeploymentManifest).spec.replicas = Math.max(0, m.spec.replicas - 1)))}>
                        −
                      </button>
                      <span class="mono stepper-num">{m.spec.replicas}</span>
                      <button class="btn sm" onClick={() => edit((x) => ((x[path] as DeploymentManifest).spec.replicas = Math.min(30, m.spec.replicas + 1)))}>
                        +
                      </button>
                    </div>
                  </Field>
                  <Field label="image">
                    <TextInput value={m.spec.template.spec.containers[0]!.image} onCommit={(v) => edit((x) => ((x[path] as DeploymentManifest).spec.template.spec.containers[0]!.image = v))} />
                  </Field>
                </>
              )}
            </div>
          );
        })}
        <Field label="커밋 메시지">
          <input class="input" value={message.value} placeholder={changed ? "예: scale net-sim to 2" : "바꾼 것이 없습니다"} onInput={(e) => (message.value = e.currentTarget.value)} />
        </Field>
        <div class="actions">
          <button
            class="btn"
            disabled={!changed}
            onClick={() => {
              sim.gitCommit(url, draft.value!, message.value.trim() || "update manifests");
              message.value = "";
            }}
          >
            커밋 &amp; push
          </button>
          {changed && (
            <button class="btn ghost" onClick={() => (draft.value = null)}>
              되돌리기
            </button>
          )}
        </div>
        <h3>커밋 기록</h3>
        <pre class="term">{repo.log()}</pre>
      </div>
    </aside>
  );
}
