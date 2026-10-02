import { describe, expect, test } from "vitest";
import { Clock } from "../src/core/clock";
import type { DeploymentManifest } from "../src/core/cluster";
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

  test("배경 타이머(heartbeat)만 있어도 흐르고 그 사이에 발화한다 — 노드가 있는 클러스터는 실제처럼 시간이 계속 흐른다", () => {
    const c = new Clock();
    let beats = 0;
    const beat = () => {
      beats++;
      c.background(100, "hb", beat);
    };
    c.background(100, "hb", beat);
    expect(advanceClock(c, 250, 1)).toMatchObject({ time: 250 });
    expect(beats).toBe(2);
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
        const cmd = resolveCommand(s.cluster.api.list("Pod"), t.command)!;
        // curl 로 시작하면 클러스터 밖에서 (화면의 kubectl 창과 같음)
        const r = cmd.startsWith("curl ") ? s.cluster.requestExternal(cmd.split(/\s+/).pop()!) : runKubectl(s.cluster, cmd);
        expect(r.ok, `${t.command}\n${r.output}`).toBe(!t.expectFail);
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
    (next.manifests[0] as DeploymentManifest).spec.replicas = 5;
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
    expect(s.drift(def.manifests[0] as DeploymentManifest)).toEqual(["replicas: 매니페스트 3 · 라이브 1"]);
    s.forget("Deployment", "web");
    s.sync(def);
    s.cluster.runFor(10_000);
    expect(s.drift(def.manifests[0] as DeploymentManifest)).toEqual([]);
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

test("YAML: 숫자로 읽히는 문자열만 따옴표 (실제 kubectl -o yaml 처럼 cpu: \"1\", cpu: 250m)", async () => {
  const { toYaml } = await import("../src/model/yaml");
  expect(toYaml({ requests: { cpu: 1000, memory: 1024 } })).toBe('requests:\n  cpu: "1"\n  memory: 1Gi');
  expect(toYaml({ v: "1.5", w: "nginx:1.27", x: "True" })).toBe('v: "1.5"\nw: nginx:1.27\nx: "True"');
});

test("drain 예제: worker-1 의 두 번째 Pod 내보내기가 PDB 에 한 번 막혔다가 끝난다", () => {
  const s = new DefSync();
  s.reset(EXAMPLES.find((e) => e.id === "drain")!.build(), "x");
  s.cluster.runFor(20_000);
  const r = runKubectl(s.cluster, "kubectl drain worker-1 --ignore-daemonsets");
  s.cluster.runFor(60_000);
  expect(r.drain!.lines.some((l) => l.includes("Cannot evict pod as it would violate the pod's disruption budget."))).toBe(true);
  expect(r.drain!.lines.at(-1)).toBe("node/worker-1 drained");
});

test("ingress·source-ip 예제: 설명대로 출발지가 노드 IP 였다가 Local 로 바꾸면 클라이언트 IP", () => {
  const run = (id: string) => {
    const s = new DefSync();
    s.reset(EXAMPLES.find((e) => e.id === id)!.build(), "x");
    s.cluster.runFor(30_000);
    return s.cluster;
  };
  const a = run("ingress");
  expect(a.requestExternal("http://shop.example.com/").forwardedFor).toMatch(/^192\.168\.0\.1\d$/);
  runKubectl(a, `kubectl patch svc ingress-nginx-controller -p '{"spec":{"externalTrafficPolicy":"Local"}}'`);
  a.runFor(3000);
  expect(a.requestExternal("http://shop.example.com/").forwardedFor).toBe("203.0.113.7");
  const b = run("source-ip");
  expect(b.requestExternal("http://192.168.0.240/").seenSource).toMatch(/^192\.168\.0\.1\d$/);
  expect(b.requestExternal("http://192.168.0.11:30080/").ok).toBe(true);
  runKubectl(b, `kubectl patch svc who -p '{"spec":{"externalTrafficPolicy":"Local"}}'`);
  b.runFor(3000);
  expect(b.requestExternal("http://192.168.0.240/").seenSource).toBe("203.0.113.7");
  expect(b.requestExternal("http://192.168.0.11:30080/").ok).toBe(false);
});
