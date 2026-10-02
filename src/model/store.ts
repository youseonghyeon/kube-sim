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
}
const ui = load<UiPrefs>(UI_KEY);
export const drawerOpen = signal(ui?.drawerOpen ?? true);
export const drawerTab = signal<UiPrefs["drawerTab"]>(ui?.drawerTab ?? "log");
/** 로그에 API 서버 쓰기(api.*) 줄도 보일지 */
export const showApi = signal(ui?.showApi ?? false);
/** 로그에서 고른 오브젝트에 관한 줄만 */
export const logOnlySelected = signal(false);

effect(() => save(DEF_KEY, { exampleId: exampleId.value, def: clusterDef.value } satisfies Saved));
effect(() => {
  save(THEME_KEY, theme.value);
  if (typeof document !== "undefined") document.documentElement.dataset.theme = theme.value;
});
effect(() => save(UI_KEY, { drawerOpen: drawerOpen.value, drawerTab: drawerTab.value, showApi: showApi.value } satisfies UiPrefs));

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
