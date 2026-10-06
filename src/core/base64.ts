// Secret 의 data 는 base64 (암호화가 아니다). UTF-8 글자도 그대로 오가게 TextEncoder 를 거친다 (브라우저·Node 모두 전역에 있음).

export function b64encode(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** 잘못된 base64 면 undefined */
export function b64decode(s: string): string | undefined {
  try {
    const bin = atob(s.trim());
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

/** 올바른 base64 인가 (바이트는 무엇이든 — Secret 의 data 는 UTF-8 이 아니어도 된다) */
export function isBase64(s: string): boolean {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return false;
  try {
    atob(s);
    return true;
  } catch {
    return false;
  }
}

/** base64 가 담은 바이트 수 (describe secret 의 "N bytes") */
export function b64bytes(s: string): number {
  try {
    return atob(s).length;
  } catch {
    return 0;
  }
}
