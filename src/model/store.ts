// 앱 상태: 사용자가 고치는 원본(노드 + 매니페스트), 선택, 화면 설정. localStorage 에 저장한다.
// 클러스터의 "라이브" 상태는 sim.ts 의 Cluster 가 가진다 — kubectl 로 바꾼 것은 여기(매니페스트)에 돌아오지 않는다 (실제와 같다).
import { effect, signal } from "@preact/signals";
import type { DeploymentManifest, Manifest, ServiceManifest } from "../core/cluster";
import type { NodeDef } from "../core/kubelet";
import type { ObjRef } from "../core/trace";
import { DEFAULT_EXAMPLE, exampleById, type ClusterDef } from "./examples";

const DEF_KEY = "kube-sim.def.v1";
const THEME_KEY = "kube-sim.theme";
const UI_KEY = "kube-sim.ui.v1";

type Theme = "light" | "dark";

interface Saved {
  exampleId: string | null;
  def: ClusterDef;
}

function load<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장 공간이 없거나 막혀 있으면 이번 세션만 쓴다
  }
}

function isDef(v: unknown): v is ClusterDef {
  const d = v as ClusterDef;
  return !!d && Array.isArray(d.nodes) && Array.isArray(d.manifests) && (d.git === undefined || Array.isArray(d.git)) && d.nodes.every((n) => typeof n?.name === "string" && typeof n.cpu === "number" && typeof n.memory === "number");
}

const saved = load<Saved>(DEF_KEY);
const initialExample = exampleById(DEFAULT_EXAMPLE)!;

export const exampleId = signal<string | null>(saved && isDef(saved.def) ? saved.exampleId : initialExample.id);
export const clusterDef = signal<ClusterDef>(saved && isDef(saved.def) ? saved.def : initialExample.build());

export const selection = signal<ObjRef | null>(null);

const prefersDark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
export const theme = signal<Theme>(load<Theme>(THEME_KEY) ?? (prefersDark ? "dark" : "light"));

interface UiPrefs {
  drawerOpen: boolean;
  drawerTab: "log" | "kubectl";
  showApi: boolean;
  inspectorOpen?: boolean;
  inspectorWidth?: number;
  drawerHeight?: number;
}
const ui = load<UiPrefs>(UI_KEY);
export const drawerOpen = signal(ui?.drawerOpen ?? true);
export const drawerTab = signal<UiPrefs["drawerTab"]>(ui?.drawerTab ?? "log");
/** 로그에 API 서버 쓰기(api.*) 줄도 보일지 */
export const showApi = signal(ui?.showApi ?? false);
/** 로그에서 고른 오브젝트에 관한 줄만 */
export const logOnlySelected = signal(false);

// ---------- 패널 크기 (net-sim 과 같은 방식): 브라우저별 편의 설정이라 localStorage ----------

/** 캔버스가 이보다 좁아지게는 넓히지 않는다 (왼쪽 목록 232px 도 뺀다) */
const CANVAS_MIN = 360;
const SIDEBAR_W = 232;

export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 760;
export const INSPECTOR_DEFAULT = 340;
/** "넓게" — describe·YAML 이 가로 스크롤 없이 읽히는 폭 */
export const INSPECTOR_WIDE = 560;
/** 접힌 상태에서는 레일만 (펼치기 버튼 28px + 양옆 여백) */
export const INSPECTOR_RAIL = 40;
export const inspectorOpen = signal<boolean>(ui?.inspectorOpen ?? true);
export const inspectorWidth = signal<number>(clampInspector(ui?.inspectorWidth ?? INSPECTOR_DEFAULT));

function clampInspector(w: number): number {
  const fit = typeof window === "undefined" ? INSPECTOR_MAX : window.innerWidth - SIDEBAR_W - CANVAS_MIN;
  return Math.min(Math.max(INSPECTOR_MIN, Math.min(INSPECTOR_MAX, fit)), Math.max(INSPECTOR_MIN, Math.round(Number.isFinite(w) ? w : INSPECTOR_DEFAULT)));
}

export function setInspectorWidth(w: number): void {
  inspectorWidth.value = clampInspector(w);
}

/** 보통 ↔ 넓게 */
export function toggleInspectorWide(): void {
  setInspectorWidth(inspectorWidth.value >= INSPECTOR_WIDE - 40 ? INSPECTOR_DEFAULT : INSPECTOR_WIDE);
}

export function toggleInspector(): void {
  inspectorOpen.value = !inspectorOpen.value;
}

