// Argo CD application-controller 흉내: Application 마다 Git(원하는 상태)과 라이브를 비교해 Synced/OutOfSync·Health 를 적고,
// 자동 sync·self-heal·prune 을 한다.
// - Git 은 3분마다 폴링한다(실제 기본 timeout.reconciliation 180초). 그래서 push 해도 바로 바뀌지 않는다 — Refresh(또는 webhook)로 당긴다.
// - 라이브는 watch 로 바로 본다: kubectl 로 바꾸면 곧 OutOfSync.
// - 자동 sync 는 "새 리비전" 에만 한 번 돈다. 라이브가 바뀐 것(드리프트)을 되돌리는 것은 selfHeal 이 켜져 있을 때만 (5초 뒤).
// - prune 이 켜져 있어야 Git 에서 지운 리소스를 지운다. 꺼져 있으면 OutOfSync(requiresPruning) 로 남는다.
// 축소판: Argo CD 는 Pod 없는 부가 기능, 대상 네임스페이스는 default 하나, 비교는 "Git 에 적은 필드가 라이브와 같은가"(기본값으로 채워진 필드는 무시),
//         sync 는 즉시 끝남, 훅·sync wave·리소스 finalizer 없음.
import { refOf } from "../api/server";
import { b64encode } from "../base64";
import type { Application, HealthStatus, KObject, SyncStatus } from "../api/types";
import type { TimerHandle } from "../clock";
import { configKeys, LAST_APPLIED, type Manifest } from "../cluster";
import { Controller, nsKey, splitKey, type ComponentContext } from "../controllers/base";
import { rolloutComplete } from "../controllers/deployment";
import type { GitRepo } from "./git";

export const ARGO = "argocd-application-controller";
export const ARGO_NS = "argocd";
/** Argo CD 가 자기가 만든 리소스에 붙이는 표 (이 Application 의 것) */
export const INSTANCE_LABEL = "app.kubernetes.io/instance";
/** Git 폴링 주기 (실제 기본 180초) */
export const POLL_MS = 180_000;
/** 드리프트를 보고 self-heal 하기까지 (실제 기본 selfHealTimeoutSeconds 5) */
export const SELF_HEAL_MS = 5_000;

const TRACKED = ["Deployment", "Service", "Ingress", "PodDisruptionBudget", "ConfigMap", "Secret", "NetworkPolicy"] as const;
type TrackedKind = (typeof TRACKED)[number];

export interface ResourceDiff {
  kind: string;
  name: string;
  /** "spec.replicas: Git 1 · 라이브 3" 같은 줄 */
  lines: string[];
  missing?: boolean;
  extra?: boolean;
}

export class ArgoCD extends Controller {
  /** Application → 마지막으로 Git 에서 가져온 리비전 (어느 source 에서 가져왔는지와 함께 — source 가 바뀌면 다시 가져온다) */
  private readonly fetched = new Map<string, { sha: string; source: string }>();
  private readonly healTimers = new Map<string, TimerHandle>();
  /** 다음 Git 폴링 시각 */
  nextPollAt = POLL_MS;

  constructor(
    ctx: ComponentContext,
    private readonly repo: (url: string) => GitRepo | undefined,
    private readonly applyManifest: (m: Manifest) => "created" | "configured" | "unchanged",
  ) {
    super(ARGO, ctx);
    ctx.api.watch("Application", (ev) => {
      if (ev.type === "DELETED") {
        const key = nsKey(ev.object.metadata.namespace, ev.object.metadata.name);
        this.fetched.delete(key);
        this.healTimers.get(key)?.cancel();
        this.healTimers.delete(key);
        return;
      }
      const key = nsKey(ev.object.metadata.namespace, ev.object.metadata.name);
      const f = this.fetched.get(key);
      if (f && f.source !== sourceKey(ev.object)) this.fetched.delete(key); // source 가 바뀜 → 새로 가져온다
      this.enqueue(key);
    });
    for (const kind of TRACKED) {
      ctx.api.watch(kind, (ev) => {
        const app = ev.object.metadata.labels[INSTANCE_LABEL];
        if (app) this.enqueue(nsKey(ARGO_NS, app));
      });
    }
    this.schedulePoll();
  }

  /** 배경 타이머: 끝없는 주기 동작 */
  private schedulePoll(): void {
    this.nextPollAt = this.now + POLL_MS;
    this.ctx.clock.background(POLL_MS, ARGO, () => {
      for (const a of this.api.peekList("Application")) this.fetch(nsKey(a.metadata.namespace, a.metadata.name), "3분 폴링");
      this.schedulePoll();
    });
  }

