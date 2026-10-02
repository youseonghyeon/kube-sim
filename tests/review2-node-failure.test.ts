// 리뷰 2 (2026-10-02, 노드 장애·성능 변경)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { NODE_LEASE_NS } from "../src/core/api/types";
import { deployment } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { DefSync } from "../src/model/defSync";
import type { ClusterDef } from "../src/model/examples";
import { buildView, nodeStory } from "../src/model/view";
import { cluster, pods, web } from "./helpers";

describe("review2: 노드 장애", () => {
  // [D1] 같은 이름의 노드를 지운 직후(가비지 컬렉터가 옛 Lease 를 지우기 전, watch 지연 100ms 안) 다시 더하면
  // 기대: 새 노드가 정상 등록되고 heartbeat 가 돌아 Ready 를 유지한다 (실제 kubelet 은 Lease 가 있으면 갱신·없으면 만든다).
  // 실제: Kubelet.register() 의 Lease create 가 AlreadyExists 로 throw → Node 는 만들어졌지만 heartbeat 가 시작되지 않고,
  //       100ms 뒤 GC 가 옛 Lease 를 지워 Lease 가 없는 노드가 40초 뒤 영원히 NotReady. 일시정지 상태에서 노드 빼기 → 추가(이름이 같은 worker-N 이 다시 고름) 로 재현된다.
  test("[D1] 지운 직후 같은 이름으로 다시 더한 노드가 등록·heartbeat 된다", () => {
    const c = cluster();
    c.removeNode("worker-2");
    expect(() => c.addNode({ name: "worker-2", cpu: 2000, memory: 4096 })).not.toThrow();
    c.runFor(120_000);
    expect(c.api.get("Lease", "worker-2", NODE_LEASE_NS)).toBeDefined();
    expect(runKubectl(c, "get nodes").output).toMatch(/worker-2\s+Ready\s/);
  });

  // [D1 영향] 위 throw 뒤 DefSync 는 kubelets 맵에는 노드가 있지만 자기 nodes 맵에는 없어서, 이후 모든 sync 가 addNode 에서
  // "노드 worker-2 이(가) 이미 있습니다" 로 throw → 매니페스트 적용까지 막힌다 (리셋 전까지 편집이 반영되지 않음).
  test("[D1-b] 노드를 빼고 바로 다시 더한 뒤에도 매니페스트 편집이 반영된다", () => {
    const s = new DefSync();
    const def: ClusterDef = { nodes: [{ name: "worker-1", cpu: 2000, memory: 4096 }, { name: "worker-2", cpu: 2000, memory: 4096 }], manifests: [] };
    s.reset(def, "test");
    s.cluster.runFor(5000);
    s.sync({ ...def, nodes: def.nodes.slice(0, 1) });
    const errs: string[] = [];
    try {
      s.sync(def);
    } catch (e) {
      errs.push((e as Error).message);
    }
    s.cluster.runFor(1000);
    try {
      s.sync({ ...def, manifests: [web(2)] });
    } catch (e) {
      errs.push((e as Error).message);
    }
    expect(errs).toEqual([]);
    expect(s.cluster.api.get("Deployment", "web", "default")).toBeDefined();
  });

  // [D2] 전원을 다시 켤 때 restartCount 를 무조건 +1 한다 (containerStatuses 가 있기만 하면).
  // 기대: 한 번도 시작된 적 없는 컨테이너(이미지 pull 중·ImagePullBackOff·ContainerCreating 에서 꺼짐)는 restartCount 0 그대로.
  //       실제 kubelet 은 런타임에 남은 이전 컨테이너 인스턴스를 보고 센다 — 만든 적 없는 컨테이너는 재시작으로 세지 않는다.
  // 실제: 1. 끄고 켜기를 같은 순간에 5번 반복하면 컨테이너가 한 번도 다시 뜨지 않았는데 RESTARTS 5.
  // 학습자가 "재시작 횟수 = 컨테이너가 죽은 횟수" 를 잘못 배운다.
  test("[D2] 이미지 pull 중에 꺼졌다 켜진, 한 번도 시작 안 한 컨테이너의 restartCount 는 0", () => {
    const c = cluster();
    c.apply(web(2));
    c.runFor(1500); // 샌드박스 끝, nginx pull(3초) 중
    const victim = pods(c).find((p) => p.spec.nodeName === "worker-2")!;
    expect(victim.status.containerStatuses[0]!.started).toBe(false);
    c.setNodePower("worker-2", false);
    c.runFor(500);
    c.setNodePower("worker-2", true);
    c.runFor(30_000);
    const again = c.api.get("Pod", victim.metadata.name)!;
    expect(again.status.phase).toBe("Running");
    expect(again.status.containerStatuses[0]!.restartCount).toBe(0);
  });

  // [D3] 노드 상자 아래 이야기(nodeStory): 300초 전에 다시 켜면, node-lifecycle-controller 가 taint 를 뗄 때까지(최대 5초)
  // 기대: "다시 켜짐 — 다음 확인 때 taint 를 뗍니다" (kubectl get nodes 는 이미 Ready)
  // 실제: "NotReady — 4분 45초 뒤 이 노드의 Pod 를 eviction" — 사용자가 켠 바로 그 순간 화면이 kubectl 과 반대로 말한다.
  // 원인: view.ts nodeStory 가 unreachableSince && left>0 분기를 n.powered 보다 먼저 본다.
  test("[D3] 300초 전에 다시 켠 직후 nodeStory 가 NotReady·eviction 카운트다운을 말하지 않는다", () => {
    const c = cluster();
    c.apply(web(2));
    c.runFor(10_000);
    c.setNodePower("worker-2", false);
    c.runFor(60_000);
    c.setNodePower("worker-2", true);
    expect(runKubectl(c, "get nodes").output).toMatch(/worker-2\s+Ready\s/);
    const v = buildView(c).nodes.find((n) => n.name === "worker-2")!;
    const story = nodeStory(v, c.now);
    expect(story?.text ?? "").not.toMatch(/NotReady|eviction/);
  });

  // [D4] cordon 한 노드가 NotReady(unreachable taint) 이면 describe node 의 Taints 에서 unschedulable taint 가 사라진다.
  // 기대 (실제 kubectl): Taints: node.kubernetes.io/unreachable:NoExecute, node.kubernetes.io/unreachable:NoSchedule, node.kubernetes.io/unschedulable:NoSchedule (3개)
  // 실제: unreachable 2개만. kubectl.ts describeNode 가 spec.taints 가 비었을 때만 unschedulable 을 덧붙인다.
  test("[D4] cordon + NotReady 노드의 describe Taints 에 unschedulable 도 보인다", () => {
    const c = cluster();
    c.runFor(1000);
    runKubectl(c, "cordon worker-2");
    c.setNodePower("worker-2", false);
    c.runFor(60_000);
    // 실제 kubectl 처럼 taint 는 한 줄에 하나 — "Taints:" 줄과 이어지는 들여쓴 줄을 모아 본다
    const lines = runKubectl(c, "describe node worker-2").output.split("\n");
    const i = lines.findIndex((l) => l.startsWith("Taints:"));
    const line = [lines[i], ...lines.slice(i + 1).filter((_, j, rest) => rest.slice(0, j + 1).every((l) => l.startsWith(" ")))].join("\n");
    expect(line).toContain("node.kubernetes.io/unreachable:NoExecute");
    expect(line).toContain("node.kubernetes.io/unschedulable:NoSchedule");
  });

  // [D5] 꺼진 노드의 자원을 바꾸면(인스펙터·노드 정의 편집 → Cluster.resizeNode) 꺼진 kubelet 이 API 에 새 capacity 를 보고한다.
  // 기대: 꺼진 노드는 아무것도 보고하지 못한다 — capacity 는 그대로이고 (켤 때 새 값으로 보고), 또는 resize 를 거절·안내.
  // 실제: Node status.capacity/allocatable 이 즉시 바뀌고 트레이스에 kubelet@worker-2 "다시 보고" — 그러면서 노드는 계속 NotReady.
  // "kubelet 이 멈추면 API 는 아무것도 모른다" 는 이 기능의 학습 포인트와 모순.
  test("[D5] 꺼진 노드의 kubelet 은 resize 를 API 에 보고하지 않는다", () => {
    const c = cluster();
    c.runFor(1000);
    c.setNodePower("worker-2", false);
    c.runFor(60_000);
    c.resizeNode("worker-2", 4000, 8192);
    c.runFor(1000);
    expect(c.api.get("Node", "worker-2")!.status.capacity.cpu).toBe(2000);
  });

  // [D6] 300초가 어디서 오는지 kubectl 로 확인할 수 없다: describe pod 에 Tolerations 줄이 없다.
  // 기대 (실제 kubectl describe pod):
  //   Tolerations:  node.kubernetes.io/not-ready:NoExecute op=Exists for 300s
  //                 node.kubernetes.io/unreachable:NoExecute op=Exists for 300s
  // 실제: 줄 자체가 없음. 예제 "노드 하나 죽이기" 의 핵심(기본 toleration 300초)을 kubectl 출력으로 보여 줄 수 없다.
  test("[D6] describe pod 에 기본 toleration 300초가 보인다", () => {
    const c = cluster();
    c.apply(web(1));
    c.runFor(5000);
    const out = runKubectl(c, `describe pod ${pods(c)[0]!.metadata.name}`).output;
    expect(out).toMatch(/Tolerations:\s+node\.kubernetes\.io\/not-ready:NoExecute op=Exists for 300s/);
    expect(out).toMatch(/node\.kubernetes\.io\/unreachable:NoExecute op=Exists for 300s/);
  });

  // [D7] 일시정지 중 "한 단계" (sim.step → clock.step) 가 노드 장애 흐름을 진행시키지 못한다.
  // 노드를 끈 뒤 남은 일은 배경 타이머(heartbeat·node-lifecycle 5초 감시)뿐인데 Clock.step() 은 일반 타이머가 없으면 false.
  // 기대: 다음 배경 이벤트(감시 주기)로 한 단계 나아간다 → 단계 버튼만으로 40초 뒤 NotReady 결정을 볼 수 있다.
  // 실제: step() === false, 시계 그대로 — 단계 버튼이 아무 일도 안 한다 (+10초 버튼만 가능).
  test("[D7] 노드를 끈 뒤 일시정지 상태의 step 이 배경 이벤트로 나아간다", () => {
    const c = cluster();
    c.apply(web(2));
    c.runToIdle();
    c.setNodePower("worker-2", false);
    const before = c.now;
    expect(c.clock.stepAny()).toBe(true); // 화면의 "한 단계" (sim.step) 가 쓰는 것 — step() 은 runToIdle 용이라 일반 이벤트만 본다
    expect(c.now).toBeGreaterThan(before);
  });
});

