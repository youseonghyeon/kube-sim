import { describe, expect, test } from "vitest";
import { Cluster, deployment } from "../src/core/cluster";
import { cluster, decisions, pods, statuses, web } from "./helpers";

describe("Deployment → ReplicaSet → Pod → 스케줄 → kubelet", () => {
  test("replicas 3 이 모두 Running 이 되는 순서", () => {
    const c = cluster();
    const before = c.trace.events.length;
    c.apply(web(3));
    c.runToIdle();
    expect(decisions(c, before)).toEqual([
      "controller.reconcile", // deployment-controller: ReplicaSet 생성
      "controller.reconcile", // replicaset-controller: Pod 3개 생성
      "scheduler.bind",
      "scheduler.bind",
      "scheduler.bind",
      "kubelet.sandbox",
      "kubelet.sandbox",
      "kubelet.sandbox",
      "kubelet.pull",
      "kubelet.pull",
      "kubelet.pull", // 같은 노드의 두 번째 Pod 는 받는 중인 pull 을 기다린다
      "kubelet.start",
      "kubelet.start",
      "kubelet.start",
    ]);
    expect(statuses(c)).toEqual(["Running", "Running", "Running"]);
    // 노드 둘에 고르게 (LeastAllocated)
    const byNode = pods(c).map((p) => p.spec.nodeName).sort();
    expect(byNode).toEqual(["worker-1", "worker-1", "worker-2"]);
    // Pod IP 는 노드의 PodCIDR 에서
    for (const p of pods(c)) expect(p.status.podIP).toMatch(p.spec.nodeName === "worker-1" ? /^10\.244\.1\.\d+$/ : /^10\.244\.2\.\d+$/);
    const d = c.api.get("Deployment", "web")!;
    expect(d.status).toMatchObject({ replicas: 3, readyReplicas: 3, availableReplicas: 3, updatedReplicas: 3 });
  });

  test("이미 받아 둔 이미지는 pull 하지 않는다 (두 번째 Pod 부터 빠르다)", () => {
    const c = cluster([{ name: "worker-1" }]);
    c.apply(web(1));
    c.runToIdle();
    const t1 = c.now;
    c.apply(web(2));
    c.runToIdle();
    expect(c.api.events.some((e) => e.message === 'Container image "nginx:1.27" already present on machine')).toBe(true);
    expect(c.now - t1).toBeLessThan(2000);
  });

  test("같은 입력 → 같은 트레이스 (결정론)", () => {
    const run = () => {
      const c = cluster([{ name: "a" }, { name: "b" }, { name: "c" }]);
      c.apply(web(5));
      c.runToIdle();
      c.api.delete("Pod", pods(c)[0]!.metadata.name, "default", "kubectl");
      c.runToIdle();
      return c.trace.events.map((e) => `${e.t}|${e.actor}|${e.msg}`);
    };
    expect(run()).toEqual(run());
  });
});

describe("선언과 reconcile", () => {
  test("Pod 를 지우면 ReplicaSet 이 새 이름·새 IP 로 다시 만든다", () => {
    const c = cluster();
    c.apply(web(3));
    c.runToIdle();
    const victim = pods(c)[0]!;
    const before = c.trace.events.length;
    c.api.delete("Pod", victim.metadata.name, "default", "kubectl");
    // 바로는 Terminating (deletionTimestamp)
    expect(statuses(c)).toContain("Terminating");
    c.runToIdle();
    const kinds = decisions(c, before);
    expect(kinds).toContain("kubelet.kill");
    expect(kinds).toContain("kubelet.removed");
    // 새 Pod 생성은 옛 Pod 가 사라지기를 기다리지 않는다 (Terminating 은 이미 개수에서 빠짐)
    expect(kinds.indexOf("controller.reconcile")).toBeLessThan(kinds.indexOf("kubelet.removed"));
    const now = pods(c);
    expect(now).toHaveLength(3);
    expect(now.map((p) => p.metadata.name)).not.toContain(victim.metadata.name);
    const fresh = now.find((p) => p.metadata.creationTimestamp > victim.metadata.creationTimestamp)!;
    expect(fresh.status.podIP).not.toBe(victim.status.podIP);
    expect(statuses(c)).toEqual(["Running", "Running", "Running"]);
  });

  test("replicas 를 줄이면 남는 Pod 를 지우고, 늘리면 만든다", () => {
    const c = cluster();
    c.apply(web(3));
    c.runToIdle();
    c.apply(web(1));
    c.runToIdle();
    expect(pods(c)).toHaveLength(1);
    c.apply(web(4));
    c.runToIdle();
    expect(pods(c)).toHaveLength(4);
    expect(c.api.get("ReplicaSet", c.api.list("ReplicaSet")[0]!.metadata.name)!.status.readyReplicas).toBe(4);
  });

  test("Deployment 를 지우면 가비지 컬렉터가 ReplicaSet → Pod 를 지운다 (ownerReferences)", () => {
    const c = cluster();
    c.apply(web(2));
    c.runToIdle();
    c.api.delete("Deployment", "web", "default", "kubectl");
    c.runToIdle();
    expect(c.api.list("ReplicaSet")).toHaveLength(0);
    expect(pods(c)).toHaveLength(0);
    expect(c.trace.events.filter((e) => e.kind === "gc.delete").map((e) => e.actor)).toEqual(["garbage-collector", "garbage-collector", "garbage-collector"]);
  });

  test("템플릿(이미지)을 바꾸면 새 ReplicaSet 이 생기고 옛 것은 0 으로 (축소판: Recreate 식)", () => {
    const c = cluster();
    c.apply(web(2, "nginx:1.27"));
    c.runToIdle();
    const oldRs = c.api.list("ReplicaSet")[0]!;
    c.apply(web(2, "nginx:1.28"));
    c.runToIdle();
    const rss = c.api.list("ReplicaSet");
    expect(rss).toHaveLength(2);
    expect(rss.find((r) => r.metadata.uid === oldRs.metadata.uid)!.spec.replicas).toBe(0);
    expect(pods(c).map((p) => p.spec.containers[0]!.image)).toEqual(["nginx:1.28", "nginx:1.28"]);
    expect(c.api.get("Deployment", "web")!.metadata.generation).toBe(2);
  });
});

