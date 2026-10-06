// 5a: requests/limits · OOMKilled · CPU throttling — 트레이스와 kubectl 출력으로 고정한다.
import { describe, expect, test } from "vitest";
import { qosClass, type Pod } from "../src/core/api/types";
import { deployment } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const kubectl = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);
const traceOf = (c: ReturnType<typeof cluster>, kind: string) => c.trace.events.filter((e) => e.kind === kind);

describe("memory limit — cgroup OOM", () => {
  test("힙이 limits.memory 를 넘는 순간 OOMKilled · exit 137 → 재시작 → CrashLoopBackOff", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("report", { replicas: 1, image: "example/report:1.0", cpu: 100, memory: 256, limits: { memory: 256 } }));
    c.runFor(5_000);
    const start = traceOf(c, "kubelet.start")[0]!;
    c.runFor(60_000);
    const ooms = traceOf(c, "kubelet.oom");
    expect(ooms.length).toBeGreaterThanOrEqual(2);
    // 320Mi 까지 6초 램프 → 256Mi 를 넘는 첫 ms 는 시작 뒤 4801ms
    expect(ooms[0]!.t - start.t).toBe(4801);
    expect(ooms[0]!.msg).toContain("limits.memory 256Mi 에 닿음");
    expect(ooms[0]!.msg).toContain("cgroup OOM killer");
    // 바로 뒤 kubelet.exit 에 이유가 드러난다
    const exit = traceOf(c, "kubelet.exit")[0]!;
    expect(exit.msg).toContain("OOMKilled · exit 137");
    const p = pods(c)[0]!;
    const cs = p.status.containerStatuses[0]!;
    expect(cs.restartCount).toBeGreaterThanOrEqual(2);
    expect(cs.lastState).toMatchObject({ terminated: { reason: "OOMKilled", exitCode: 137 } });
    const d = kubectl(c, `kubectl describe pod ${p.metadata.name}`).output;
    expect(d).toMatch(/Last State:\s+Terminated\n\s+Reason:\s+OOMKilled\n\s+Exit Code:\s+137/);
    expect(d).toMatch(/Limits:\n\s+memory:\s+256Mi/);
    expect(d).toContain("QoS Class:        Burstable");
    expect(kubectl(c, "kubectl get pods").output).toMatch(/CrashLoopBackOff|OOMKilled/);
  });

  test("limit 을 512Mi 로 올리면 새 Pod 는 320Mi 에서 멈추고 죽지 않는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("report", { replicas: 1, image: "example/report:1.0", cpu: 100, memory: 256, limits: { memory: 256 } }));
    c.runFor(20_000);
    expect(kubectl(c, "kubectl set resources deployment/report --limits=memory=512Mi").ok).toBe(true);
    c.runFor(30_000);
    const before = traceOf(c, "kubelet.oom").length;
    c.runFor(120_000);
    expect(traceOf(c, "kubelet.oom").length).toBe(before);
    const live = pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
    expect(live).toHaveLength(1);
    expect(live[0]!.spec.containers[0]!.resources.limits).toEqual({ memory: 512 });
    expect(kubectl(c, "kubectl top pods").output).toMatch(new RegExp(`${live[0]!.metadata.name}\\s+100m\\s+320Mi`));
  });
});

