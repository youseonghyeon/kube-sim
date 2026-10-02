import { describe, expect, test } from "vitest";
import { application, deployment, service, type Manifest } from "../src/core/cluster";
import { POLL_MS, SELF_HEAL_MS } from "../src/core/gitops/argocd";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const REPO = "https://github.com/youseonghyeon/net-sim.git";
function files(tag: string, replicas = 1, withSvc = true): Record<string, Manifest> {
  const out: Record<string, Manifest> = { "deploy/deployment.yaml": deployment("net-sim", { replicas, image: `ghcr.io/youseonghyeon/net-sim:${tag}`, cpu: 10, memory: 16, port: 8080 }) };
  if (withSvc) out["deploy/service.yaml"] = service("net-sim", { selector: { app: "net-sim" }, port: 8080 });
  return out;
}
function setup(automated?: { prune: boolean; selfHeal: boolean }) {
  const c = cluster([{ name: "w1" }, { name: "w2" }]);
  c.gitCommit(REPO, files("aaa111"), "first");
  c.apply(application("net-sim", { repoURL: REPO, path: "deploy", automated }));
  c.runFor(15_000);
  return c;
}
const app = (c: ReturnType<typeof cluster>) => c.api.get("Application", "net-sim", "argocd")!;
const live = (c: ReturnType<typeof cluster>) => c.api.get("Deployment", "net-sim")!;

describe("Argo CD", () => {
  test("자동 sync: 처음 만들면 Git 대로 배포되고 Synced/Healthy", () => {
    const c = setup({ prune: true, selfHeal: true });
    expect(app(c).status.sync.status).toBe("Synced");
    expect(app(c).status.health.status).toBe("Healthy");
    expect(live(c).metadata.labels["app.kubernetes.io/instance"]).toBe("net-sim");
    expect(runKubectl(c, "get applications -n argocd").output).toMatch(/^NAME\s+SYNC STATUS\s+HEALTH STATUS\nnet-sim\s+Synced\s+Healthy$/);
    expect(runArgocd(c, "argocd app get net-sim").output).toMatch(/Sync Status:\s+Synced to main \([0-9a-f]{7}\)\nHealth Status:\s+Healthy/);
  });

  test("selfHeal: kubectl 로 바꾸면 곧 OutOfSync → 5초 뒤 되돌린다", () => {
    const c = setup({ prune: true, selfHeal: true });
    runKubectl(c, "scale deployment/net-sim --replicas=3");
    c.runFor(1000);
    expect(app(c).status.sync.status).toBe("OutOfSync");
    expect(live(c).spec.replicas).toBe(3);
    c.runFor(SELF_HEAL_MS);
    expect(live(c).spec.replicas).toBe(1);
    c.runFor(15_000);
    expect(app(c).status.sync.status).toBe("Synced");
    expect(c.trace.events.some((e) => e.kind === "gitops.selfheal")).toBe(true);
  });

  test("selfHeal 이 꺼져 있으면 드리프트는 OutOfSync 로 남고, diff 로 보이고, 수동 sync 로 되돌린다", () => {
    const c = setup({ prune: true, selfHeal: false });
    runKubectl(c, "scale deployment/net-sim --replicas=3");
    c.runFor(60_000);
    expect(app(c).status.sync.status).toBe("OutOfSync");
    expect(live(c).spec.replicas).toBe(3);
    const d = runArgocd(c, "argocd app diff net-sim");
    expect(d.ok).toBe(false);
    expect(d.output).toContain("===== apps/Deployment default/net-sim ======");
    expect(d.output).toContain("< spec.replicas: 3");
    expect(d.output).toContain("> spec.replicas: 1");
    runArgocd(c, "argocd app sync net-sim");
    c.runFor(5000);
    expect(live(c).spec.replicas).toBe(1);
    expect(app(c).status.sync.status).toBe("Synced");
  });

  test("Git 에 push 해도 바로 안 바뀐다 — 3분 폴링(또는 Refresh) 뒤 자동 sync → 롤아웃", () => {
    const c = setup({ prune: true, selfHeal: true });
    const first = app(c).status.sync.revision;
    c.gitCommit(REPO, files("bbb222"), "ci: bump image tag to bbb222", "github-actions");
    c.runFor(30_000);
    expect(app(c).status.sync.revision).toBe(first); // 아직 모름
    expect(live(c).spec.template.spec.containers[0]!.image).toContain("aaa111");
    c.runFor(POLL_MS);
    expect(app(c).status.sync.revision).not.toBe(first);
    expect(live(c).spec.template.spec.containers[0]!.image).toContain("bbb222");
    c.runFor(30_000);
    expect(pods(c).every((p) => p.spec.containers[0]!.image.endsWith("bbb222"))).toBe(true);
    expect(runArgocd(c, "argocd app history net-sim").output.split("\n").length).toBe(4); // SOURCE + 머리 + 2줄
  });

  test("Refresh 하면 폴링을 기다리지 않는다", () => {
    const c = setup({ prune: true, selfHeal: true });
    c.gitCommit(REPO, files("ccc333"), "change");
    runArgocd(c, "argocd app get net-sim --refresh");
    c.runFor(2000);
    expect(live(c).spec.template.spec.containers[0]!.image).toContain("ccc333");
  });

  test("prune: Git 에서 지운 Service 는 prune 이 켜져 있으면 지우고, 꺼져 있으면 남겨 OutOfSync", () => {
    const a = setup({ prune: true, selfHeal: true });
    a.gitCommit(REPO, files("aaa111", 1, false), "remove service");
    a.argocd.refresh("net-sim");
    a.runFor(2000);
    expect(a.api.get("Service", "net-sim")).toBeUndefined();
    const b = setup({ prune: false, selfHeal: true });
    b.gitCommit(REPO, files("aaa111", 1, false), "remove service");
    b.argocd.refresh("net-sim");
    b.runFor(2000);
    expect(b.api.get("Service", "net-sim")).toBeDefined();
    expect(app(b).status.sync.status).toBe("OutOfSync");
    expect(app(b).status.resources.find((r) => r.kind === "Service")?.requiresPruning).toBe(true);
    runArgocd(b, "argocd app sync net-sim --prune");
    b.runFor(2000);
    expect(b.api.get("Service", "net-sim")).toBeUndefined();
    expect(app(b).status.sync.status).toBe("Synced");
  });

  test("수동(Manual) 정책: 새 커밋을 봐도 OutOfSync 로 기다린다", () => {
    const c = setup(undefined);
    expect(app(c).status.sync.status).toBe("OutOfSync"); // 처음엔 아무것도 배포되지 않음
    expect(c.api.get("Deployment", "net-sim")).toBeUndefined();
    runArgocd(c, "argocd app sync net-sim");
    c.runFor(10_000);
    expect(app(c).status.sync.status).toBe("Synced");
  });

  test("runToIdle 이 끝난다 (Git 폴링은 배경 타이머)", () => {
    const c = setup({ prune: true, selfHeal: true });
    c.runToIdle();
    expect(c.clock.peekNextTime()).toBeUndefined();
  });

  test("argocd app set 으로 selfHeal 끄기", () => {
    const c = setup({ prune: true, selfHeal: true });
    runArgocd(c, "argocd app set net-sim --self-heal=false");
    expect(app(c).spec.syncPolicy?.automated).toEqual({ prune: true, selfHeal: false });
    runArgocd(c, "argocd app set net-sim --sync-policy none");
    expect(app(c).spec.syncPolicy).toBeUndefined();
  });
});
