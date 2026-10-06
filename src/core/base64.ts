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