  /** Git 에서 지금 HEAD 를 가져온다 (폴링·Refresh·webhook) */
  fetch(key: string, why: string): void {
    const [ns, name] = splitKey(key);
    const app = this.api.get("Application", name, ns);
    if (!app) return;
    const head = this.repo(app.spec.source.repoURL)?.head?.sha;
    if (!head) return;
    const prev = this.fetched.get(key)?.sha;
    this.fetched.set(key, { sha: head, source: sourceKey(app) });
    if (prev !== head) this.ctx.trace.add(ARGO, "gitops.fetch", `${name}: Git ${app.spec.source.targetRevision} 을 가져옴 (${why}) → ${prev ? `${prev.slice(0, 7)} → ` : ""}${head.slice(0, 7)}`, refOf(app));
    this.enqueue(key);
  }

  refresh(name: string): void {
    this.fetch(nsKey(ARGO_NS, name), "Refresh");
  }

  protected reconcile(key: string): void {
    const [ns, name] = splitKey(key);
    const app = this.api.get("Application", name, ns);
    if (!app) return;
    if (!this.fetched.has(key)) this.fetch(key, "처음 비교");
    const rev = this.fetched.get(key)?.sha;
    if (!rev) {
      this.setStatus(app, { sync: { status: "Unknown" }, health: { status: "Unknown" }, resources: [] });
      return;
    }
    const cmp = this.compare(app, rev);
    this.setStatus(app, { sync: { status: cmp.sync, revision: rev }, health: { status: cmp.health }, resources: cmp.resources });
    if (cmp.sync !== "OutOfSync") {
      this.healTimers.get(key)?.cancel();
      this.healTimers.delete(key);
      return;
    }
    const auto = app.spec.syncPolicy?.automated;
    if (!auto) return;
    // 할 일이 prune 뿐인데 prune 이 꺼져 있으면 자동 sync 도 self-heal 도 하지 않는다 (해도 바뀌는 것이 없어 끝없이 되풀이된다)
    const actionable = cmp.diffs.filter((d) => !d.extra || auto.prune);
    if (!actionable.length) {
      this.note(key, `${name}: 남은 차이가 Git 에서 지운 리소스(prune 대상)뿐인데 자동 prune 이 꺼져 있어 sync 하지 않음 — argocd app sync --prune 으로`, app);
      return;
    }
    // Git 경로가 비면 자동 sync 는 전부 지우지 않는다 (allowEmpty 기본 false)
    if (!this.desired(app, rev).length) {
      this.note(key, `${name}: Git ${app.spec.source.path}/ 가 비어 있음 → auto-sync will wipe out all resources — 자동 sync 를 하지 않음 (allowEmpty=false)`, app);
      return;
    }
    const last = app.status.operationState?.syncResult;
    if (last?.revision !== rev || (last.source !== undefined && last.source !== sourceKey(app))) {
      // 새 리비전(또는 새 source): 자동 sync 는 (리비전, source) 마다 한 번
      this.sync(name, { prune: !!auto.prune, automated: true });
      return;
    }
    if (!auto.selfHeal) return; // 드리프트지만 selfHeal 이 꺼져 있으면 OutOfSync 로 둔다
    if (this.healTimers.has(key)) return;
    const what = cmp.diffs.filter((d) => !d.extra || auto.prune).map(describeDiff).join(" · ");
    this.ctx.trace.add(ARGO, "gitops.selfheal", `${name}: 라이브가 Git(${rev.slice(0, 7)})과 다름 — ${what} → selfHeal: ${SELF_HEAL_MS / 1000}초 뒤 다시 sync`, refOf(app));
    this.healTimers.set(
      key,
      this.ctx.clock.after(SELF_HEAL_MS, ARGO, () => {
        this.healTimers.delete(key);
        const now = this.api.get("Application", name, ns);
        if (!now?.spec.syncPolicy?.automated?.selfHeal) return;
        const again = this.compare(now, this.fetched.get(key)?.sha ?? rev);
        if (again.sync === "OutOfSync") this.sync(name, { prune: !!now.spec.syncPolicy.automated.prune, automated: true, selfHeal: true });
      }),
    );
  }

