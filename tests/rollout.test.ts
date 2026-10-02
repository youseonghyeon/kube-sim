import { describe, expect, test } from "vitest";
import { deployment, type DeploymentManifest } from "../src/core/cluster";
import { HASH_LABEL, revisionOf } from "../src/core/controllers/deployment";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);
const alive = (c: ReturnType<typeof cluster>) => pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
const readyCount = (c: ReturnType<typeof cluster>) => alive(c).filter((p) => p.status.conditions.find((x) => x.type === "Ready")?.status === "True").length;

function api(image: string, replicas = 4): DeploymentManifest {
  return deployment("api", { replicas, image, cpu: 100, memory: 64, port: 8080, readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 2 } });
}

describe("RollingUpdate (기본 25%/25%)", () => {
  test("replicas 4: 전체 Pod 는 5개(maxSurge 1)를 넘지 않고, Ready 는 3개(maxUnavailable 1) 밑으로 떨어지지 않는다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 4, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.runFor(15_000);
    expect(readyCount(c)).toBe(4);
    k(c, "set image deployment/web web=nginx:1.28");
    let maxAlive = 0;
    let minReady = 4;
    for (let t = 0; t < 30_000; t += 50) {
      c.runFor(50);
      maxAlive = Math.max(maxAlive, alive(c).length);
      minReady = Math.min(minReady, readyCount(c));
    }
    expect(maxAlive).toBeLessThanOrEqual(5);
    expect(minReady).toBeGreaterThanOrEqual(3);
    expect(alive(c).map((p) => p.spec.containers[0]!.image)).toEqual(Array(4).fill("nginx:1.28"));
    expect(k(c, "rollout status deployment/web").output).toBe('deployment "web" successfully rolled out');
    expect(k(c, "rollout history deployment/web").output).toBe("deployment.apps/web \nREVISION   CHANGE-CAUSE\n1          <none>\n2          <none>");
    const d = c.api.get("Deployment", "web")!;
    expect(d.metadata.annotations?.["deployment.kubernetes.io/revision"]).toBe("2");
    expect(d.status.conditions?.find((x) => x.type === "Progressing")?.reason).toBe("NewReplicaSetAvailable");
    expect(k(c, "describe deployment web").output).toMatch(/RollingUpdateStrategy:\s+25% max unavailable, 25% max surge/);
    expect(k(c, "describe deployment web").output).toMatch(/OldReplicaSets:\s+<none>/);
  });

  test("새 버전이 Ready 가 안 되면 롤아웃이 멈추고(옛 Pod 3개가 계속 서비스), undo 로 되돌린다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(api("example/api:1.1"));
    c.runFor(20_000);
    expect(readyCount(c)).toBe(4);
    c.apply(api("example/api:2.0"));
    c.runFor(60_000);
    const imgs = (img: string) => alive(c).filter((p) => p.spec.containers[0]!.image === img).length;
    expect(imgs("example/api:2.0")).toBe(2); // maxSurge 1 + 줄인 옛 1 자리
    expect(imgs("example/api:1.1")).toBe(3);
    expect(readyCount(c)).toBe(3);
    expect(k(c, "rollout status deployment/api").output.split("\n")[0]).toBe('Waiting for deployment "api" rollout to finish: 2 out of 4 new replicas have been updated...');
    // 600초 동안 진전 없음 → ProgressDeadlineExceeded (되돌리지는 않음)
    c.runFor(600_000);
    expect(k(c, "rollout status deployment/api").output).toBe('error: deployment "api" exceeded its progress deadline');
    expect(imgs("example/api:2.0")).toBe(2);
    expect(k(c, "rollout undo deployment/api").output).toBe("deployment.apps/api rolled back");
    c.runFor(40_000);
    expect(alive(c).map((p) => p.spec.containers[0]!.image)).toEqual(Array(4).fill("example/api:1.1"));
    // 옛 RS 를 다시 쓰고 리비전을 맨 위로 (1 → 3)
    const revs = c.api.list("ReplicaSet").map((r) => `${r.spec.template.spec.containers[0]!.image}:${revisionOf(r)}`).sort();
    expect(revs).toEqual(["example/api:1.1:3", "example/api:2.0:2"]);
    expect(k(c, "rollout status deployment/api").output).toBe('deployment "api" successfully rolled out');
  });

  test("Recreate: 옛 Pod 가 모두 사라진 뒤에야 새 Pod 를 만든다 (그사이 Ready 0)", () => {
    const c = cluster([{ name: "w1" }]);
    const m = deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 100, memory: 64 });
    m.spec.strategy = { type: "Recreate" };
    c.apply(m);
    c.runFor(15_000);
    const next = structuredClone(m);
    next.spec.template.spec.containers[0]!.image = "nginx:1.28";
    c.apply(next);
    let sawZero = false;
    for (let t = 0; t < 20_000; t += 50) {
      c.runFor(50);
      const imgs = new Set(alive(c).map((p) => p.spec.containers[0]!.image));
      expect(imgs.size).toBeLessThanOrEqual(1); // 옛·새가 섞이지 않는다
      if (readyCount(c) === 0) sawZero = true;
    }
    expect(sawZero).toBe(true);
    expect(alive(c).map((p) => p.spec.containers[0]!.image)).toEqual(Array(3).fill("nginx:1.28"));
  });

  test("rollout restart: 템플릿에 restartedAt 이 붙어 새 RS 로 모두 교체", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.runFor(10_000);
    const before = alive(c).map((p) => p.metadata.name);
    expect(k(c, "rollout restart deployment/web").output).toBe("deployment.apps/web restarted");
    c.runFor(30_000);
    expect(alive(c).map((p) => p.metadata.name).some((n) => before.includes(n))).toBe(false);
    expect(c.api.list("ReplicaSet")).toHaveLength(2);
  });

  test("revisionHistoryLimit(10)을 넘는 옛 RS 는 지운다", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.runFor(10_000);
    for (let i = 0; i < 13; i++) {
      k(c, "rollout restart deployment/web");
      c.runFor(20_000);
    }
    const rss = c.api.list("ReplicaSet");
    expect(rss).toHaveLength(11);
    expect(Math.min(...rss.map(revisionOf))).toBe(4);
  });

  test("롤아웃이 끝난 뒤 replicas 만 바꾸면 새 RS 를 바로 맞춘다 (새 RS 없음)", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.runFor(10_000);
    k(c, "scale deployment/web --replicas=6");
    c.runFor(10_000);
    expect(c.api.list("ReplicaSet")).toHaveLength(1);
    expect(alive(c)).toHaveLength(6);
    expect(c.api.list("ReplicaSet")[0]!.metadata.labels[HASH_LABEL]).toBeDefined();
  });

  test("undo 할 이력이 없으면 실제 문구", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.runFor(5000);
    expect(k(c, "rollout undo deployment/web").output).toBe('error: no rollout history found for deployment "web"');
  });
});
