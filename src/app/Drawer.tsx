// 아래 서랍: 이벤트 로그(트레이스) 와 kubectl 창.
import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { NetStep } from "../core/net/request";
import type { TraceEvent } from "../core/trace";
import { fmtClock } from "../core/units";
import { commandKind } from "../model/commands";
import { kubectlHistory, sim, simVersion } from "../model/sim";
import { DRAWER_MIN, drawerHeight, drawerOpen, drawerTab, logOnlySelected, selection, setDrawerHeight, showApi, toggleDrawerMax } from "../model/store";
import { Icon } from "./Icons";

/** 로그 창에 그리는 줄 수 상한 */
const LOG_ROWS = 400;

export function Drawer() {
  const open = drawerOpen.value;
  const tab = drawerTab.value;
  // 위쪽 가장자리를 끌어 높이 조절 (두 번 누르면 기본 ↔ 끝까지), 최소보다 한참 아래로 끌면 접는다 — net-sim 의 로그와 같은 방식
  const resizing = useRef<{ y: number; h: number } | null>(null);
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizing.current = { y: e.clientY, h: drawerHeight.peek() };
    document.body.classList.add("resizing-row");
  };
  const onMove = (e: PointerEvent) => {
    const r = resizing.current;
    if (!r) return;
    const h = r.h + (r.y - e.clientY);
    if (h < DRAWER_MIN - 70) {
      onUp(e);
      setDrawerHeight(r.h); // 다시 펴면 끌기 전 높이로
      drawerOpen.value = false;
      return;
    }
    setDrawerHeight(h);
  };
  const onUp = (e: PointerEvent) => {
    if (!resizing.current) return;
    resizing.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.classList.remove("resizing-row");
  };
  return (
    <section class={`drawer${open ? " open" : ""}`} style={{ "--drawer-h": `${drawerHeight.value}px` }}>
      {open && (
        <div
          class="drawer-resize"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onDblClick={toggleDrawerMax}
          title="끌어서 높이 조절 · 두 번 눌러 기본/끝까지 · 아래 끝까지 끌면 접힘"
        />
      )}
      <div class="drawer-head">
        <div class="tabs inline" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "log"}
            class={tab === "log" ? "on" : ""}
            onClick={() => {
              drawerTab.value = "log";
              drawerOpen.value = true;
            }}
          >
            <Icon name="list" size={14} />
            로그
          </button>
          <button
            role="tab"
            aria-selected={tab === "kubectl"}
            class={tab === "kubectl" ? "on" : ""}
            onClick={() => {
              drawerTab.value = "kubectl";
              drawerOpen.value = true;
            }}
          >
            <Icon name="terminal" size={14} />
            kubectl
          </button>
        </div>
        {tab === "log" && open && <LogToolbar />}
        <button class="icon-btn sm drawer-toggle" onClick={() => (drawerOpen.value = !open)} title={open ? "접기" : "펴기"} aria-label={open ? "서랍 접기" : "서랍 펴기"}>
          <Icon name="chevron" size={15} class={open ? "" : "flip"} />
        </button>
      </div>
      {open && (tab === "log" ? <LogView /> : <KubectlView />)}
    </section>
  );
}

function LogToolbar() {
  return (
    <div class="drawer-tools">
      <label class="check" title="API 서버가 오브젝트를 저장·변경·삭제한 줄도 봅니다 (모든 컴포넌트는 API 서버를 거쳐 이야기합니다)">
        <input type="checkbox" checked={showApi.value} onChange={(e) => (showApi.value = e.currentTarget.checked)} />
        API 쓰기도 보기
      </label>
      <label class="check" title="고른 오브젝트에 관한 줄만">
        <input type="checkbox" checked={logOnlySelected.value} onChange={(e) => (logOnlySelected.value = e.currentTarget.checked)} />
        고른 것만
      </label>
      <button class="btn ghost sm" onClick={() => sim.clearLog()}>
        비우기
      </button>
    </div>
  );
}

function matchesSelection(e: TraceEvent, sel: { kind: string; name: string } | null): boolean {
  if (!sel) return true;
  if (e.ref && e.ref.kind === sel.kind && e.ref.name === sel.name) return true;
  return e.msg.includes(sel.name);
}

