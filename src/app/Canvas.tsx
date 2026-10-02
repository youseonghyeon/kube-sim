// 캔버스: 위에 컨트롤 플레인, 가운데 "스케줄 대기", 아래에 노드 상자들과 그 안의 Pod 칩.
// 자리 배치는 자동이다 (끌어 놓지 않는다) — 무엇이 어디에 있는지는 스케줄러가 정하는 것이 학습 포인트라서.
import { computed } from "@preact/signals";
import { useMemo, useRef } from "preact/hooks";
import { Overlay } from "./Overlay";
import { fmtCpu, fmtMem } from "../core/units";
import { Icon } from "./Icons";
import { currentView, running, sim, simTime, simVersion, speed } from "../model/sim";
import { selection } from "../model/store";
import { CONTROL_PLANE, lastByActor, nodeStory, recentFlashes, refKey, type ClusterView, type IngressView, type NodeView, type PodView, type ServiceView } from "../model/view";

const canvasTick = computed(() => Math.floor(simTime.value / (100 * Math.max(1, speed.value))));

/** 이름표가 떠 있는 시간 (실제 시간 ms — 재생 속도를 곱해 시뮬레이션 시간으로) */
const FLASH_REAL_MS = 1800;

export function Canvas() {
  const version = simVersion.value;
  // 이름표·카운트다운만 시간에 따라 바뀌므로 매 프레임이 아니라 실제 시간 약 0.1초마다 다시 그린다 (Pod 60개에서 긴 프레임 방지)
  canvasTick.value;
  const now = simTime.peek();
  const c = sim.cluster;
  const view = currentView();
  const windowMs = FLASH_REAL_MS * Math.max(1, speed.value);
  const flashes = useMemo(() => recentFlashes(c.trace.events, now, windowMs), [version, now, windowMs, c]);
  const sel = selection.value;
  const focus = focusOf(view, sel);

  const main = useRef<HTMLElement>(null);
  return (
    <main class="canvas" ref={main} onClick={() => (selection.value = null)}>
      <ControlPlane now={now} windowMs={windowMs} version={version} />
      <TrafficBar />
      {(view.apps.length > 0 || view.gits.length > 0) && <GitOpsLane view={view} now={now} sel={sel} />}
      {(view.ingresses.length > 0 || view.services.some((s) => s.svc.spec.type !== "ClusterIP")) && (
        <section class="svcs" aria-label="바깥에서 들어오는 길">
          <div class="lane-head">
            <span class="lane-title">바깥</span>
            <span class="lane-sub">클러스터 밖에서 들어오는 길 — kubectl 창에 curl http://… 를 치면 여기서 출발합니다</span>
          </div>
          <div class="svc-row">
            <div class="outside" data-outside="internet">
              <span class="svc-name">인터넷 클라이언트</span>
              <span class="svc-addr mono">203.0.113.7</span>
            </div>
            {view.ingresses.map((i) => (
              <IngressBox key={i.name} i={i} selected={sel?.kind === "Ingress" && sel.name === i.name} />
            ))}
          </div>
        </section>
      )}
      {view.services.length > 0 && (
        <section class="svcs" aria-label="Service">
          <div class="lane-head">
            <span class="lane-title">Service</span>
            <span class="lane-sub">어느 노드에도 붙어 있지 않은 가상 주소 — 각 노드의 kube-proxy 가 써 둔 iptables 규칙이 Pod IP 로 바꿉니다</span>
          </div>
          <div class="svc-row">
            {view.services.map((s) => (
              <ServiceBox key={s.name} s={s} selected={sel?.kind === "Service" && sel.name === s.name} />
            ))}
          </div>
        </section>
      )}
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
          <NodeCard key={n.name} n={n} now={now} flashes={flashes} focus={focus} selected={sel?.kind === "Node" && sel.name === n.name} />
        ))}
        {!view.nodes.length && <div class="empty-note">노드가 없습니다. 왼쪽 '노드' 의 + 로 더하세요.</div>}
      </section>
      {!running.value && <div class="paused-badge">일시정지 — Space 로 재생, → 로 한 단계</div>}
      <Overlay root={main} view={view} version={version} />
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
  if (sel.kind === "Application") {
    const deps = new Set(view.deployments.filter((d) => d.d.metadata.labels["app.kubernetes.io/instance"] === sel.name).map((d) => d.name));
    return { pods: new Set(view.pods.filter((p) => p.owner && deps.has(p.owner)).map((p) => p.name)) };
  }
  if (sel.kind === "Service") {
    const s = view.services.find((x) => x.name === sel.name);
    if (s) return { pods: new Set([...s.ready, ...s.notReady]) };
  }
  return {};
}

