// kubectl 창에 친 한 줄을 알맞은 도구로 보낸다: curl … = 클러스터 밖에서, argocd … · git … = 그 CLI 흉내, 나머지는 kubectl.
// 화면(sim.ts)과 테스트가 같은 길을 쓴다.
import type { Cluster } from "../core/cluster";
import { runArgocd, runGit } from "../core/gitops/cli";
import { curlTarget, runKubectl, type KubectlResult } from "../core/kubectl";
import { b64decode } from "../core/base64";

export type CommandKind = "kubectl" | "curl" | "argocd" | "git" | "base64";

/** echo <값> | base64 -d (Secret 의 data 풀어 보기) */
const BASE64_RE = /^echo\s+(?:-n\s+)?(['"]?)([A-Za-z0-9+/=]*)\1\s*\|\s*base64\s+(?:-d|--decode)\s*$/;

export function commandKind(line: string): CommandKind {
  const t = line.trim();
  if (curlTarget(t) !== undefined) return "curl";
  if (/^argocd(\s|$)/.test(t)) return "argocd";
  if (/^git(\s|$)/.test(t)) return "git";
  if (/^echo\s.*\|\s*base64\b/.test(t)) return "base64";
  return "kubectl";
}

export function runCommand(c: Cluster, line: string): KubectlResult {
  switch (commandKind(line)) {
    case "curl": {
      const r = c.requestExternal(curlTarget(line)!);
      return { ok: r.ok, output: r.output, mutated: true, net: r };
    }
    case "argocd":
      return runArgocd(c, line);
    case "git":
      return runGit(c, line);
    case "base64": {
      const m = BASE64_RE.exec(line.trim());
      const out = m ? b64decode(m[2]!) : undefined;
      return out === undefined
        ? { ok: false, output: "base64: invalid input\n(echo <base64 값> | base64 -d 처럼 쓰세요 — kubectl get secret <이름> -o yaml 의 data 값)", mutated: false }
        : { ok: true, output: out, mutated: false };
    }
    default:
      return runKubectl(c, line);
  }
}
