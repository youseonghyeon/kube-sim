import { describe, expect, test } from "vitest";
import { NODE_LEASE_NS } from "../src/core/api/types";
import { runKubectl } from "../src/core/kubectl";
import { cluster, decisions, pods, statuses, web } from "./helpers";

const onNode = (c: ReturnType<typeof cluster>, n: string) => pods(c).filter((p) => p.spec.nodeName === n);

describe("노드 장애: Lease → NotReady → taint → 300초 → eviction", () => {
  test("kubelet 은 10초마다 Lease 를 갱신한다 (kube-node-lease)", () => {
    const c = cluster();
    c.runFor(35_000);
    const l = c.api.get("Lease", "worker-1", NODE_LEASE_NS)!;
    expect(l.spec.renewTime).toBe(30_000);
    expect(runKubectl(c, "get leases -n kube-node-lease").output).toMatch(/^NAME\s+HOLDER\s+AGE\s+RENEWED\nworker-1\s+worker-1\s+35s\s+5s ago/);
  });

  test("노드를 끄면 40초 넘어 NotReady·taint, 그로부터 300초 뒤 Pod 가 지워지고 다른 노드에 다시 생긴다", () => {
    const c = cluster([{ name: "worker-1" }, { name: "worker-2" }, { name: "worker-3" }]);
    c.apply(web(6));
    c.runFor(10_000);
    const victims = onNode(c, "worker-2").map((p) => p.metadata.name);
    expect(victims.length).toBe(2);
    const off = c.now;
    const before = c.trace.events.length;
    c.setNodePower("worker-2", false);

    // 40초 안에는 아무도 모른다: Ready, Pod 는 Running 1/1
    c.runFor(39_000);
    expect(runKubectl(c, "get nodes").output).toMatch(/worker-2\s+Ready\s/);
    expect(onNode(c, "worker-2").every((p) => p.status.conditions.find((x) => x.type === "Ready")?.status === "True")).toBe(true);

    // 40초 + 감시 주기(5초) 안에 NotReady
    c.runFor(11_000);
    const node = c.api.get("Node", "worker-2")!;
    expect(runKubectl(c, "get nodes").output).toMatch(/worker-2\s+NotReady\s/);
    expect(node.spec.taints?.map((t) => `${t.key}:${t.effect}`)).toEqual(["node.kubernetes.io/unreachable:NoSchedule", "node.kubernetes.io/unreachable:NoExecute"]);
    const notReadyAt = node.spec.taints![1]!.timeAdded!;
    expect(notReadyAt - off).toBeGreaterThan(40_000);
    expect(notReadyAt - off).toBeLessThanOrEqual(45_000);
    // Pod 는 Ready=False 지만 STATUS 는 여전히 Running (kubectl 로 보면 멀쩡해 보임)
    expect(onNode(c, "worker-2").map((p) => p.status.conditions.find((x) => x.type === "Ready")?.status)).toEqual(["False", "False"]);
    expect(onNode(c, "worker-2").map((p) => runKubectl(c, `get pod ${p.metadata.name}`).output.split("\n")[1])).toEqual(
      expect.arrayContaining([expect.stringMatching(/Running/)]),
    );
    expect(c.api.get("Deployment", "web")!.status.readyReplicas).toBe(4);

    // 기본 toleration 300초 전에는 옮기지 않는다
    c.runFor(notReadyAt + 299_000 - c.now);
    expect(c.trace.events.some((e) => e.kind === "node.evict")).toBe(false);
    c.runToIdle(); // 일반 타이머(eviction 예약)와 그 뒤 일까지
    const evicted = c.trace.events.slice(before).filter((e) => e.kind === "node.evict");
    expect(evicted.map((e) => e.ref?.name).sort()).toEqual([...victims].sort());
    expect(evicted[0]!.t - notReadyAt).toBe(300_000);

    // 꺼진 노드의 Pod 는 Terminating 에 멈추고, 다른 노드에 새 Pod 2개
    c.runFor(30_000);
    expect(onNode(c, "worker-2").map((p) => p.metadata.deletionTimestamp !== undefined)).toEqual([true, true]);
    const alive = pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
    expect(alive).toHaveLength(6);
    expect(alive.every((p) => p.spec.nodeName !== "worker-2" && p.status.phase === "Running")).toBe(true);
    expect(statuses(c).filter((s) => s === "Terminating")).toHaveLength(2);

    const kinds = decisions(c, before);
    expect(kinds.indexOf("node.power")).toBeLessThan(kinds.indexOf("node.notready"));
    expect(kinds.indexOf("node.notready")).toBeLessThan(kinds.indexOf("node.evict"));
  });

  test("다시 켜면 Ready·taint 제거, Terminating 이던 Pod 는 정리된다", () => {
    const c = cluster([{ name: "worker-1" }, { name: "worker-2" }]);
    c.apply(web(4));
    c.runFor(10_000);
    c.setNodePower("worker-2", false);
    c.runFor(400_000);
    expect(statuses(c).filter((s) => s === "Terminating")).toHaveLength(2);
    c.setNodePower("worker-2", true);
    c.runFor(10_000);
    expect(runKubectl(c, "get nodes").output).toMatch(/worker-2\s+Ready\s/);
    expect(c.api.get("Node", "worker-2")!.spec.taints).toBeUndefined();
    expect(statuses(c)).toEqual(["Running", "Running", "Running", "Running"]);
    expect(onNode(c, "worker-2")).toHaveLength(0);
  });

  test("300초 전에 다시 켜면 옮기지 않고 그 자리에서 컨테이너를 다시 띄운다 (재시작 +1, 새 IP)", () => {
    const c = cluster([{ name: "worker-1" }, { name: "worker-2" }]);
    c.apply(web(2));
    c.runFor(10_000);
    const p = onNode(c, "worker-2")[0]!;
    c.setNodePower("worker-2", false);
    c.runFor(120_000);
    expect(c.api.get("Node", "worker-2")!.spec.taints).toHaveLength(2);
    c.setNodePower("worker-2", true);
    c.runFor(400_000);
    expect(c.trace.events.some((e) => e.kind === "node.evict")).toBe(false);
    const again = c.api.get("Pod", p.metadata.name)!;
    expect(again.metadata.uid).toBe(p.metadata.uid);
    expect(again.status.phase).toBe("Running");
    expect(again.status.containerStatuses[0]!.restartCount).toBe(1);
    expect(again.status.podIP).not.toBe(p.status.podIP);
    expect(c.api.get("Node", "worker-2")!.spec.taints).toBeUndefined();
  });

  test("꺼진 노드에 40초 안에 스케줄된 Pod 도 결국 eviction 되어 다른 곳으로", () => {
    const c = cluster([{ name: "worker-1" }, { name: "worker-2" }]);
    c.runFor(1000);
    c.setNodePower("worker-2", false);
    c.apply(web(4));
    c.runFor(400_000);
    const alive = pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
    expect(alive).toHaveLength(4);
    expect(alive.every((p) => p.spec.nodeName === "worker-1" && p.status.phase === "Running")).toBe(true);
  });

  test("Node 를 지우면 Lease 도 가비지 컬렉터가 지운다", () => {
    const c = cluster();
    c.removeNode("worker-2");
    c.runToIdle();
    expect(c.api.get("Lease", "worker-2", NODE_LEASE_NS)).toBeUndefined();
  });

  test("Pod 에는 기본 toleration 300초가 붙는다 (DefaultTolerationSeconds)", () => {
    const c = cluster();
    c.apply(web(1));
    c.runFor(5000);
    expect(pods(c)[0]!.spec.tolerations).toEqual([
      { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
      { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
    ]);
  });
});