describe("스케줄러", () => {
  test("자리가 없으면 Pending + FailedScheduling (실제 문구), 노드를 늘리면 스케줄된다", () => {
    const c = cluster([
      { name: "n1", cpu: 1000 },
      { name: "n2", cpu: 1000 },
      { name: "n3", cpu: 1000 },
    ]);
    c.apply(deployment("api", { replicas: 4, image: "nginx:1.27", cpu: 600, memory: 128 }));
    c.runToIdle();
    expect(statuses(c).filter((s) => s === "Pending")).toHaveLength(1);
    const pending = pods(c).find((p) => !p.spec.nodeName)!;
    const ev = c.api.eventsFor(pending.metadata.uid).find((e) => e.reason === "FailedScheduling")!;
    expect(ev.message).toBe("0/3 nodes are available: 3 Insufficient cpu.");
    expect(pending.status.conditions.find((x) => x.type === "PodScheduled")).toMatchObject({ status: "False", reason: "Unschedulable" });
    // 클러스터가 바뀌기 전에는 다시 시도하지 않는다 (runToIdle 이 끝난 것이 그 증거)
    c.addNode({ name: "n4", cpu: 1000, memory: 4096 });
    c.runToIdle();
    expect(statuses(c)).toEqual(["Running", "Running", "Running", "Running"]);
    expect(pods(c).find((p) => p.metadata.uid === pending.metadata.uid)!.spec.nodeName).toBe("n4");
  });

  test("이유가 여러 가지면 정렬해서 잇는다", () => {
    const c = cluster([
      { name: "n1", cpu: 1000, memory: 4096 },
      { name: "n2", cpu: 4000, memory: 256 },
    ]);
    c.apply(deployment("big", { replicas: 1, image: "nginx:1.27", cpu: 2000, memory: 512 }));
    c.runToIdle();
    const p = pods(c)[0]!;
    expect(c.api.eventsFor(p.metadata.uid).find((e) => e.reason === "FailedScheduling")!.message).toBe("0/2 nodes are available: 1 Insufficient cpu, 1 Insufficient memory.");
  });

  test("노드를 지우면 그 노드의 Pod 는 강제 삭제되고 다른 노드에 다시 생긴다", () => {
    const c = cluster();
    c.apply(web(2));
    c.runToIdle();
    c.removeNode("worker-1");
    c.runToIdle();
    expect(pods(c).every((p) => p.spec.nodeName === "worker-2")).toBe(true);
    expect(statuses(c)).toEqual(["Running", "Running"]);
  });

  test("Pod 가 사라져 자리가 나면 Pending Pod 가 스케줄된다", () => {
    const c = cluster([{ name: "n1", cpu: 1000 }]);
    c.apply(deployment("a", { replicas: 1, image: "nginx:1.27", cpu: 800, memory: 128 }));
    c.runToIdle();
    c.apply(deployment("b", { replicas: 1, image: "nginx:1.27", cpu: 800, memory: 128 }));
    c.runToIdle();
    expect(statuses(c).sort()).toEqual(["Pending", "Running"]);
    c.api.delete("Deployment", "a", "default", "kubectl");
    c.runToIdle();
    expect(pods(c).map((p) => p.metadata.labels.app + ":" + p.status.phase)).toEqual(["b:Running"]);
  });
});