describe("노드 메모리 — 노드 OOM killer 와 oom_score", () => {
  test("limits 없는 누수가 노드를 채우면 oom_score 가 가장 큰 프로세스가 죽고 노드에 SystemOOM 이벤트", () => {
    const c = cluster([{ name: "worker-1", memory: 1024 }]);
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.apply(deployment("leaky", { replicas: 1, image: "example/leaky:1.0", cpu: 100, memory: 128 }));
    c.runFor(15 * 60_000);
    const oom = traceOf(c, "kubelet.oom")[0]!;
    expect(oom.msg).toContain("노드 worker-1 의 컨테이너 메모리 사용 합이 노드 메모리 1Gi 에 닿음");
    expect(oom.msg).toMatch(/oom_score 가 가장 큰/);
    expect(oom.ref?.name).toMatch(/^leaky-/);
    expect(c.api.events.some((e) => e.reason === "SystemOOM" && e.involvedObject.kind === "Node" && e.message.startsWith("System OOM encountered, victim process: leaky, pid: "))).toBe(true);
    // 이웃 nginx 는 살아 있다
    for (const p of pods(c).filter((x) => x.metadata.labels.app === "web")) expect(p.status.containerStatuses[0]!.restartCount).toBe(0);
  });

  test("requests 를 크게 잡은 쪽은 보호받고 BestEffort 이웃이 먼저 죽는다", () => {
    const c = cluster([{ name: "worker-1", memory: 1024 }]);
    // leaky: requests 512Mi (oom_score_adj 500) · report: requests 없음 = BestEffort (adj 1000)
    c.apply(deployment("leaky", { replicas: 1, image: "example/leaky:1.0", cpu: 100, memory: 512 }));
    c.apply(deployment("report", { replicas: 1, image: "example/report:1.0", cpu: 0, memory: 0 }));
    c.runFor(15 * 60_000);
    const first = traceOf(c, "kubelet.oom")[0]!;
    expect(first.ref?.name).toMatch(/^report-/);
    expect(first.msg).toContain("BestEffort");
    const report = pods(c).find((p) => p.metadata.labels.app === "report")!;
    expect(qosClass(report.spec)).toBe("BestEffort");
    expect(kubectl(c, `kubectl describe pod ${report.metadata.name}`).output).toContain("QoS Class:        BestEffort");
  });
});

describe("CPU — throttling 과 나눠 받기", () => {
  const thumbs = (cpu: number, limit?: number, liveness = false) =>
    deployment("thumbs", {
      replicas: 1,
      image: "example/thumbs:1.0",
      cpu,
      memory: 128,
      port: 8080,
      ...(limit !== undefined ? { limits: { cpu: limit } } : {}),
      ...(liveness ? { liveness: { httpGet: { path: "/healthz", port: 8080 }, periodSeconds: 5 } } : {}),
    });

  test("cpu limit 200m: 죽지 않고 응답만 3배 느려진다 (150ms → 450ms)", () => {
    const c = cluster();
    c.apply(thumbs(100, 200));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
    c.runFor(20_000);
    const p = pods(c).find((x) => x.metadata.labels.app === "thumbs")!;
    expect(c.podMetrics(p)?.cpuState).toEqual({ want: 600, got: 200, limit: 200, reason: "limit" });
    const client = pods(c).find((x) => x.metadata.labels.app === "client")!.metadata.name;
    const r = c.requestFromPod(client, "curl", `http://${p.status.podIP}:8080`);
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBe(450);
    expect(r.output).toContain("응답 450ms");
    expect(r.steps.find((s) => s.kind === "response")!.text).toContain("cpu limit 200m 에 막혀 throttling");
    expect(kubectl(c, "kubectl top pods").output).toMatch(new RegExp(`${p.metadata.name}\\s+200m\\s+60Mi`));
    expect(traceOf(c, "kubelet.oom")).toHaveLength(0);
    expect(p.status.containerStatuses[0]!.restartCount).toBe(0);
  });

  test("limit 이 없으면 원하는 600m 를 다 받아 150ms", () => {
    const c = cluster();
    c.apply(thumbs(100));
    c.runFor(20_000);
    const p = pods(c)[0]!;
    expect(c.podMetrics(p)?.cpuState).toEqual({ want: 600, got: 600, limit: undefined, reason: undefined });
  });

  test("노드 CPU 가 모자라면 requests 비율로 나눈다 (덜 원하는 쪽 몫은 다시 나눔)", () => {
    const c = cluster([{ name: "worker-1", cpu: 1000 }]);
    c.apply(deployment("a", { replicas: 1, image: "example/thumbs:1.0", cpu: 100, memory: 64 }));
    c.apply(deployment("b", { replicas: 1, image: "example/thumbs:1.0", cpu: 400, memory: 64 }));
    c.runFor(20_000);
    const byApp = (app: string) => c.podMetrics(pods(c).find((p) => p.metadata.labels.app === app)!)!.cpuState;
    // 1000m 를 100:400 으로 → 200 : 800, b 는 600 이면 충분 → 남는 200 을 a 가 받아 400
    expect(byApp("b")).toMatchObject({ want: 600, got: 600 });
    expect(byApp("a")).toMatchObject({ want: 600, got: 400, reason: "node" });
  });

  test("cpu limit 이 너무 낮으면 liveness probe 가 시간 초과로 실패해 재시작된다 (재시작해도 낫지 않음)", () => {
    const c = cluster();
    c.apply(thumbs(50, 50, true));
    c.runFor(60_000);
    const kill = traceOf(c, "kubelet.probe").find((e) => e.msg.includes("liveness probe") && e.msg.includes("시간 초과"));
    expect(kill?.msg).toContain("응답 1800ms > timeoutSeconds 1초");
    expect(kill?.msg).toContain("cpu limit 에 막힘");
    expect(c.api.events.some((e) => e.reason === "Unhealthy" && e.message.includes("context deadline exceeded (Client.Timeout exceeded while awaiting headers)"))).toBe(true);
    expect(pods(c)[0]!.status.containerStatuses[0]!.restartCount).toBeGreaterThanOrEqual(1);
  });
});

