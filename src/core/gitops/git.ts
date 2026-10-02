// Git 저장소 흉내: 커밋마다 파일(경로 → 매니페스트) 전체를 들고 있다. 브랜치는 main 하나.
// 축소판: Helm 차트는 렌더링된 매니페스트로 저장소에 있다고 본다(values.yaml 의 태그를 바꾸면 = Deployment 의 image 가 바뀐 매니페스트).
import type { Manifest } from "../cluster";
import { stableJson } from "../rng";

export interface Commit {
  sha: string;
  message: string;
  author: string;
  /** 시뮬레이션 시각 */
  time: number;
  /** 경로 → 매니페스트 (예: deploy/deployment.yaml) */
  files: Record<string, Manifest>;
}

export class GitRepo {
  readonly commits: Commit[] = [];

  constructor(
    readonly url: string,
    readonly branch = "main",
  ) {}

  get head(): Commit | undefined {
    return this.commits.at(-1);
  }

  /** 커밋 하나 (파일 전체를 새로 준다) */
  commit(files: Record<string, Manifest>, message: string, author: string, time: number): Commit {
    const parent = this.head?.sha ?? "";
    const c: Commit = { sha: sha40(`${parent}|${message}|${author}|${time}|${stableJson(files)}|${this.commits.length}`), message, author, time, files: structuredClone(files) };
    this.commits.push(c);
    return c;
  }

  /** path 아래의 매니페스트 (Argo CD 가 읽는 것) */
  manifestsAt(sha: string, path: string): Manifest[] {
    const c = this.commits.find((x) => x.sha === sha);
    if (!c) return [];
    const prefix = path.replace(/\/$/, "") + "/";
    return Object.entries(c.files)
      .filter(([p]) => p.startsWith(prefix))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, m]) => structuredClone(m));
  }

  /** git log --oneline */
  log(): string {
    return [...this.commits]
      .reverse()
      .map((c, i) => `${c.sha.slice(0, 7)} ${i === 0 ? `(HEAD -> ${this.branch}, origin/${this.branch}) ` : ""}${c.message}`)
      .join("\n");
  }
}

/** 커밋 해시처럼 보이는 40자 16진수 (내용으로 정해짐 — 결정론) */
function sha40(s: string): string {
  let out = "";
  let h = 0x811c9dc5;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ (round * 0x9e3779b9), 0x85ebca6b) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}