describe("kubelet 백오프", () => {
  test("CrashLoopBackOff: 첫 재시작은 바로, 그다음 10·20·40초 … 최대 300초", () => {
    const c = cluster([{ name: "n1" }]);
    c.apply(deployment("crash", { replicas: 1, image: "example/crash-on-start:1.0", cpu: 100, memory: 64 }));
    c.runFor(10 * 60_000);
    const starts = c.trace.events.filter((e) => e.kind === "kubelet.start").map((e) => e.t);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
    // 실행 2초 + 재시작 대기(0 → 10 → 20 → 40 → 80 → 160 → 300 → 300) + 다시 만드는 시간(0.3초)
    expect(gaps.map((g) => Math.round((g - 2000 - 300) / 1000) * 1000)).toEqual([0, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000].slice(0, gaps.length));
    expect(gaps.length).toBeGreaterThanOrEqual(6);
    const p = pods(c)[0]!;
    const ev = c.api.eventsFor(p.metadata.uid).find((e) => e.reason === "BackOff")!;
    expect(ev.message).toBe(`Back-off restarting failed container crash in pod ${p.metadata.name}_default(${p.metadata.uid})`);
    expect(ev.count).toBeGreaterThan(3);
  });

  test("CrashLoopBackOff 동안 STATUS 와 RESTARTS", () => {
    const c = cluster([{ name: "n1" }]);
    c.apply(deployment("crash", { replicas: 1, image: "example/crash-on-start:1.0", cpu: 100, memory: 64 }));
    // 시작(~3.1s) → 크래시(~5.1) → 바로 재시작(~5.4) → 크래시(~7.4) → 백오프 10초
    c.runFor(9000);
    expect(statuses(c)).toEqual(["CrashLoopBackOff"]);
    expect(pods(c)[0]!.status.containerStatuses[0]!.restartCount).toBe(1);
  });

  test("이미지 이름 오타: ErrImagePull → ImagePullBackOff, 백오프하며 다시 시도", () => {
    const c = cluster([{ name: "n1" }]);
    c.apply(deployment("typo", { replicas: 1, image: "ngnix:1.27", cpu: 100, memory: 64 }));
    c.runFor(2000);
    expect(statuses(c)).toEqual(["ErrImagePull"]);
    c.runFor(2000);
    expect(statuses(c)).toEqual(["ImagePullBackOff"]);
    c.runFor(60_000);
    const fails = c.trace.events.filter((e) => e.kind === "kubelet.pull.fail").map((e) => e.t);
    expect(fails.length).toBe(3); // 1.3s, +10.8s, +20.8s
    const p = pods(c)[0]!;
    expect(c.api.eventsFor(p.metadata.uid).find((e) => e.message.startsWith("Failed to pull image"))!.message).toBe(
      'Failed to pull image "ngnix:1.27": rpc error: code = NotFound desc = failed to pull and unpack image "docker.io/library/ngnix:1.27": not found',
    );
  });

  test("크래시 루프 중인 Pod 를 지워도 타이머가 남지 않는다 (runToIdle 이 끝난다)", () => {
    const c = cluster([{ name: "n1" }]);
    c.apply(deployment("crash", { replicas: 1, image: "example/crash-on-start:1.0", cpu: 100, memory: 64 }));
    c.runFor(30_000);
    c.api.delete("Deployment", "crash", "default", "kubectl");
    c.runToIdle();
    expect(pods(c)).toHaveLength(0);
    expect(c.clock.peekNextTime()).toBeUndefined();
  });
});

describe("API 서버", () => {
  test("낡은 resourceVersion 으로 쓰면 Conflict", () => {
    const c = new Cluster();
    c.apply(web(1));
    const a = c.api.get("Deployment", "web")!;
    const b = c.api.get("Deployment", "web")!;
    a.spec.replicas = 2;
    c.api.update(a, "alice");
    b.spec.replicas = 5;
    expect(() => c.api.update(b, "bob")).toThrow(/the object has been modified/);
    expect(c.trace.events.some((e) => e.kind === "api.conflict")).toBe(true);
  });

  test("내용이 같으면 쓰지 않는다 (resourceVersion 그대로, watch 없음)", () => {
    const c = new Cluster();
    c.apply(web(1));
    const rv = c.api.resourceVersion;
    expect(c.apply(web(1))).toBe("unchanged");
    expect(c.api.resourceVersion).toBe(rv);
  });
});