function LogView() {
  simVersion.value;
  const sel = selection.value;
  const api = showApi.value;
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const events = sim.cluster.trace.events;
  const rows: TraceEvent[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < LOG_ROWS; i--) {
    const e = events[i]!;
    if (!api && e.kind.startsWith("api.") && e.kind !== "api.conflict") continue;
    if (logOnlySelected.value && !matchesSelection(e, sel)) continue;
    rows.push(e);
  }
  rows.reverse();
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <div
      class="log"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {rows.map((e) => (
        <div
          key={e.seq}
          class={`log-row k-${e.kind.split(".")[0]}${e.ref ? " has-ref" : ""}${sel && e.ref && e.ref.kind === sel.kind && e.ref.name === sel.name ? " sel" : ""}`}
          onClick={() => {
            if (e.ref) selection.value = { kind: e.ref.kind, namespace: e.ref.namespace, name: e.ref.name };
          }}
        >
          <span class="log-t mono">{fmtClock(e.t)}</span>
          <span class={`log-actor a-${actorGroup(e.actor)}`}>{e.actor}</span>
          <span class="log-msg">{e.msg}</span>
        </div>
      ))}
      {!rows.length && <div class="log-empty">아직 기록이 없습니다.</div>}
    </div>
  );
}

function actorGroup(actor: string): string {
  if (actor === "user") return "user";
  if (actor === "kube-apiserver") return "api";
  if (actor === "kube-scheduler") return "sched";
  if (actor.startsWith("kubelet@")) return "kubelet";
  return "ctrl";
}

const STEP_LABEL: Record<NetStep["kind"], string> = { dns: "DNS", dnat: "DNAT", route: "경로", response: "응답", fail: "실패" };

const QUICK = ["get pods -o wide", "get svc", "get endpoints", "get deploy", "get nodes", "get events", "top pods", "help"];

function KubectlView() {
  simVersion.value; // drain 처럼 시간이 지나며 늘어나는 출력을 다시 그린다
  const input = useSignal("");
  const histIdx = useRef(-1);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const history = kubectlHistory.value;
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [history.length]);
  useEffect(() => field.current?.focus(), []);
  const run = (cmd: string) => {
    const line = cmd.trim();
    if (!line) return;
    // kubectl 명령만 접두사를 붙인다 (curl·argocd·git·echo … | base64 -d 는 그대로)
    sim.kubectl(commandKind(line) !== "kubectl" || /^(kubectl|k)(\s|$)/.test(line) ? line : `kubectl ${line}`);
    input.value = "";
    histIdx.current = -1;
  };
  return (
    <div class="kubectl">
      <div class="term-out" ref={box}>
        {history.map((h) => (
          <div key={h.id} class="term-entry">
            <div class="term-cmd mono">
              <span class="term-time">{fmtClock(h.t)}</span>$ {h.outside ? "(클러스터 밖에서) " : ""}{h.command}
            </div>
            <pre class={`term-res${h.result.ok ? "" : " err"}`}>{h.result.drain ? h.result.drain.lines.join("\n") + (h.result.drain.done ? "" : "\n…") : h.result.output}</pre>
            {h.result.net && h.result.net.steps.length > 0 && (
              <ol class="net-steps">
                {h.result.net.steps.map((s, i) => (
                  <li key={i} class={`net-step k-${s.kind}`}>
                    <span class="net-kind">{STEP_LABEL[s.kind]}</span>
                    <span class="net-actor mono">{s.actor}</span>
                    <span class="net-text">{s.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))}
        {!history.length && <div class="log-empty">kubectl 명령을 입력하세요. 예: get pods -o wide · describe pod &lt;이름&gt; · scale deployment/web --replicas=5</div>}
      </div>
      <div class="term-quick">
        {QUICK.map((q) => (
          <button key={q} class="chip mono" onClick={() => run(q)}>
            {q}
          </button>
        ))}
      </div>
      <form
        class="term-in"
        onSubmit={(e) => {
          e.preventDefault();
          run(input.value);
        }}
      >
        <span class="mono prompt" title="kubectl 명령. curl 로 시작하면 클러스터 밖에서, argocd·git 으로 시작하면 그 CLI">$ kubectl</span>
        <input
          ref={field}
          class="mono"
          value={input.value}
          placeholder="get pods"
          spellcheck={false}
          autocomplete="off"
          aria-label="kubectl 명령"
          onInput={(e) => (input.value = e.currentTarget.value)}
          onKeyDown={(e) => {
            const cmds = kubectlHistory.peek().map((h) => h.command.replace(/^kubectl\s+/, ""));
            if (e.key === "ArrowUp" && cmds.length) {
              e.preventDefault();
              histIdx.current = histIdx.current < 0 ? cmds.length - 1 : Math.max(0, histIdx.current - 1);
              input.value = cmds[histIdx.current]!;
            } else if (e.key === "ArrowDown" && histIdx.current >= 0) {
              e.preventDefault();
              histIdx.current++;
              input.value = histIdx.current < cmds.length ? cmds[histIdx.current]! : "";
              if (histIdx.current >= cmds.length) histIdx.current = -1;
            }
          }}
        />
        <button class="icon-btn sm" type="submit" aria-label="실행">
          <Icon name="send" size={15} />
        </button>
      </form>
    </div>
  );
}