describe("API 서버: limits 기본값과 검사", () => {
  test("requests 가 limits 보다 크면 Invalid (실제 문구)", () => {
    const c = cluster();
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 250, memory: 128 }));
    c.runFor(5_000);
    const r = kubectl(c, "kubectl set resources deployment/web --limits=cpu=100m");
    expect(r.ok).toBe(false);
    expect(r.output).toBe('Error from server (Invalid): Deployment "web" is invalid: spec.template.spec.containers[0].resources.requests: Invalid value: "250m": must be less than or equal to cpu limit of 100m');
    expect(c.api.get("Deployment", "web")!.spec.template.spec.containers[0]!.resources.limits).toBeUndefined();
  });

  test("limits 만 적으면 requests 가 limits 로 채워져 Guaranteed", () => {
    const c = cluster();
    c.apply(deployment("g", { replicas: 1, image: "nginx:1.27", cpu: 0, memory: 0, limits: { cpu: 200, memory: 128 } }));
    c.runFor(5_000);
    const p = pods(c)[0]!;
    expect(p.spec.containers[0]!.resources.requests).toEqual({ cpu: 200, memory: 128 });
    expect(qosClass(p.spec)).toBe("Guaranteed");
  });

  test("QoS 클래스", () => {
    const spec = (requests: { cpu: number; memory: number }, limits?: { cpu?: number; memory?: number }) =>
      ({ containers: [{ name: "x", image: "nginx:1.27", resources: { requests, ...(limits ? { limits } : {}) } }], restartPolicy: "Always", terminationGracePeriodSeconds: 30 }) as Pod["spec"];
    expect(qosClass(spec({ cpu: 0, memory: 0 }))).toBe("BestEffort");
    expect(qosClass(spec({ cpu: 100, memory: 0 }))).toBe("Burstable");
    expect(qosClass(spec({ cpu: 100, memory: 64 }, { cpu: 100, memory: 64 }))).toBe("Guaranteed");
    expect(qosClass(spec({ cpu: 100, memory: 64 }, { memory: 64 }))).toBe("Burstable");
  });
});

describe("kubectl top · describe node", () => {
  test("top nodes 는 실사용, describe node 는 requests·limits (overcommit 이 보임)", () => {
    const c = cluster([{ name: "worker-1", memory: 1024 }]);
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, limits: { memory: 1024 } }));
    c.runFor(10_000);
    expect(kubectl(c, "kubectl top nodes").output).toBe(["NAME       CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)", "worker-1   4m           0%       24Mi            2%"].join("\n"));
    const d = kubectl(c, "kubectl describe node worker-1").output;
    expect(d).toContain("(Total limits may be over 100 percent, i.e., overcommitted.)");
    expect(d).toMatch(/memory\s+128Mi \(13%\)\s+2Gi \(200%\)/);
    c.setNodePower("worker-1", false);
    expect(kubectl(c, "kubectl top nodes").output).toContain("<unknown>");
  });

  test("top 의 잘못된 사용은 고치는 법을 알려 준다", () => {
    const c = cluster();
    const r = kubectl(c, "kubectl top deploy");
    expect(r.ok).toBe(false);
    expect(r.output).toContain("kubectl top pods 또는 kubectl top nodes");
  });
});