/** 서랍 내용 높이(px, 머리 줄 36px 제외). 끝까지 올리면 상단바 바로 아래까지 */
export const DRAWER_MIN = 120;
export const DRAWER_DEFAULT = 260;
const TOPBAR_H = 44;
const DRAWER_HEAD_H = 36;
export const drawerHeight = signal<number>(clampDrawer(ui?.drawerHeight ?? DRAWER_DEFAULT));

export function drawerMaxHeight(): number {
  return typeof window === "undefined" ? Number.POSITIVE_INFINITY : Math.max(DRAWER_MIN, window.innerHeight - TOPBAR_H - DRAWER_HEAD_H - 2);
}

function clampDrawer(h: number): number {
  return Math.min(drawerMaxHeight(), Math.max(DRAWER_MIN, Math.round(Number.isFinite(h) ? h : DRAWER_DEFAULT)));
}

export function setDrawerHeight(h: number): void {
  drawerHeight.value = clampDrawer(h);
}

/** 기본 ↔ 끝까지 */
export function toggleDrawerMax(): void {
  setDrawerHeight(drawerHeight.value >= drawerMaxHeight() - 8 ? DRAWER_DEFAULT : drawerMaxHeight());
}

effect(() => save(DEF_KEY, { exampleId: exampleId.value, def: clusterDef.value } satisfies Saved));
effect(() => {
  save(THEME_KEY, theme.value);
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme.value;
});
effect(() =>
  save(UI_KEY, {
    drawerOpen: drawerOpen.value,
    drawerTab: drawerTab.value,
    showApi: showApi.value,
    inspectorOpen: inspectorOpen.value,
    inspectorWidth: inspectorWidth.value,
    drawerHeight: drawerHeight.value,
  } satisfies UiPrefs),
);

export function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
}

export function loadExample(id: string): void {
  const ex = exampleById(id);
  if (!ex) return;
  exampleId.value = id;
  clusterDef.value = ex.build();
  selection.value = null;
}

// ---------- 매니페스트 편집 (인스펙터 폼) ----------

export function updateManifest(name: string, mutate: (m: DeploymentManifest) => void): void {
  const def = structuredClone(clusterDef.value);
  const m = def.manifests.find((x): x is DeploymentManifest => x.kind === "Deployment" && x.metadata.name === name);
  if (!m) return;
  mutate(m);
  clusterDef.value = def;
}

export function updateServiceManifest(name: string, mutate: (m: ServiceManifest) => void): void {
  const def = structuredClone(clusterDef.value);
  const m = def.manifests.find((x): x is ServiceManifest => x.kind === "Service" && x.metadata.name === name);
  if (!m) return;
  mutate(m);
  clusterDef.value = def;
}

export function findManifest<K extends Manifest["kind"]>(kind: K, name: string): Extract<Manifest, { kind: K }> | undefined {
  return clusterDef.value.manifests.find((x) => x.kind === kind && x.metadata.name === name) as Extract<Manifest, { kind: K }> | undefined;
}

export function addManifest(m: Manifest): void {
  const def = structuredClone(clusterDef.value);
  def.manifests.push(m);
  clusterDef.value = def;
}

export function removeManifest(kind: Manifest["kind"], name: string): void {
  clusterDef.value = { ...clusterDef.value, manifests: clusterDef.value.manifests.filter((m) => !(m.kind === kind && m.metadata.name === name)) };
}

export function addNodeDef(): NodeDef {
  const names = new Set(clusterDef.value.nodes.map((n) => n.name));
  let i = 1;
  while (names.has(`worker-${i}`)) i++;
  const last = clusterDef.value.nodes.at(-1);
  const n: NodeDef = { name: `worker-${i}`, cpu: last?.cpu ?? 2000, memory: last?.memory ?? 4096 };
  clusterDef.value = { ...clusterDef.value, nodes: [...clusterDef.value.nodes, n] };
  return n;
}

export function updateNodeDef(name: string, patch: Partial<Pick<NodeDef, "cpu" | "memory">>): void {
  clusterDef.value = { ...clusterDef.value, nodes: clusterDef.value.nodes.map((n) => (n.name === name ? { ...n, ...patch } : n)) };
}

export function removeNodeDef(name: string): void {
  clusterDef.value = { ...clusterDef.value, nodes: clusterDef.value.nodes.filter((n) => n.name !== name) };
}

export function uniqueDeploymentName(base: string, kind: Manifest["kind"] = "Deployment"): string {
  const names = new Set(clusterDef.value.manifests.filter((m) => m.kind === kind).map((m) => m.metadata.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}
