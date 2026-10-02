import { describe, expect, test } from "vitest";
import { Clock } from "../src/core/clock";
import { DefSync } from "../src/model/defSync";
import { EXAMPLES, resolveCommand } from "../src/model/examples";
import { advanceClock } from "../src/model/simClock";
import { runKubectl } from "../src/core/kubectl";

describe("화면 시계", () => {
  test("할 일이 있을 때만 재생 속도로 흐르고, 없으면 멈춘다", () => {
    const c = new Clock();
    expect(advanceClock(c, 16, 1)).toBeNull();
    let fired = false;
    c.after(1000, "x", () => (fired = true));
    const r = advanceClock(c, 500, 1)!;
    expect(r.time).toBe(500);
    expect(fired).toBe(false);
    advanceClock(c, 600, 1);
    expect(fired).toBe(true);
    expect(c.now).toBe(1100);
    expect(advanceClock(c, 16, 1)).toBeNull();
    expect(c.now).toBe(1100);
  });

  test("배경 타이머만 남으면 멈춘다", () => {
    const c = new Clock();
    c.background(100, "hb", () => {});
    expect(advanceClock(c, 16, 1)).toBeNull();
  });

  test("폭주하면 burst 로 알린다", () => {
    const c = new Clock();
    const loop = () => c.after(0, "loop", loop);
    loop();
    expect(advanceClock(c, 16, 1, 50)).toMatchObject({ burst: true });
  });
});

describe("예제", () => {
  for (const ex of EXAMPLES) {
    test(`${ex.id}: 불러와서 2분 돌려도 오류 없이 돌고, 해 볼 것의 명령이 모두 실행된다`, () => {
      const s = new DefSync();
      s.reset(ex.build(), `예제 ${ex.title}`);
      s.cluster.runFor(120_000);
      for (const t of ex.tries) {
        if (!t.command) continue;
        const r = runKubectl(s.cluster, resolveCommand(s.cluster.api.list("Pod"), t.command)!);
        expect(r.ok, `${t.command}\n${r.output}`).toBe(true);
        s.cluster.runFor(60_000);
      }
    });
  }

  test("pending 예제는 처음에 Pending 하나, FailedScheduling 이 보인다", () => {
    const s = new DefSync();
    s.reset(EXAMPLES.find((e) => e.id === "pending")!.build(), "x");
    s.cluster.runFor(30_000);
    expect(runKubectl(s.cluster, "get events").output).toContain("0/3 nodes are available: 3 Insufficient cpu.");
  });
});

describe("정의 → 클러스터 동기화", () => {
  test("노드·매니페스트를 바꾼 만큼만 반영", () => {
    const s = new DefSync();
    const def = EXAMPLES[0]!.build();
    s.reset(def, "x");
    s.cluster.runFor(10_000);
    const rv = s.cluster.api.resourceVersion;
    expect(s.sync(def)).toBe(false);
    expect(s.cluster.api.resourceVersion).toBe(rv);
    const next = structuredClone(def);
    next.manifests[0]!.spec.replicas = 5;
    next.nodes.push({ name: "worker-3", cpu: 2000, memory: 4096 });
    expect(s.sync(next)).toBe(true);
    s.cluster.runFor(10_000);
    expect(s.cluster.api.list("Pod")).toHaveLength(5);
    expect(s.cluster.api.list("Node")).toHaveLength(3);
  });

  test("kubectl 로 바꾼 값은 드리프트로 보이고, 매니페스트를 다시 적용하면 돌아온다", () => {
    const s = new DefSync();
    const def = EXAMPLES[0]!.build();
    s.reset(def, "x");
    s.cluster.runFor(10_000);
    runKubectl(s.cluster, "scale deployment/web --replicas=1");
    s.cluster.runFor(10_000);
    expect(s.drift(def.manifests[0]!)).toEqual(["replicas: 매니페스트 3 · 라이브 1"]);
    s.forget("web");
    s.sync(def);
    s.cluster.runFor(10_000);
    expect(s.drift(def.manifests[0]!)).toEqual([]);
    expect(s.cluster.api.list("Pod")).toHaveLength(3);
  });
});


describe("YAML", () => {
  test("중첩·배열·문자열 따옴표", async () => {
    const { toYaml } = await import("../src/model/yaml");
    expect(toYaml({ kind: "Pod", metadata: { name: "a", labels: { app: "web" } }, spec: { containers: [{ name: "c", image: "nginx:1.27" }] }, n: 3, e: [] })).toBe(
      ["kind: Pod", "metadata:", "  name: a", "  labels:", "    app: web", "spec:", "  containers:", "  - name: c", "    image: nginx:1.27", "n: 3", "e: []"].join("\n"),
    );
  });
});
