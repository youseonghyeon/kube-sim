// 아래 서랍: 이벤트 로그(트레이스) 와 kubectl 창.
import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { TraceEvent } from "../core/trace";
import { fmtClock } from "../core/units";
import { kubectlHistory, sim, simVersion } from "../model/sim";
import { drawerOpen, drawerTab, logOnlySelected, selection, showApi } from "../model/store";
import { Icon } from "./Icons";

/** 로그 창에 그리는 줄 수 상한 */
const LOG_ROWS = 400;

export function Drawer() {
  const open = drawerOpen.value;
  const tab = drawerTab.value;
  return (
    <section class={`drawer${open ? " open" : ""}`}>
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

const QUICK = ["get pods -o wide", "get deploy", "get rs", "get nodes", "get events", "help"];

function KubectlView() {
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
    sim.kubectl(line.startsWith("kubectl") || line.startsWith("k ") ? line : `kubectl ${line}`);
    input.value = "";
    histIdx.current = -1;
  };
  return (
    <div class="kubectl">
      <div class="term-out" ref={box}>
        {history.map((h) => (
          <div key={h.id} class="term-entry">
            <div class="term-cmd mono">
              <span class="term-time">{fmtClock(h.t)}</span>$ {h.command}
            </div>
            <pre class={`term-res${h.result.ok ? "" : " err"}`}>{h.result.output}</pre>
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
        <span class="mono prompt">$ kubectl</span>
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
