// 결정론적 의사난수 (xorshift32). 코어에서 Math.random 대신 쓴다.

export class Rng {
  private s: number;

  constructor(seed = 0x2545f491) {
    this.s = seed >>> 0 || 1;
  }

  /** [0, 1) */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.s = x;
    return x / 0x1_0000_0000;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** 쿠버네티스가 이름 접미사에 쓰는 글자 (모음·헷갈리는 글자 제외 — apimachinery rand.String) */
export const NAME_ALPHABET = "bcdfghjklmnpqrstvwxz2456789";

export function randomSuffix(rng: Rng, len = 5): string {
  let s = "";
  for (let i = 0; i < len; i++) s += NAME_ALPHABET[rng.int(NAME_ALPHABET.length)];
  return s;
}

/** pod-template-hash: 템플릿 내용으로 정해지는 짧은 이름 (축소판 — 실제는 FNV-32a 를 SafeEncodeString 으로) */
export function templateHash(value: unknown): string {
  const text = stableJson(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += NAME_ALPHABET[h % NAME_ALPHABET.length];
    h = Math.floor(h / NAME_ALPHABET.length) ^ Math.imul(h, 31 + i);
    h >>>= 0;
  }
  return s;
}

/** 키 순서를 고정한 JSON (같은 내용 → 같은 문자열) */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