describe("review2: 확인했고 정상인 것 (회귀 고정용)", () => {
  test("같은 입력 → 같은 트레이스 (노드 여러 번 끄고 켜기)", () => {
    const run = () => {
      const c = cluster([{ name: "worker-1" }, { name: "worker-2" }, { name: "worker-3" }]);
      c.apply(web(6));
      c.apply(deployment("w", { replicas: 1, image: "example/worker:1.0", cpu: 100, memory: 64 }));
      c.runFor(7_000);
      c.setNodePower("worker-2", false);
      c.runFor(200_000);
      c.setNodePower("worker-3", false);
      c.runFor(200_000);
      c.setNodePower("worker-2", true);
      c.runFor(100_000);
      return c.trace.events.map((e) => `${e.t} ${e.actor} ${e.kind} ${e.msg}`).join("\n");
    };
    expect(run()).toBe(run());
  });

  test("모든 노드를 끄면 Pending, 하나를 켜면 taint 가 빠진 뒤 그쪽으로 스케줄되고 Deployment 가 다시 ready", () => {
    const c = cluster();
    c.apply(web(2));
    c.runFor(5000);
    c.setNodePower("worker-1", false);
    c.setNodePower("worker-2", false);
    c.runFor(400_000);
    expect(c.runToIdle()).toBeLessThan(1000);
    c.setNodePower("worker-1", true);
    c.runFor(30_000);
    expect(c.api.get("Deployment", "web")!.status.readyReplicas).toBe(2);
    expect(pods(c).filter((p) => p.metadata.deletionTimestamp === undefined).every((p) => p.spec.nodeName === "worker-1")).toBe(true);
  });

  test("eviction 마감 직전·직후에 켜도 Pod 가 남거나 두 번 지워지지 않는다", () => {
    for (const delta of [-5001, -1, 0, 1]) {
      const c = cluster();
      c.apply(web(2));
      c.runFor(10_000);
      c.setNodePower("worker-2", false);
      c.runFor(60_000);
      const t = c.api.get("Node", "worker-2")!.spec.taints![1]!.timeAdded!;
      c.runFor(t + 300_000 + delta - c.now);
      c.setNodePower("worker-2", true);
      c.runFor(30_000);
      const alive = pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
      expect(alive.length).toBe(2);
      expect(pods(c).length).toBe(2);
      expect(c.api.get("Node", "worker-2")!.spec.taints).toBeUndefined();
      expect(c.trace.events.filter((e) => e.kind === "node.evict").length).toBeLessThanOrEqual(1);
    }
  });
});
