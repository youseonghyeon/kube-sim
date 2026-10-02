// argocd·git CLI 흉내 (kubectl 창에서 argocd … / git … 로 친다). 실제 출력 모양을 따른다 (축소판: 자주 쓰는 하위 명령만).
import type { Application } from "../api/types";
import type { Cluster } from "../cluster";
import { table, type KubectlResult } from "../kubectl";
import { fmtClock } from "../units";
import { ARGO_NS, describeDiff } from "./argocd";

export const ARGOCD_HELP = [
  "argocd (축소판):",
  "  argocd app list",
  "  argocd app get <앱> [--refresh]",
  "  argocd app diff <앱>",
  "  argocd app sync <앱> [--prune]",
  "  argocd app history <앱>",
  "  argocd app set <앱> --sync-policy automated|none [--auto-prune[=false]] [--self-heal[=false]]",
  "git (축소판): git log --oneline",
].join("\n");

function ok(output: string, mutated = false): KubectlResult {
  return { ok: true, output, mutated };
}

function fail(output: string): KubectlResult {
  return { ok: false, output, mutated: false };
}

export function runArgocd(c: Cluster, line: string): KubectlResult {
  const args = line.trim().split(/\s+/).slice(1);
  if (args[0] !== "app" && args[0] !== "apps") return fail(`${ARGOCD_HELP}`);
  const sub = args[1];
  const name = args[2]?.replace(/^argocd\//, "");
  const flags = args.slice(3);
  const has = (f: string) => flags.some((x) => x === f || x.startsWith(`${f}=`));
  const boolFlag = (f: string) => {
    const x = flags.find((a) => a === f || a.startsWith(`${f}=`));
    return x === undefined ? undefined : x.includes("=") ? x.split("=")[1] !== "false" : true;
  };
  if (sub === "list") return ok(appList(c));
  if (!sub || !["get", "diff", "sync", "history", "set"].includes(sub)) return fail(ARGOCD_HELP);
  if (!name) return fail(`argocd app ${sub}: 앱 이름이 필요합니다. 예: argocd app ${sub} net-sim`);
  const app = c.api.get("Application", name, ARGO_NS);
  if (!app) return fail(`FATA[0000] rpc error: code = NotFound desc = applications.argoproj.io "${name}" not found`);
  c.trace.add("user", "user", `argocd app ${sub} ${name}${flags.length ? ` ${flags.join(" ")}` : ""}`, { kind: "Application", namespace: ARGO_NS, name });
  switch (sub) {
    case "get":
      if (has("--refresh") || has("--hard-refresh")) {
        c.argocd.refresh(name);
        c.runFor(0);
      }
      return ok(appGet(c, c.api.get("Application", name, ARGO_NS)!), true);
    case "diff": {
      const diffs = c.argocd.diffs(name);
      if (!diffs.length) return ok("");
      return {
        ok: false, // 실제처럼 차이가 있으면 종료 코드 1
        mutated: false,
        output: diffs
          .map((d) => `===== ${groupOf(d.kind)}/${d.kind} default/${d.name} ======\n${d.lines.map((l) => {
            const m = /^(.*): Git (.*) · 라이브 (.*)$/.exec(l);
            return m ? `< ${m[1]}: ${m[3]}   (라이브)\n> ${m[1]}: ${m[2]}   (Git)` : `  ${l}`;
          }).join("\n")}`)
          .join("\n\n"),
      };
    }
    case "sync": {
      const r = c.argocd.sync(name, { prune: has("--prune"), actor: "argocd" });
      c.runFor(0);
      const now = c.api.get("Application", name, ARGO_NS)!;
      return {
        ok: r.ok,
        mutated: true,
        output: `${r.lines.map((l) => `${fmtClock(c.now)}  ${l}`).join("\n")}\n\n${appGet(c, now)}\n\nOperation:          Sync\nSync Revision:      ${now.status.operationState?.syncResult?.revision ?? ""}\nPhase:              ${now.status.operationState?.phase ?? ""}\nMessage:            ${r.message}`,
      };
    }
    case "history":
      return ok(
        `SOURCE  ${app.spec.source.repoURL}\n${table(
          ["ID", "DATE", "REVISION"],
          app.status.history.map((h) => [String(h.id), `${fmtClock(h.deployedAt)} (시뮬레이션 시각)`, `${app.spec.source.targetRevision} (${h.revision.slice(0, 7)})`]),
        )}`,
      );
    default: {
      // set
      const policy = flags[flags.indexOf("--sync-policy") + 1];
      const prune = boolFlag("--auto-prune");
      const heal = boolFlag("--self-heal");
      if (has("--sync-policy") && policy !== "automated" && policy !== "auto" && policy !== "none") return fail(`FATA[0000] Invalid sync policy "${policy}" — automated 또는 none`);
      const willBeAuto = policy === "automated" || policy === "auto" || (policy !== "none" && !!app.spec.syncPolicy?.automated);
      if ((prune !== undefined || heal !== undefined) && !willBeAuto) return fail("FATA[0000] Cannot set --self-heal or --auto-prune: application not configured with automatic sync (--sync-policy automated 를 먼저)");
      c.api.patch("Application", name, ARGO_NS, "argocd", (o) => {
        if (policy === "none") delete o.spec.syncPolicy;
        else {
          if (policy === "automated" || policy === "auto" || prune !== undefined || heal !== undefined) {
            const cur = o.spec.syncPolicy?.automated;
            if (!cur && policy !== "automated" && policy !== "auto") return; // 자동이 아닌데 prune·selfHeal 만 바꾸면 의미 없음
            o.spec.syncPolicy = { automated: { prune: prune ?? cur?.prune ?? false, selfHeal: heal ?? cur?.selfHeal ?? false } };
          }
        }
      });
      return ok("", true);
    }
  }
}

function groupOf(kind: string): string {
  return kind === "Deployment" ? "apps" : kind === "Ingress" ? "networking.k8s.io" : kind === "PodDisruptionBudget" ? "policy" : "";
}

function policyText(app: Application): string {
  const a = app.spec.syncPolicy?.automated;
  if (!a) return "Manual";
  return `Automated${a.prune ? " (Prune)" : ""}${a.selfHeal ? "" : " — selfHeal 꺼짐"}`;
}

function appList(c: Cluster): string {
  const apps = c.api.list("Application", ARGO_NS);
  if (!apps.length) return "NAME  CLUSTER  NAMESPACE  PROJECT  STATUS  HEALTH  SYNCPOLICY  CONDITIONS  REPO  PATH  TARGET";
  return table(
    ["NAME", "CLUSTER", "NAMESPACE", "PROJECT", "STATUS", "HEALTH", "SYNCPOLICY", "CONDITIONS", "REPO", "PATH", "TARGET"],
    apps.map((a) => [
      `argocd/${a.metadata.name}`,
      a.spec.destination.server,
      a.spec.destination.namespace,
      a.spec.project,
      a.status.sync.status,
      a.status.health.status,
      a.spec.syncPolicy?.automated ? (a.spec.syncPolicy.automated.prune ? "Auto-Prune" : "Auto") : "<none>",
      "<none>",
      a.spec.source.repoURL,
      a.spec.source.path,
      a.spec.source.targetRevision,
    ]),
  );
}

export function appGet(c: Cluster, app: Application): string {
  const rev = app.status.sync.revision;
  const head = [
    `Name:               argocd/${app.metadata.name}`,
    `Project:            ${app.spec.project}`,
    `Server:             ${app.spec.destination.server}`,
    `Namespace:          ${app.spec.destination.namespace}`,
    "Source:",
    `- Repo:             ${app.spec.source.repoURL}`,
    `  Target:           ${app.spec.source.targetRevision}`,
    `  Path:             ${app.spec.source.path}`,
    "SyncWindow:         Sync Allowed",
    `Sync Policy:        ${policyText(app)}`,
    `Sync Status:        ${app.status.sync.status}${rev ? ` ${app.status.sync.status === "OutOfSync" ? "from" : "to"} ${app.spec.source.targetRevision} (${rev.slice(0, 7)})` : ""}`,
    `Health Status:      ${app.status.health.status}`,
  ].join("\n");
  const rows = app.status.resources.map((r) => [
    groupOf(r.kind),
    r.kind,
    "default",
    r.name,
    r.status,
    r.health ?? "",
    "",
    r.requiresPruning ? "ignored (requires pruning)" : "",
  ]);
  const diffs = c.argocd.diffs(app.metadata.name);
  return `${head}\n\n${table(["GROUP", "KIND", "NAMESPACE", "NAME", "STATUS", "HEALTH", "HOOK", "MESSAGE"], rows)}${
    diffs.length ? `\n\n(축소판 메모 — 다른 곳: ${diffs.map(describeDiff).join(" / ")})` : ""
  }`;
}

export function runGit(c: Cluster, line: string): KubectlResult {
  const args = line.trim().split(/\s+/).slice(1);
  const repo = [...c.git.values()][0];
  if (!repo) return fail("fatal: not a git repository (or any of the parent directories): .git");
  if (args[0] === "log") return ok(repo.log());
  return fail(`git: '${args[0] ?? ""}' 는 이 시뮬레이터에 없습니다 (git log --oneline 만). 커밋은 Git 상자를 골라 인스펙터에서 합니다`);
}