describe("limits 만 적은 매니페스트 — 비교하는 쪽도 기본값을 안다", () => {
  test("Argo CD 는 requests 를 비운 Git 매니페스트를 라이브(requests = limits)와 같다고 본다", async () => {
    const { diffFields } = await import("../src/core/gitops/argocd");
    const c = cluster();
    const m = deployment("g", { replicas: 1, image: "nginx:1.27", cpu: 0, memory: 0, limits: { cpu: 200, memory: 128 } });
    c.apply(m);
    c.runFor(5_000);
    expect(diffFields(m, c.api.get("Deployment", "g")!)).toEqual([]);
  });

  test("화면의 드리프트 검사도 같다", async () => {
    const { DefSync } = await import("../src/model/defSync");
    const s = new DefSync();
    const m = deployment("g", { replicas: 1, image: "nginx:1.27", cpu: 0, memory: 0, limits: { cpu: 200, memory: 128 } });
    s.reset({ nodes: [{ name: "worker-1", cpu: 2000, memory: 4096 }], manifests: [m] }, "x");
    s.cluster.runFor(5_000);
    expect(s.drift(m)).toEqual([]);
    runKubectl(s.cluster, "kubectl set resources deployment/g --limits=memory=256Mi");
    expect(s.drift(m)).toEqual(["limits 가 다름"]);
  });
});

describe("예제 '자원' 묶음이 학습 포인트를 실제로 보여 준다", () => {
  const load = async (id: string) => {
    const { DefSync } = await import("../src/model/defSync");
    const { exampleById } = await import("../src/model/examples");
    const s = new DefSync();
    s.reset(exampleById(id)!.build(), id);
    return s.cluster;
  };

  test("oom: 30초 안에 OOMKilled, limit 을 올리면 멈춘다", async () => {
    const c = await load("oom");
    c.runFor(30_000);
    expect(traceOf(c, "kubelet.oom").length).toBeGreaterThanOrEqual(1);
    runKubectl(c, "kubectl set resources deployment/report --limits=memory=512Mi");
    c.runFor(60_000);
    const n = traceOf(c, "kubelet.oom").length;
    c.runFor(5 * 60_000);
    expect(traceOf(c, "kubelet.oom").length).toBe(n);
  });

  test("node-oom: 7분 안에 노드 OOM 이 leaky 를 고르고, limits 를 걸면 컨테이너 OOM 으로 바뀐다", async () => {
    const c = await load("node-oom");
    c.runFor(7 * 60_000);
    const first = traceOf(c, "kubelet.oom")[0];
    expect(first?.msg).toContain("노드의 커널 OOM killer");
    expect(first?.ref?.name).toMatch(/^leaky-/);
    runKubectl(c, "kubectl set resources deployment/leaky --limits=memory=384Mi");
    const from = c.trace.events.length;
    c.runFor(10 * 60_000);
    const after = c.trace.events.slice(from).filter((e) => e.kind === "kubelet.oom");
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.every((e) => e.msg.includes("cgroup OOM killer") && e.ref?.name?.startsWith("leaky-"))).toBe(true);
  });

  test("throttle: 450ms → (50m) liveness 시간 초과 재시작 → (1 CPU) 150ms", async () => {
    const c = await load("throttle");
    c.runFor(20_000);
    const client = pods(c).find((p) => p.metadata.labels.app === "client")!.metadata.name;
    expect(c.requestFromPod(client, "curl", "http://thumbs").latencyMs).toBe(450);
    expect(runKubectl(c, "kubectl set resources deployment/thumbs --requests=cpu=50m --limits=cpu=50m").ok).toBe(true);
    const from = c.trace.events.length;
    c.runFor(90_000);
    expect(c.trace.events.slice(from).some((e) => e.kind === "kubelet.probe" && e.msg.includes("시간 초과"))).toBe(true);
    expect(runKubectl(c, "kubectl set resources deployment/thumbs --requests=cpu=100m --limits=cpu=1").ok).toBe(true);
    c.runFor(60_000);
    expect(c.requestFromPod(client, "curl", "http://thumbs").latencyMs).toBe(150);
  });
});
