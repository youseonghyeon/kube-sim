// 캔버스: 위에 컨트롤 플레인, 가운데 "스케줄 대기", 아래에 노드 상자들과 그 안의 Pod 칩.
// 자리 배치는 자동이다 (끌어 놓지 않는다) — 무엇이 어디에 있는지는 스케줄러가 정하는 것이 학습 포인트라서.
import { useMemo } from "preact/hooks";
import { fmtCpu, fmtMem } from "../core/units";
import { running, sim, simTime, simVersion, speed } from "../model/sim";
import { selection } from "../model/store";
import { buildView, CONTROL_PLANE, lastByActor, recentFlashes, refKey, type ClusterView, type NodeView, type PodView } from "../model/view";

/** 이름표가 떠 있는 시간 (실제 시간 ms — 재생 속도를 곱해 시뮬레이션 시간으로) */
const FLASH_REAL_MS = 1800;

export function Canvas() {
  const version = simVersion.value;
  const now = simTime.value;
  const c = sim.cluster;
  const view = useMemo(() => buildView(c), [version, c]);
  const windowMs = FLASH_REAL_MS * Math.max(1, speed.value);
  const flashes = useMemo(() => recentFlashes(c.trace.events, now, windowMs), [version, now, windowMs, c]);
  const sel = selection.value;
  const focus = focusOf(view, sel);

  return (
    <main class="canvas" onClick={() => (selection.value = null)}>
      <ControlPlane now={now} windowMs={windowMs} version={version} />
      <section class={`lane${view.pending.length ? " has" : ""}`} aria-label="스케줄 대기">
        <div class="lane-head">
          <span class="lane-title">스케줄 대기</span>
          <span class="lane-sub">{view.pending.length ? `노드를 못 찾은 Pod ${view.pending.length}개 — 고르면 이유가 보입니다` : "노드가 정해지지 않은 Pod 가 잠깐 머무는 곳"}</span>
        </div>
        <div class="pods">
          {view.pending.map((p) => (
            <PodChip key={p.pod.metadata.uid} p={p} flash={flashes.get(refKey({ kind: "Pod", name: p.name }))} focus={focus} />
          ))}
        </div>
      </section>
      <section class="nodes">
        {view.nodes.map((n) => (
          <NodeCard key={n.name} n={n} flashes={flashes} focus={focus} selected={sel?.kind === "Node" && sel.name === n.name} />
        ))}
        {!view.nodes.length && <div class="empty-note">노드가 없습니다. 왼쪽 '노드' 의 + 로 더하세요.</div>}
      </section>
      {!running.value && <div class="paused-badge">일시정지 — Space 로 재생, → 로 한 단계</div>}
    </main>
  );
}

interface Focus {
  /** 강조할 Pod 이름들 (없으면 강조 없음) */
  pods?: Set<string>;
  pod?: string;
}

function focusOf(view: ClusterView, sel: { kind: string; name: string } | null): Focus {
  if (!sel) return {};
  if (sel.kind === "Pod") return { pod: sel.name };
  if (sel.kind === "Deployment") return { pods: new Set(view.pods.filter((p) => p.owner === sel.name).map((p) => p.name)) };
  if (sel.kind === "ReplicaSet") return { pods: new Set(view.pods.filter((p) => p.rs === sel.name).map((p) => p.name)) };
  return {};
}