  /** Git 의 원하는 상태와 라이브 비교 */
  compare(app: Application, rev: string): { sync: SyncStatus; health: HealthStatus; resources: Application["status"]["resources"]; diffs: ResourceDiff[] } {
    const desired = this.desired(app, rev);
    const live = this.trackedLive(app.metadata.name);
    const resources: Application["status"]["resources"] = [];
    const diffs: ResourceDiff[] = [];
    for (const m of desired) {
      const l = this.api.get(m.kind as TrackedKind, m.metadata.name, "default");
      if (!l) {
        resources.push({ kind: m.kind, name: m.metadata.name, status: "OutOfSync", health: "Missing" });
        diffs.push({ kind: m.kind, name: m.metadata.name, lines: ["라이브에 없음"], missing: true });
        continue;
      }
      const lines = diffFields(m, l);
      if (lines.length) diffs.push({ kind: m.kind, name: m.metadata.name, lines });
      resources.push({ kind: m.kind, name: m.metadata.name, status: lines.length ? "OutOfSync" : "Synced", health: healthOf(l) });
    }
    for (const l of live) {
      if (desired.some((m) => m.kind === l.kind && m.metadata.name === l.metadata.name)) continue;
      resources.push({ kind: l.kind, name: l.metadata.name, status: "OutOfSync", health: healthOf(l), requiresPruning: true });
      diffs.push({ kind: l.kind, name: l.metadata.name, lines: ["Git 에 없음 (prune 대상)"], extra: true });
    }
    const sync: SyncStatus = resources.some((r) => r.status === "OutOfSync") ? "OutOfSync" : "Synced";
    const order: HealthStatus[] = ["Healthy", "Progressing", "Missing", "Degraded"];
    const health = resources.filter((r) => !r.requiresPruning).reduce<HealthStatus>((w, r) => (order.indexOf(r.health ?? "Healthy") > order.indexOf(w) ? (r.health ?? "Healthy") : w), "Healthy");
    return { sync, health, resources, diffs };
  }

  /** 같은 안내를 되풀이해 찍지 않는다 */
  private readonly notes = new Map<string, string>();
  private note(key: string, msg: string, app: Application): void {
    if (this.notes.get(key) === msg) return;
    this.notes.set(key, msg);
    this.ctx.trace.add(ARGO, "gitops.compare", msg, refOf(app));
  }

  diffs(name: string): ResourceDiff[] {
    const app = this.api.get("Application", name, ARGO_NS);
    const rev = this.fetched.get(nsKey(ARGO_NS, name))?.sha;
    return app && rev ? this.compare(app, rev).diffs : [];
  }

  fetchedRevision(name: string): string | undefined {
    return this.fetched.get(nsKey(ARGO_NS, name))?.sha;
  }

