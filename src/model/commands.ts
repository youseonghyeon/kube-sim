// kubectl 창에 친 한 줄을 알맞은 도구로 보낸다: curl … = 클러스터 밖에서, argocd … · git … = 그 CLI 흉내, 나머지는 kubectl.
// 화면(sim.ts)과 테스트가 같은 길을 쓴다.
import type { Cluster } from "../core/cluster";
import { runArgocd, runGit } from "../core/gitops/cli";
import { curlTarget, runKubectl, type KubectlResult } from "../core/kubectl";

export type CommandKind = "kubectl" | "curl" | "argocd" | "git";

export function commandKind(line: string): CommandKind {
  const t = line.trim();
  if (curlTarget(t) !== undefined) return "curl";
  if (/^argocd(\s|$)/.test(t)) return "argocd";
  if (/^git(\s|$)/.test(t)) return "git";
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
    default:
      return runKubectl(c, line);
  }
}
