// 리뷰 7: 5a requests/limits · OOMKilled · CPU throttling — 결함 재현 테스트.
import { describe, expect, test } from "vitest";
import { qosClass, type ContainerState, type Pod } from "../src/core/api/types";
import { deployment } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const traceOf = (c: ReturnType<typeof cluster>, kind: string) => c.trace.events.filter((e) => e.kind === kind);
const live = (c: ReturnType<typeof cluster>, app: string) => pods(c).filter((p) => p.metadata.labels.app === app && p.metadata.deletionTimestamp === undefined);

describe("limits 만 적은 Deployment — requests 기본값은 Pod 에만 (SetDefaults_Pod)", () => {
  test("limit 을 올리면 새 Pod 의 requests 도 새 limit 으로 채워져 Guaranteed 로 남는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("g", { replicas: 1, image: "nginx:1.27", cpu: 0, memory: 0, limits: { cpu: 200, memory: 128 } }));
    c.runFor(10_000);
    expect(qosClass(live(c, "g")[0]!.spec)).toBe("Guaranteed");
    expect(runKubectl(c, "kubectl set resources deployment/g --limits=cpu=400m,memory=256Mi").ok).toBe(true);
    c.runFor(30_000);
    const p = live(c, "g")[0]!;
    expect(p.spec.containers[0]!.resources.limits).toEqual({ cpu: 400, memory: 256 });
    // 실제: Deployment 템플릿에는 requests 가 없으므로 새 Pod 는 새 limits 로 기본값을 받는다
    expect(p.spec.containers[0]!.resources.requests).toEqual({ cpu: 400, memory: 256 });
    expect(qosClass(p.spec)).toBe("Guaranteed");
  });
});

describe("limits 0 — kubelet 은 0 을 '상한 없음' 으로 본다", () => {
  test("--limits=memory=0Mi 는 받아들여지지만 컨테이너를 1ms 만에 OOMKilled 로 죽이지 않는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("z", { replicas: 1, image: "nginx:1.27", cpu: 0, memory: 0 }));
    c.runFor(10_000);
    const r = runKubectl(c, "kubectl set resources deployment/z --limits=memory=0Mi");
    expect(r.ok).toBe(true);
    c.runFor(60_000);
    expect(traceOf(c, "kubelet.oom")).toHaveLength(0);
  });

  test("--limits=cpu=0 은 CPU 를 0 으로 막지 않는다 (CFS 쿼터 없음)", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("z", { replicas: 1, image: "example/thumbs:1.0", cpu: 0, memory: 0, port: 8080 }));
    c.runFor(10_000);
    expect(runKubectl(c, "kubectl set resources deployment/z --limits=cpu=0").ok).toBe(true);
    c.runFor(30_000);
    const p = live(c, "z")[0]!;
    const m = c.podMetrics(p);
    expect(m?.cpuState.got).toBe(600);
  });
});

describe("요청 응답 시간 — CPU 몫이 0 에 가까울 때", () => {
  test("노드 CPU 를 줄여 BestEffort Pod 의 몫이 0m 로 반올림돼도 응답에 Infinity·NaN 이 찍히지 않는다", () => {
    const c = cluster([{ name: "worker-1", cpu: 2000 }]);
    c.apply(deployment("a", { replicas: 1, image: "example/thumbs:1.0", cpu: 1500, memory: 64, port: 8080 }));
    c.apply(deployment("b", { replicas: 1, image: "example/thumbs:1.0", cpu: 0, memory: 0, port: 8080 }));
    c.runFor(15_000);
    c.resizeNode("worker-1", 100, 4096);
    c.runFor(1_000);
    const a = live(c, "a")[0]!;
    const b = live(c, "b")[0]!;
    const r = c.requestFromPod(a.metadata.name, "curl", `http://${b.status.podIP}:8080`);
    const text = [r.output, ...r.steps.map((s) => s.text)].join("\n");
    expect(text).not.toMatch(/Infinity|NaN/);
    expect(Number.isFinite(r.latencyMs ?? 0)).toBe(true);
  });
});

describe("watch 지연 사이에 OOM — 지워지는 중인 Pod", () => {
  test("삭제 직후(kubelet 이 아직 모를 때) OOMKilled 된 컨테이너는 SIGTERM·Completed(exit 0) 로 끝나지 않는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("report", { replicas: 1, image: "example/report:1.0", cpu: 100, memory: 256, limits: { memory: 256 } }));
    c.runFor(4_000);
    const start = traceOf(c, "kubelet.start")[0]!;
    const p = pods(c)[0]!;
    const name = p.metadata.name;
    // 마지막으로 본 컨테이너 상태 (Pod 가 사라지기 직전)
    let lastState: ContainerState | undefined;
    c.api.watch("Pod", (ev) => {
      if (ev.object.metadata.name === name && ev.type !== "DELETED") lastState = (ev.object as Pod).status.containerStatuses[0]?.state;
    });
    // OOM 은 시작 + 4801ms. 그 50ms 전에 지운다 (watch 지연 100ms 안)
    c.runFor(start.t + 4751 - c.now);
    expect(runKubectl(c, `kubectl delete pod ${name}`).ok).toBe(true);
    c.runFor(10_000);
    const oom = traceOf(c, "kubelet.oom").find((e) => e.ref?.name === name);
    expect(oom).toBeDefined();
    expect(lastState).toMatchObject({ terminated: { reason: "OOMKilled", exitCode: 137 } });
    // 죽은 프로세스에 SIGTERM 을 보내 "앱이 ... 종료" 하는 일은 없어야 한다
    const after = c.trace.events.filter((e) => e.t >= oom!.t && e.ref?.name === name && e.kind === "kubelet.kill");
    expect(after.map((e) => e.msg).join("\n")).not.toContain("SIGTERM");
  });
});

describe("oom_score_adj — kubelet qos/policy.go", () => {
  test("Burstable 의 oom_score_adj 하한은 3 (1000 + guaranteedOOMScoreAdj -997)", () => {
    const c = cluster([{ name: "worker-1", memory: 1024 }]);
    // requests.memory = 노드 메모리 → 1000 - 1000 = 0 → 하한 3
    c.apply(deployment("leaky", { replicas: 1, image: "example/leaky:1.0", cpu: 100, memory: 1024 }));
    c.runFor(10 * 60_000);
    const oom = traceOf(c, "kubelet.oom")[0]!;
    // 사용이 1024Mi 를 막 넘은 순간: floor(사용×1000/1024) = 1000, + adj 3 = 1003
    expect(oom.msg).toMatch(/leaky-\S+ 1003 \(Burstable/);
  });
});

describe("kubectl top — 실제 출력은 MiB 를 버림 (Value()/(1024*1024))", () => {
  test("limit 256Mi 에 아직 안 닿은 255.6Mi 를 256Mi 로 올려 보이지 않는다", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("report", { replicas: 1, image: "example/report:1.0", cpu: 100, memory: 256, limits: { memory: 256 } }));
    c.runFor(4_000);
    const start = traceOf(c, "kubelet.start")[0]!;
    // 320Mi × 4793/6000 = 255.64Mi (OOM 은 4801ms)
    c.runFor(start.t + 4793 - c.now);
    expect(traceOf(c, "kubelet.oom")).toHaveLength(0);
    const out = runKubectl(c, "kubectl top pods").output;
    expect(out).toMatch(/report-\S+\s+100m\s+255Mi/);
  });
});
