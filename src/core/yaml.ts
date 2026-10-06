// 오브젝트 → YAML 텍스트 (인스펙터의 YAML 탭). 읽기 전용 표시용이라 단순하게.
// 코어는 cpu 를 millicore, memory 를 MiB 숫자로 다루지만, 화면의 YAML 은 실제 매니페스트처럼 250m · 128Mi 로 쓴다.
import { fmtCpu, fmtMem } from "./units";

const RESOURCE_KEYS = new Set(["requests", "limits", "capacity", "allocatable"]);

export function toYaml(v: unknown): string {
  return render(withUnits(v), 0);
}

/** requests·capacity 같은 자원 묶음의 cpu·memory 숫자를 실제 표기 문자열로 */
function withUnits(v: unknown, key?: string): unknown {
  if (Array.isArray(v)) return v.map((x) => withUnits(x));
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (key !== undefined && RESOURCE_KEYS.has(key) && typeof x === "number") out[k] = k === "cpu" ? fmtCpu(x) : k === "memory" ? fmtMem(x) : String(x);
    else out[k] = withUnits(x, k);
  }
  return out;
}

function render(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return v
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
          const body = render(item, indent + 1).replace(/^\s+/, "");
          return `${pad}- ${body}`;
        }
        return `${pad}- ${scalar(item)}`;
      })
      .join("\n");
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (!entries.length) return "{}";
    return entries
      .map(([k, x]) => {
        if (x !== null && typeof x === "object") {
          const empty = Array.isArray(x) ? !x.length : !Object.keys(x).length;
          if (empty) return `${pad}${k}: ${Array.isArray(x) ? "[]" : "{}"}`;
          return `${pad}${k}:\n${render(x, Array.isArray(x) ? indent : indent + 1)}`;
        }
        return `${pad}${k}: ${scalar(x)}`;
      })
      .join("\n");
  }
  return pad + scalar(v);
}

function scalar(x: unknown): string {
  if (typeof x === "string") return /^[\w./-][\w./:@=+-]*$/.test(x) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(x) && !/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(x) ? x : JSON.stringify(x);
  return String(x);
}
