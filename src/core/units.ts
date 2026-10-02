// 자원 단위 표기 (kubectl 과 같은 모양). cpu 는 millicore, memory 는 MiB 로 다룬다.

export function fmtCpu(m: number): string {
  return m % 1000 === 0 ? String(m / 1000) : `${m}m`;
}

export function fmtMem(mi: number): string {
  return mi % 1024 === 0 && mi > 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

/** "500m" · "1" · "1.5" → millicore. 잘못되면 undefined */
export function parseCpu(s: string): number | undefined {
  const t = s.trim();
  const m = /^(\d+)m$/.exec(t);
  if (m) return Number(m[1]);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  return undefined;
}

/** "256Mi" · "1Gi" → MiB. 잘못되면 undefined */
export function parseMem(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi)$/.exec(s.trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * (m[2] === "Gi" ? 1024 : 1));
}

/** kubectl 의 AGE 칸 (apimachinery HumanDuration): 90s · 2m10s · 15m · 3h5m · 30h · 2d */
export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** 로그의 시각: 0:12.3 */
export function fmtClock(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
