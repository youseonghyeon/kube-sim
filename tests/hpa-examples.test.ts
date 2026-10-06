// 5e 예제 '자동 확장' 의 "해 볼 것" 설명이 실제 동작과 맞는지 (숫자까지).
import { describe, expect, test } from "vitest";
import { HPA_SYNC_MS, SCALE_DOWN_WINDOW_MS } from "../src/core/controllers/hpa";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { DefSync } from "../src/model/defSync";
import { exampleById, type TryAction } from "../src/model/examples";

function load(id: string) {
  const ex = exampleById(id)!;
  const s = new DefSync();
  const def = ex.build();
  s.reset(def, id);
  s.cluster.runFor(60_000);
  const action = (title: string) => ex.tries.find((t) => t.title === title)!.action as TryAction;
  return { s, c: s.cluster, def, action };
}
const replicas = (c: DefSync["cluster"]) => c.api.get("Deployment", "web")!.spec.replicas;
const hpaLine = (c: DefSync["cluster"]) => runKubectl(c, "kubectl get hpa").output;

describe("hpa-basics", () => {
  test("40/s → 4 (50% 에서 안정) → 160/s → 8 → maxReplicas 10 · TooManyReplicas → 끄면 5분 뒤 1", () => {
    const { c } = load("hpa-basics");
    expect(hpaLine(c)).toMatch(/cpu: 0%\/50%\s+1\s+10\s+1\s/);
    c.setLoad("web", 40);
    c.runFor(HPA_SYNC_MS);
    expect(replicas(c)).toBe(4);
    c.runFor(60_000);
    expect(hpaLine(c)).toContain("cpu: 50%/50%");
    expect(replicas(c)).toBe(4);
    c.setLoad("web", 160);
    c.runFor(HPA_SYNC_MS);
    expect(replicas(c)).toBe(8);
    c.runFor(60_000);
    expect(replicas(c)).toBe(10);
    expect(hpaLine(c)).toContain("cpu: 80%/50%");
    expect(runKubectl(c, "kubectl describe hpa web").output).toMatch(/ScalingLimited\s+True\s+TooManyReplicas/);
    c.setLoad("web", 0);
    c.runFor(SCALE_DOWN_WINDOW_MS - 30_000);
    expect(replicas(c)).toBe(10);
    expect(c.api.get("HorizontalPodAutoscaler", "web")!.status.conditions.find((x) => x.type === "AbleToScale")!.reason).toBe("ScaleDownStabilized");
    c.runFor(60_000);
    expect(replicas(c)).toBe(1);
  });
});

describe("hpa-no-requests", () => {
  test("<unknown> 에 부하가 와도 1 → requests 를 apply 하면 늘어난다", () => {
    const { s, c, def, action } = load("hpa-no-requests");
    expect(hpaLine(c)).toContain("cpu: <unknown>/50%");
    c.setLoad("web", 40);
    c.runFor(60_000);
    expect(replicas(c)).toBe(1);
    expect(runKubectl(c, "kubectl describe hpa web").output).toMatch(/ScalingActive\s+False\s+FailedGetResourceMetric/);
    const a = action("requests 주기");
    if (a.type !== "apply") throw new Error("apply 여야 함");
    def.manifests = [...def.manifests.filter((m) => !(m.kind === "Deployment" && m.metadata.name === "web")), structuredClone(a.manifest)];
    s.sync(def);
    c.runFor(90_000);
    expect(hpaLine(c)).toMatch(/cpu: \d+%\/50%/);
    expect(replicas(c)).toBeGreaterThan(1);
  });
});

describe("hpa-gitops", () => {
  test("Git replicas 와 HPA 가 번갈아 고치다가, replicas 를 뺀 커밋 + refresh 뒤로는 Synced · HPA 값 유지", () => {
    const { c, action } = load("hpa-gitops");
    c.setLoad("web", 40);
    const from = c.trace.events.length;
    c.runFor(120_000);
    const ev = c.trace.events.slice(from);
    expect(ev.filter((e) => e.actor === "horizontal-pod-autoscaler" && /replicas 1 → 4/.test(e.msg)).length).toBeGreaterThanOrEqual(2);
    expect(ev.filter((e) => e.kind === "gitops.selfheal").length).toBeGreaterThanOrEqual(2);
    const a = action("Git 에서 replicas 빼기");
    if (a.type !== "git-commit") throw new Error("git-commit 이어야 함");
    expect("replicas" in (a.manifest as { spec: object }).spec).toBe(false);
    const head = c.git.get(a.repo)!.head!;
    c.gitCommit(a.repo, { ...structuredClone(head.files), [a.file]: structuredClone(a.manifest) }, a.message);
    runArgocd(c, "argocd app get web --refresh");
    c.runFor(90_000);
    const settled = c.trace.events.length;
    c.runFor(120_000);
    expect(c.trace.events.slice(settled).filter((e) => e.kind === "gitops.selfheal")).toHaveLength(0);
    expect(replicas(c)).toBe(4);
    expect(c.api.get("Application", "web", "argocd")!.status.sync.status).toBe("Synced");
    expect(runArgocd(c, "argocd app diff web").ok).toBe(true);
  });
});