/** GitOps: Git 저장소 → Argo CD Application (→ 아래의 클러스터 리소스) */
function GitOpsLane({ view, now, sel }: { view: ClusterView; now: number; sel: { kind: string; name: string } | null }) {
  const left = Math.max(0, sim.cluster.argocd.nextPollAt - now);
  return (
    <section class="svcs" aria-label="GitOps">
      <div class="lane-head">
        <span class="lane-title">GitOps</span>
        <span class="lane-sub">Git 이 원하는 상태 — Argo CD 가 라이브와 비교해 맞춘다 · 다음 Git 확인까지 {Math.ceil(left / 1000)}초 (3분 폴링)</span>
      </div>
      <div class="svc-row">
        {view.gits.map((g) => (
          <button
            key={g.url}
            class={`git-box${sel?.kind === "GitRepo" && sel.name === g.url ? " sel" : ""}`}
            data-git={g.url}
            onClick={(e) => {
              e.stopPropagation();
              selection.value = { kind: "GitRepo", name: g.url };
            }}
          >
            <span class="svc-top">
              <span class="svc-name">{g.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}</span>
              <span class="svc-type">Git · main · 커밋 {g.commits}</span>
            </span>
            {g.head && (
              <span class="svc-addr mono">
                {g.head.sha.slice(0, 7)} {g.head.message}
              </span>
            )}
          </button>
        ))}
        {view.apps.map((a) => {
          const behind = a.head && a.seen && a.head !== a.seen;
          const s = a.app.status;
          return (
            <button
              key={a.name}
              class={`app-box${sel?.kind === "Application" && sel.name === a.name ? " sel" : ""}`}
              data-app={a.name}
              onClick={(e) => {
                e.stopPropagation();
                selection.value = { kind: "Application", namespace: "argocd", name: a.name };
              }}
            >
              <span class="svc-top">
                <span class="svc-name">{a.name}</span>
                <span class="svc-type">Argo CD Application</span>
              </span>
              <span class="app-badges">
                <span class={`badge t-${s.sync.status === "Synced" ? "ok" : "wait"}`}>{s.sync.status}</span>
                <span class={`badge t-${s.health.status === "Healthy" ? "ok" : s.health.status === "Progressing" ? "wait" : "bad"}`}>{s.health.status}</span>
              </span>
              <span class="svc-addr mono">
                보는 리비전 {a.seen?.slice(0, 7) ?? "—"}
                {behind ? ` · Git 은 ${a.head!.slice(0, 7)} (아직 모름)` : ""}
              </span>
              <span class="ingress-route">{a.app.spec.syncPolicy?.automated ? `자동 sync${a.app.spec.syncPolicy.automated.prune ? " · prune" : ""}${a.app.spec.syncPolicy.automated.selfHeal ? " · selfHeal" : ""}` : "수동 sync"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 부하 발생기의 최근 결과: 칸 하나가 요청 하나 (초록 성공 · 빨강 실패) */
function TrafficBar() {
  const t = sim.cluster.traffic;
  if (!t) return null;
  const recent = t.samples.slice(-120);
  const lastFail = [...t.samples].reverse().find((s) => !s.ok);
  return (
    <section class={`traffic${t.stopped ? " stopped" : ""}`} aria-label="부하" onClick={(e) => e.stopPropagation()}>
      <div class="traffic-head">
        <span class="lane-title">부하</span>
        <span class="mono small">
          {t.from} → {t.target} · {t.intervalMs}ms 마다
        </span>
        <span class="traffic-count ok">성공 {t.ok}</span>
        <span class={`traffic-count${t.fail ? " bad" : ""}`}>실패 {t.fail}</span>
        <span class="traffic-actions">
          <button class="btn sm ghost" onClick={() => sim.resetTraffic()}>
            0 으로
          </button>
          <button class="btn sm" onClick={() => sim.stopTraffic()}>
            {t.stopped ? "닫기" : "멈추기"}
          </button>
        </span>
      </div>
      <div class="traffic-strip" title="최근 요청 (왼쪽이 오래된 것)">
        {recent.map((s, i) => (
          <span key={i} class={`tick${s.ok ? "" : " fail"}`} title={s.ok ? `${s.servedBy} 응답` : s.reason} />
        ))}
      </div>
      {lastFail && <div class="traffic-last small">마지막 실패: {lastFail.reason}</div>}
    </section>
  );
}

function IngressBox({ i, selected }: { i: IngressView; selected: boolean }) {
  return (
    <button
      class={`ingress${selected ? " sel" : ""}`}
      data-ingress={i.name}
      onClick={(e) => {
        e.stopPropagation();
        selection.value = { kind: "Ingress", namespace: "default", name: i.name };
      }}
    >
      <span class="svc-top">
        <span class="svc-name">{i.name}</span>
        <span class="svc-type">Ingress · {i.ing.spec.ingressClassName ?? "class 없음"}</span>
      </span>
      <span class="svc-addr mono">{i.address ?? "ADDRESS 없음 (컨트롤러가 아직)"}</span>
      {i.routes.slice(0, 4).map((r) => (
        <span key={r} class="ingress-route mono">
          {r}
        </span>
      ))}
    </button>
  );
}

function ServiceBox({ s, selected }: { s: ServiceView; selected: boolean }) {
  const p = s.svc.spec.ports[0];
  const total = s.ready.length + s.notReady.length;
  return (
    <button
      class={`svc${selected ? " sel" : ""}${s.ready.length ? "" : " empty"}`}
      data-service={s.name}
      onClick={(e) => {
        e.stopPropagation();
        selection.value = { kind: "Service", namespace: "default", name: s.name };
      }}
    >
      <span class="svc-top">
        <span class="svc-name">{s.name}</span>
        <span class="svc-type">{s.svc.spec.type}</span>
      </span>
      <span class="svc-addr mono">
        {s.svc.spec.clusterIP}:{p?.port} → :{p?.targetPort}
        {p?.nodePort ? ` · NodePort ${p.nodePort}` : ""}
      </span>
      {s.lbIP && (
        <span class="svc-lb mono">
          LB {s.lbIP} · {s.announcer ? `${s.announcer} 가 맡음` : "맡은 노드 없음"} · {s.svc.spec.externalTrafficPolicy}
        </span>
      )}
      {s.svc.spec.type === "LoadBalancer" && !s.lbIP && <span class="svc-lb mono">LB &lt;pending&gt;</span>}
      <span class={`svc-eps${s.ready.length ? "" : " none"}`}>{total ? `엔드포인트 ready ${s.ready.length}${s.notReady.length ? ` · not ready ${s.notReady.length}` : ""}` : "엔드포인트 없음 (셀렉터에 맞는 Pod 없음)"}</span>
    </button>
  );
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

function NodeCard({ n, now, flashes, focus, selected }: { n: NodeView; now: number; flashes: Map<string, string>; focus: Focus; selected: boolean }) {
  const kubelet = lastByActor(sim.cluster.trace.events, [`kubelet@${n.name}`], (k) => k.startsWith("api."));
  const story = nodeStory(n, now);
  return (
    <div class={`node${selected ? " sel" : ""}${n.cordoned ? " cordoned" : ""}${n.powered ? "" : " off"}${n.ready ? "" : " notready"}`} data-node={n.name}>
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
        <span
          role="button"
          tabIndex={0}
          class={`node-power${n.powered ? "" : " is-off"}`}
          title={n.powered ? "노드 끄기 — kubelet 이 멈추고 heartbeat 가 끊깁니다" : "노드 다시 켜기"}
          aria-label={n.powered ? `${n.name} 끄기` : `${n.name} 켜기`}
          onClick={(e) => {
            e.stopPropagation();
            sim.setNodePower(n.name, !n.powered);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              sim.setNodePower(n.name, !n.powered);
            }
          }}
        >
          <Icon name="power" size={14} />
        </span>
      </button>
      {story && <div class={`node-story t-${story.tone}`}>{story.text}</div>}
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
        <span class="node-foot-msg">{!n.powered ? "응답 없음 (꺼짐)" : kubelet ? kubelet.msg : "대기 중"}</span>
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
        {p.revision !== undefined && (
          <span class={`pod-rev${p.isNew ? " new" : ""}`} title={p.isNew ? "새 템플릿의 Pod (롤아웃 중)" : "옛 템플릿의 Pod (롤아웃 중)"}>
            r{p.revision}
          </span>
        )}
      </span>
      <span class="pod-bottom">
        <span class="pod-status">{p.status}</span>
        {p.sick && <span class="pod-sick" title="앱 고장 (사용자가 만든 상태) — /ready 와 요청이 503">고장</span>}
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