function ControlPlane({ now, windowMs }: { now: number; windowMs: number; version: number }) {
  const events = sim.cluster.trace.events;
  return (
    <section class="cp" aria-label="컨트롤 플레인">
      <div class="cp-label">컨트롤 플레인</div>
      <div class="cp-row">
        {CONTROL_PLANE.map((comp) => {
          const last = lastByActor(events, comp.actors, (k) => comp.id !== "kube-apiserver" && k.startsWith("api."));
          const active = !!last && now - last.t <= windowMs;
          return (
            <div key={comp.id} class={`cp-comp${active ? " active" : ""}`} data-comp={comp.id}>
              <div class="cp-name mono">{comp.title}</div>
              <div class="cp-role">{comp.role}</div>
              <div class="cp-last" title={last?.msg}>
                {last ? (
                  <>
                    {comp.id === "controller-manager" && <span class="cp-actor">{last.actor}</span>}
                    {last.msg}
                  </>
                ) : (
                  <span class="muted">아직 한 일 없음</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NodeCard({ n, flashes, focus, selected }: { n: NodeView; flashes: Map<string, string>; focus: Focus; selected: boolean }) {
  const kubelet = lastByActor(sim.cluster.trace.events, [`kubelet@${n.name}`]);
  return (
    <div class={`node${selected ? " sel" : ""}${n.cordoned ? " cordoned" : ""}`} data-node={n.name}>
      <button
        class="node-head"
        onClick={(e) => {
          e.stopPropagation();
          selection.value = { kind: "Node", name: n.name };
        }}
      >
        <span class={`dot ${n.ready ? (n.cordoned ? "wait" : "ok") : "bad"}`} />
        <span class="node-name">{n.name}</span>
        <span class="node-status">{n.status}</span>
        <span class="node-ip mono">{n.ip}</span>
      </button>
      <div class="node-res">
        <ResBar label="cpu" used={n.cpu.used} total={n.cpu.total} fmt={fmtCpu} />
        <ResBar label="memory" used={n.memory.used} total={n.memory.total} fmt={fmtMem} />
      </div>
      <div class="pods">
        {n.pods.map((p) => (
          <PodChip key={p.pod.metadata.uid} p={p} flash={flashes.get(refKey({ kind: "Pod", name: p.name }))} focus={focus} />
        ))}
        {!n.pods.length && <div class="pods-empty">Pod 없음</div>}
      </div>
      <div class="node-foot" title={kubelet?.msg}>
        <span class="mono">kubelet</span>
        <span class="node-foot-msg">{kubelet ? kubelet.msg : "대기 중"}</span>
      </div>
    </div>
  );
}

function ResBar({ label, used, total, fmt }: { label: string; used: number; total: number; fmt: (n: number) => string }) {
  const pct = total ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div class="res" title={`requests 합 ${fmt(used)} / allocatable ${fmt(total)}`}>
      <span class="res-label">{label}</span>
      <span class="res-bar">
        <span class={`res-fill${pct >= 85 ? " hot" : ""}`} style={{ width: `${pct}%` }} />
      </span>
      <span class="res-num mono">
        {fmt(used)} / {fmt(total)}
      </span>
    </div>
  );
}

function PodChip({ p, flash, focus }: { p: PodView; flash?: string; focus: Focus }) {
  const sel = focus.pod === p.name;
  const dim = (focus.pods && !focus.pods.has(p.name)) || (focus.pod !== undefined && !sel);
  const hl = focus.pods?.has(p.name);
  return (
    <button
      class={`pod t-${p.tone}${sel ? " sel" : ""}${dim ? " dim" : ""}${hl ? " hl" : ""}`}
      data-pod={p.name}
      style={{ "--own": `var(--own-${p.colorIndex})` }}
      onClick={(e) => {
        e.stopPropagation();
        selection.value = { kind: "Pod", namespace: "default", name: p.name };
      }}
      title={`${p.name} · ${p.status} · ${p.ready} Ready${p.pod.status.podIP ? ` · ${p.pod.status.podIP}` : ""}`}
    >
      <span class="pod-top">
        <span class={`dot ${p.tone}`} />
        <span class="pod-name mono">{p.name}</span>
      </span>
      <span class="pod-bottom">
        <span class="pod-status">{p.status}</span>
        {p.restarts > 0 && (
          <span class="pod-restarts" title={`재시작 ${p.restarts}번`}>
            ↻{p.restarts}
          </span>
        )}
        <span class="pod-ip mono">{p.pod.status.podIP ?? ""}</span>
      </span>
      {flash && <span class="pod-flash">{flash}</span>}
    </button>
  );
}
