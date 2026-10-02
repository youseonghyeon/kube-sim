// 오브젝트 → YAML 텍스트 (인스펙터의 YAML 탭). 읽기 전용 표시용이라 단순하게.

export function toYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    return v
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length) {
          const body = toYaml(item, indent + 1).replace(/^\s+/, "");
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
          return `${pad}${k}:\n${toYaml(x, Array.isArray(x) ? indent : indent + 1)}`;
        }
        return `${pad}${k}: ${scalar(x)}`;
      })
      .join("\n");
  }
  return pad + scalar(v);
}

function scalar(x: unknown): string {
  if (typeof x === "string") return /^[\w./-][\w./:@-]*$/.test(x) && !/^(true|false|null|\d.*)$/.test(x) ? x : JSON.stringify(x);
  return String(x);
}
