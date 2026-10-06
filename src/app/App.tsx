import { useSignal } from "@preact/signals";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { fmtClock } from "../core/units";
import { EXAMPLE_GROUPS, EXAMPLES, exampleById } from "../model/examples";
import { running, sim, simNotice, simTime, speed, togglePlay } from "../model/sim";
import { drawerHeight, exampleId, INSPECTOR_RAIL, inspectorOpen, inspectorWidth, loadExample, selection, setDrawerHeight, setInspectorWidth, theme, toggleInspector, toggleTheme } from "../model/store";
import { Canvas } from "./Canvas";
import { Drawer } from "./Drawer";
import { Icon } from "./Icons";
import { Inspector } from "./Inspector";
import { Sidebar } from "./Sidebar";

export function App() {
  const notice = useSignal<string | null>(null);
  const timer = useRef(0);

  useEffect(
    () =>
      simNotice.subscribe((msg) => {
        if (!msg) return;
        notice.value = msg;
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          notice.value = null;
          simNotice.value = null;
        }, 8000);
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘\ (Ctrl+\): 오른쪽 패널 접기·펴기 — 입력칸 안에서도 (net-sim 과 같은 단축키)
      if ((e.metaKey || e.ctrlKey) && e.code === "Backslash") {
        e.preventDefault();
        toggleInspector();
        return;
      }
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "." || e.key === "ArrowRight") {
        if (!running.value) sim.step();
      } else if (e.key === "Escape") selection.value = null;
    };
    // 창이 작아지면 서랍이 상단바를 덮지 않게, 인스펙터가 캔버스를 다 먹지 않게 다시 자른다
    const onResize = () => {
      setDrawerHeight(drawerHeight.peek());
      setInspectorWidth(inspectorWidth.peek());
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const isRunning = running.value;
  return (
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <Icon name="mark" size={18} />
          <span>kube-sim</span>
        </div>
        <div class="topbar-center">
          <div class="transport">
            <button class="icon-btn" onClick={togglePlay} title={isRunning ? "일시정지 (Space)" : "재생 (Space)"} aria-label={isRunning ? "일시정지" : "재생"}>
              <Icon name={isRunning ? "pause" : "play"} size={18} />
            </button>
            <button class="icon-btn" onClick={() => sim.step()} disabled={isRunning} title="다음 이벤트 하나 (→)" aria-label="다음 이벤트">
              <Icon name="step" size={18} />
            </button>
            <select class="speed" value={String(speed.value)} onChange={(e) => (speed.value = Number(e.currentTarget.value))} title="재생 속도 (1× = 실제 시간)">
              {[0.5, 1, 2, 5, 10, 30].map((s) => (
                <option key={s} value={String(s)}>
                  {s}×
                </option>
              ))}
            </select>
            <span class="clock mono" title="시뮬레이션 시각. 할 일(이미지 pull, 백오프 …)이 남아 있을 때만 흐르고, 다 끝나면 멈춥니다">
              {fmtClock(simTime.value)}
            </span>
            <button class="ff" onClick={() => sim.fastForward(10_000)} title="10초를 한꺼번에 흘려보냅니다">
              +10초
            </button>
            <button class="ff" onClick={() => sim.fastForward(60_000)} title="1분을 한꺼번에 흘려보냅니다 (백오프 기다리기)">
              +1분
            </button>
          </div>
        </div>
        <div class="topbar-right">
          <ExampleMenu
            onPick={(id) => {
              loadExample(id);
              sim.reset();
              document.querySelector(".canvas")?.scrollTo(0, 0);
            }}
          />
          <button class="btn ghost" onClick={() => sim.reset()} title="지금 구성으로 시계·로그를 0 부터 다시 시작합니다">
            <Icon name="refresh" size={15} />
            처음부터
          </button>
          <button class="icon-btn" onClick={toggleTheme} title={theme.value === "dark" ? "라이트 테마" : "다크 테마"} aria-label="테마 바꾸기">
            <Icon name={theme.value === "dark" ? "sun" : "moon"} size={18} />
          </button>
        </div>
      </header>
      <div class="body" style={{ "--inspector-w": `${inspectorOpen.value ? inspectorWidth.value : INSPECTOR_RAIL}px` }}>
        <Sidebar />
        <Canvas />
        <Inspector />
      </div>
      <Drawer />
      {notice.value && <div class="toast">{notice.value}</div>}
    </div>
  );
}

function ExampleMenu({ onPick }: { onPick: (id: string) => void }) {
  const open = useSignal(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open.value) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) open.value = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") open.value = false;
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open.value]);
  const query = useSignal("");
  const search = useRef<HTMLInputElement>(null);
  // 그리기 전에 포커스: 메뉴를 열자마자 친 글자도 검색 칸으로 (useEffect 는 늦어 첫 글자를 놓친다)
  useLayoutEffect(() => {
    if (open.value) search.current?.focus();
    else query.value = "";
  }, [open.value]);
  const current = EXAMPLES.find((e) => e.id === exampleId.value);
  const q = query.value.trim().toLowerCase();
  const groups = EXAMPLE_GROUPS.map((g) => ({
    label: g.label,
    items: g.ids.map((id) => exampleById(id)!).filter((x) => !q || `${g.label} ${x.title} ${x.summary}`.toLowerCase().includes(q)),
  })).filter((g) => g.items.length > 0);
  const first = groups[0]?.items[0];
  const pick = (id: string) => {
    open.value = false;
    onPick(id);
  };
  return (
    <div class="menu-wrap" ref={wrap}>
      <button class={`btn ghost menu-btn${open.value ? " on" : ""}`} onClick={() => (open.value = !open.value)} aria-haspopup="menu" aria-expanded={open.value}>
        <span class="menu-btn-label">{current ? current.title : "예제"}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open.value && (
        <div class="menu menu-wide" role="menu">
          <div class="menu-head">
            <span class="menu-caption">
              예제 불러오기 <span class="muted">{EXAMPLES.length}개 · 클러스터를 처음부터 다시 만듭니다. 위에서 아래, 왼쪽에서 오른쪽이 학습 순서입니다</span>
            </span>
            <input
              class="input menu-search"
              value={query.value}
              placeholder="예제 찾기 (예: Pending, readiness, Ingress)"
              ref={search}
              onInput={(e) => (query.value = e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && first) pick(first.id);
              }}
            />
          </div>
          <div class="menu-examples">
            {groups.map((g) => (
              <div key={g.label} class="menu-group">
                <div class="menu-group-label">{g.label}</div>
                {g.items.map((x) => {
                  const m = /^(.*?)\s*\((.*)\)$/.exec(x.title);
                  return (
                    <button key={x.id} role="menuitem" class={`menu-item example-item${x.id === exampleId.value ? " current" : ""}`} data-example={x.id} title={x.summary} onClick={() => pick(x.id)}>
                      <span class="menu-item-title">{m ? m[1] : x.title}</span>
                      {m && <span class="menu-item-sub">{m[2]}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
            {groups.length === 0 && <p class="note menu-empty">"{query.value.trim()}" 에 맞는 예제가 없습니다. 묶음·제목·설명에 나오는 말(Pod·Service·rolling·ArgoCD 등)로 찾아 보세요.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
