// 캔버스 위에 겹쳐 그리는 것: 고른 Service 에서 엔드포인트 Pod 로 가는 옅은 선, 방금 보낸 요청이 지나간 길(움직이는 점 + 단계 이름표).
// 위치는 DOM 에서 읽는다 (Pod 칩·Service 상자·CoreDNS 상자의 data- 속성).
import { useSignal } from "@preact/signals";
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { NetStep } from "../core/net/request";
import { lastRequest, type RequestView } from "../model/sim";
import { selection } from "../model/store";
import type { ClusterView } from "../model/view";

interface Pt {
  x: number;
  y: number;
}

/** 요소의 한 점 (ay: 0 = 위 가장자리, 0.5 = 가운데, 1 = 아래 가장자리) — 캔버스 스크롤 좌표 */
function anchor(root: HTMLElement, el: Element | null | undefined, ay: number): Pt | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  const o = root.getBoundingClientRect();
  return { x: r.left - o.left + root.scrollLeft + r.width / 2, y: r.top - o.top + root.scrollTop + r.height * ay };
}

function center(root: HTMLElement, el: Element | null | undefined): Pt | undefined {
  return anchor(root, el, 0.5);
}

function q(root: HTMLElement, sel: string): Element | null {
  return root.querySelector(sel);
}

const esc = (s: string) => s.replace(/"/g, '\\"');

export function Overlay({ root, view, version }: { root: RefObject<HTMLElement>; view: ClusterView; version: number }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [links, setLinks] = useState<{ a: Pt; b: Pt; ready: boolean }[]>([]);
  const sel = selection.value;

  // 고른 Service → 엔드포인트 Pod 선
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setSize({ w: el.scrollWidth, h: el.scrollHeight });
    if (sel?.kind !== "Service") {
      setLinks([]);
      return;
    }
    const s = view.services.find((x) => x.name === sel.name);
    // Service 상자 아래 가장자리 → Pod 칩 위 가장자리 (글자를 가로지르지 않게)
    const from = anchor(el, q(el, `[data-service="${esc(sel.name)}"]`), 1);
    if (!s || !from) {
      setLinks([]);
      return;
    }
    const out: { a: Pt; b: Pt; ready: boolean }[] = [];
    for (const [names, ready] of [
      [s.ready, true],
      [s.notReady, false],
    ] as const) {
      for (const n of names) {
        const to = anchor(el, q(el, `[data-pod="${esc(n)}"]`), 0);
        if (to) out.push({ a: from, b: to, ready });
      }
    }
    setLinks(out);
  }, [version, sel?.kind, sel?.name, root.current]);

  return (
    <svg class="overlay" width={size.w} height={size.h} aria-hidden="true">
      {links.map((l, i) => (
        <line key={i} class={`ep-link${l.ready ? "" : " not-ready"}`} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} />
      ))}
      <RequestPath root={root} />
    </svg>
  );
}

interface Hop {
  pt: Pt;
  step?: NetStep;
}

/** 요청 한 번의 경로: 출발 Pod → (CoreDNS) → (Service) → 도착 Pod. 단계마다 잠깐 멈춰 이름표 */
function RequestPath({ root }: { root: RefObject<HTMLElement> }) {
  const req = lastRequest.value;
  const hops = useSignal<Hop[]>([]);
  const at = useSignal(-1);
  const done = useSignal(false);

  useEffect(() => {
    const el = root.current;
    if (!req || !el) return;
    const list = buildHops(el, req);
    hops.value = list;
    at.value = 0;
    done.value = false;
    const timers: number[] = [];
    list.forEach((_, i) => timers.push(window.setTimeout(() => (at.value = i), i * 700)));
    timers.push(window.setTimeout(() => (done.value = true), list.length * 700 + 2600));
    return () => timers.forEach(clearTimeout);
  }, [req?.id]);

  if (!req || done.value || at.value < 0 || !hops.value.length) return null;
  const list = hops.value;
  const cur = list[Math.min(at.value, list.length - 1)]!;
  const failed = req.net.steps.at(-1)?.kind === "fail";
  const last = at.value >= list.length - 1;
  const label = cur.step ? `${cur.step.actor}: ${cur.step.text}` : "출발";
  return (
    <g class={`req${failed && last ? " fail" : ""}`}>
      <polyline class="req-trail" points={list.slice(0, at.value + 1).map((h) => `${h.pt.x},${h.pt.y}`).join(" ")} />
      <circle class="req-dot" cx={cur.pt.x} cy={cur.pt.y} r={7} />
      <foreignObject x={cur.pt.x + 12} y={cur.pt.y - 14} width={360} height={90}>
        <div class="req-label">{label.length > 150 ? `${label.slice(0, 150)}…` : label}</div>
      </foreignObject>
    </g>
  );
}

function buildHops(el: HTMLElement, req: RequestView): Hop[] {
  const out: Hop[] = [];
  const start = req.fromPod ? center(el, q(el, `[data-pod="${esc(req.fromPod)}"]`)) : req.fromOutside ? center(el, q(el, '[data-outside="internet"]')) : undefined;
  if (start) out.push({ pt: start });
  for (const s of req.net.steps) {
    const target = s.at?.dns
      ? q(el, '[data-comp="coredns"]')
      : s.at?.ingress && s.kind === "dnat" && !s.at.pod
        ? q(el, `[data-ingress="${esc(s.at.ingress)}"]`)
      : s.at?.outside && !s.at.node && !s.at.pod
        ? q(el, '[data-outside="internet"]')
      : s.at?.pod
        ? q(el, `[data-pod="${esc(s.at.pod)}"]`)
        : s.at?.service
          ? q(el, `[data-service="${esc(s.at.service)}"]`)
          : s.at?.node
            ? q(el, `[data-node="${esc(s.at.node)}"] .node-head`)
            : null;
    const pt = center(el, target) ?? out.at(-1)?.pt;
    if (pt) out.push({ pt, step: s });
    // DNS 는 답을 돌려줄 뿐 요청을 넘기지 않는다 → 답을 받은 출발지로 돌아와서 그 주소로 연결
    if (s.at?.dns && start) out.push({ pt: start, step: { kind: "dns", actor: req.fromPod ?? "client", text: "DNS 답(ClusterIP)을 받아 그 주소로 TCP 연결 시작" } });
  }
  return out;
}