  /** sync: Git 의 매니페스트를 apply 하고, prune 이면 Git 에 없는 것을 지운다 */
  sync(name: string, opts: { prune: boolean; automated?: boolean; selfHeal?: boolean; actor?: string }): { ok: boolean; message: string; lines: string[] } {
    const key = nsKey(ARGO_NS, name);
    const app = this.api.get("Application", name, ARGO_NS);
    if (!app) return { ok: false, message: `application "${name}" not found`, lines: [] };
    // 손으로 하는 sync 는 지금 Git HEAD 를 다시 읽는다 (리비전을 정하지 않으면 targetRevision 을 새로 푼다)
    if (!opts.automated || !this.fetched.has(key)) this.fetch(key, opts.automated ? "sync 전에" : "sync — targetRevision 을 다시 풂");
    const rev = this.fetched.get(key)?.sha;
    if (!rev) return { ok: false, message: "Git 저장소를 읽지 못했습니다", lines: [] };
    const now = this.now;
    const kind = opts.selfHeal ? "self-heal" : opts.automated ? "automated sync" : "sync";
    this.api.recordEvent(app, "Normal", "OperationStarted", `Initiated ${opts.automated ? "automated " : ""}sync to '${rev}'`, ARGO);
    const lines: string[] = [];
    const failed: string[] = [];
    for (const m of this.desired(app, rev)) {
      try {
        const r = this.applyManifest(m);
        lines.push(`${resourceName(m.kind)}/${m.metadata.name} ${r}`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        failed.push(`${resourceName(m.kind)}/${m.metadata.name}: ${why}`);
        lines.push(`${resourceName(m.kind)}/${m.metadata.name} failed: ${why}`);
      }
    }
    if (failed.length) {
      const message = `one or more objects failed to apply, reason: ${failed.join("; ")}`;
      this.ctx.trace.add(opts.actor ?? ARGO, "gitops.sync", `${name}: ${kind} 실패 — ${message}`, refOf(app));
      this.api.patch("Application", name, ARGO_NS, ARGO, (o) => {
        // 자동 sync 는 같은 리비전을 다시 시도하지 않는다 (retry 정책 없음) → 시도한 리비전을 남긴다
        o.status.operationState = { phase: "Failed", message, syncResult: { revision: rev, source: sourceKey(app) }, startedAt: now, finishedAt: now };
      });
      this.api.recordEvent(app, "Warning", "OperationCompleted", `Sync operation to ${rev} failed: ${message}`, ARGO);
      this.enqueue(key);
      return { ok: false, message, lines };
    }
    for (const l of this.trackedLive(name)) {
      if (this.desired(app, rev).some((m) => m.kind === l.kind && m.metadata.name === l.metadata.name)) continue;
      if (opts.prune) {
        this.api.delete(l.kind, l.metadata.name, "default", ARGO);
        lines.push(`${resourceName(l.kind)}/${l.metadata.name} pruned`);
      } else lines.push(`${resourceName(l.kind)}/${l.metadata.name} ignored (requires pruning)`);
    }
    const changed = lines.filter((x) => !x.endsWith(" unchanged") && !x.includes("ignored"));
    this.ctx.trace.add(
      opts.actor ?? ARGO,
      "gitops.sync",
      `${name}: ${kind} → Git ${rev.slice(0, 7)} 적용${changed.length ? ` (${changed.join(", ")})` : " (바뀐 것 없음)"}${lines.some((x) => x.includes("ignored")) ? " · prune 이 꺼져 있어 Git 에서 지운 리소스는 남김" : ""}`,
      refOf(app),
    );
    this.api.patch("Application", name, ARGO_NS, ARGO, (o) => {
      o.status.operationState = { phase: "Succeeded", message: "successfully synced (all tasks run)", syncResult: { revision: rev, source: sourceKey(app) }, startedAt: now, finishedAt: now };
      const nextId = o.status.history.length ? Math.max(...o.status.history.map((h) => h.id)) + 1 : 0;
      o.status.history = [...o.status.history, { id: nextId, revision: rev, deployedAt: now }].slice(-10);
    });
    this.api.recordEvent(app, "Normal", "OperationCompleted", `Sync operation to ${rev} succeeded`, ARGO);
    this.enqueue(key);
    return { ok: true, message: "successfully synced (all tasks run)", lines };
  }

  /** Git 의 매니페스트 + Argo CD 의 추적 표 */
  private desired(app: Application, rev: string): Manifest[] {
    const repo = this.repo(app.spec.source.repoURL);
    if (!repo) return [];
    return repo.manifestsAt(rev, app.spec.source.path).map((m) => {
      const out = structuredClone(m);
      out.metadata.namespace = "default";
      out.metadata.labels = { ...(out.metadata.labels ?? {}), [INSTANCE_LABEL]: app.metadata.name };
      return out;
    });
  }

  private trackedLive(app: string): KObject[] {
    return TRACKED.flatMap((k) => this.api.list(k, "default").filter((o) => o.metadata.labels[INSTANCE_LABEL] === app));
  }

  private setStatus(app: Application, s: Pick<Application["status"], "sync" | "health" | "resources">): void {
    const cur = app.status;
    if (JSON.stringify([cur.sync, cur.health, cur.resources]) === JSON.stringify([s.sync, s.health, s.resources])) return;
    const before = `${cur.sync.status}/${cur.health.status}`;
    this.api.patch("Application", app.metadata.name, app.metadata.namespace, ARGO, (o) => {
      o.status.sync = s.sync;
      o.status.health = s.health;
      o.status.resources = s.resources;
    });
    const after = `${s.sync.status}/${s.health.status}`;
    if (before !== after) this.ctx.trace.add(ARGO, "gitops.compare", `${app.metadata.name}: ${before} → ${after}${s.sync.revision ? ` (Git ${s.sync.revision.slice(0, 7)})` : ""}`, refOf(app));
  }
}

function sourceKey(app: Application): string {
  const s = app.spec.source;
  return `${s.repoURL}|${s.path}|${s.targetRevision}`;
}

/** Git 에 적은 필드가 라이브에 같은 값으로 있는가 — 다른 곳을 "경로: Git · 라이브" 줄로 */
export function diffFields(m: Manifest, live: KObject): string[] {
  const out: string[] = [];
  const walk = (want: unknown, have: unknown, path: string) => {
    if (want === undefined) return;
    if (want !== null && typeof want === "object") {
      if (Array.isArray(want)) {
        if (!Array.isArray(have) || have.length !== want.length) {
          out.push(`${path}: Git ${short(want)} · 라이브 ${short(have)}`);
          return;
        }
        want.forEach((w, i) => walk(w, have[i], `${path}[${i}]`));
        return;
      }
      if (have === null || typeof have !== "object") {
        out.push(`${path}: Git ${short(want)} · 라이브 ${short(have)}`);
        return;
      }
      for (const [k, v] of Object.entries(want as Record<string, unknown>)) walk(v, (have as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      return;
    }
    if (want !== have) out.push(`${path}: Git ${short(want)} · 라이브 ${short(have)}`);
  };
  if (m.kind === "ConfigMap" || m.kind === "Secret") {
    // 키 집합까지 같아야 한다 (Git 에서 지운 키가 라이브에 남아 있으면 다름). Secret 은 Git 의 stringData 를 base64 로 바꿔 비교
    const want: Record<string, string> = { ...(m.data ?? {}) };
    if (m.kind === "Secret") for (const [k, v] of Object.entries(m.stringData ?? {})) want[k] = b64encode(v);
    const have = (live as { data?: Record<string, string> }).data ?? {};
    // 3-way: Git 에 없는 라이브 키는, 지난번 sync(apply)가 넣은 것일 때만 다름 (손으로 더한 키는 apply 가 지우지 않으므로 보지 않는다)
    let applied: Set<string> = new Set();
    try {
      applied = configKeys(JSON.parse(live.metadata.annotations?.[LAST_APPLIED] ?? "null") ?? undefined);
    } catch {
      /* 주석이 깨졌으면 지난번 것을 모른다고 본다 */
    }
    for (const k of new Set([...Object.keys(want), ...Object.keys(have).filter((x) => applied.has(x))])) if (want[k] !== have[k]) out.push(`data.${k}: Git ${short(m.kind === "Secret" ? (want[k] === undefined ? undefined : "(값)") : want[k])} · 라이브 ${short(m.kind === "Secret" ? (have[k] === undefined ? undefined : "(값)") : have[k])}`);
  } else {
    walk(m.spec, (live as { spec?: unknown }).spec, "spec");
    // 3-way: 지난번 sync 가 넣었는데 Git 에서 지운 필드가 라이브에 남아 있으면 다름 (예: NetworkPolicy 의 ingress 를 통째로 지움 = 모두 차단)
    const removed = (applied: unknown, want: unknown, have: unknown, path: string) => {
      if (!isObj(applied) || !isObj(have)) return;
      for (const [k, a] of Object.entries(applied)) {
        const w = isObj(want) ? want[k] : undefined;
        const h = have[k];
        if (w === undefined && h !== undefined) out.push(`${path}.${k}: Git (없음) · 라이브 ${short(h)}`);
        else if (w !== undefined) removed(a, w, h, `${path}.${k}`);
      }
    };
    let last: { spec?: unknown } | undefined;
    try {
      last = JSON.parse(live.metadata.annotations?.[LAST_APPLIED] ?? "null") ?? undefined;
    } catch {
      /* 주석이 깨졌으면 지난번 것을 모른다고 본다 */
    }
    removed(last?.spec, m.spec, (live as { spec?: unknown }).spec, "spec");
  }
  walk(m.metadata.labels ?? {}, live.metadata.labels, "metadata.labels");
  const ann = (m.metadata as { annotations?: Record<string, string> }).annotations;
  if (ann) walk(ann, live.metadata.annotations ?? {}, "metadata.annotations");
  return out;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function short(v: unknown): string {
  if (v === undefined) return "(없음)";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

export function healthOf(o: KObject): HealthStatus {
  switch (o.kind) {
    case "Deployment": {
      if (o.status.conditions?.some((c) => c.type === "Progressing" && c.reason === "ProgressDeadlineExceeded")) return "Degraded";
      return rolloutComplete(o) ? "Healthy" : "Progressing";
    }
    case "Service":
      return o.spec.type === "LoadBalancer" && !o.status.loadBalancer?.ingress?.length ? "Progressing" : "Healthy";
    case "Ingress":
      return o.status.loadBalancer.ingress?.length ? "Healthy" : "Progressing";
    default:
      return "Healthy";
  }
}

export function describeDiff(d: ResourceDiff): string {
  return `${d.kind} ${d.name}: ${d.lines.join(", ")}`;
}

export function resourceName(kind: string): string {
  return kind === "Deployment" ? "deployment.apps" : kind === "Ingress" ? "ingress.networking.k8s.io" : kind === "PodDisruptionBudget" ? "poddisruptionbudget.policy" : kind.toLowerCase();
}
