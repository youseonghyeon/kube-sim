// 리뷰 4 (2026-10-02, 배포·종료·PDB/drain)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { ApiError } from "../src/core/api/server";
import { deployment, pdb } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);
const alive = (c: ReturnType<typeof cluster>) => pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);
const onW1 = { "kubernetes.io/hostname": "w1" };
const onW2 = { "kubernetes.io/hostname": "w2" };

describe("review4 drain", () => {
  // 기대: kubectl drain 은 이미 Terminating 인 Pod 도 목록에 넣어(evict 는 200 으로 통과) 사라질 때까지 기다린 뒤
  //       "pod/<x> evicted" → "node/w1 drained" 로 끝난다 (k8s v1.31 drain.go: skipDeletedFilter 는 --skip-wait-for-delete-timeout 을 줄 때만).
  // 실제(sim): DrainJob.round 가 deletionTimestamp 있는 Pod 를 건너뛰고, poll 은 waiting 이 비면 다시 걸지 않아
  //       Terminating Pod 가 사라진 뒤에도 done=false 로 영원히 멈춘다 (10분 포기 줄도 안 나옴).
  // 학습 영향: Pod 를 지운 직후(또는 drain 을 두 번) drain 하면 끝나지 않는 drain 을 보게 된다 — 실제와 다른 "멈춤".
  test("이미 Terminating 인 Pod 가 있는 노드를 drain 하면 그 Pod 가 사라진 뒤 drained 로 끝난다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, preStop: 60, nodeSelector: onW1 }));
    c.runFor(15_000);
    const p = alive(c)[0]!.metadata.name;
    k(c, `delete pod ${p}`); // preStop 60초 동안 Terminating
    c.runFor(300);
    const r = k(c, "drain w1");
    c.runFor(120_000);
    expect(c.api.get("Pod", p)).toBeUndefined(); // 그 Pod 는 이미 사라졌다
    expect(r.drain!.done).toBe(true);
    expect(r.drain!.lines.at(-1)).toBe("node/w1 drained");
  });

  // 기대: kubectl drain 은 시작할 때 고른 Pod 들만 기다린다. 도중에 uncordon 해서 대체 Pod 가 같은 노드로 와도 "node/w1 drained" 로 끝난다.
  // 실제(sim): DrainJob.poll 이 "그 노드의 Pod 수가 0" 을 끝 조건으로 다시 세고, waiting 이 비면 poll 을 다시 걸지 않아 영원히 멈춘다 (포기도 없음).
  // 학습 영향: drain 예제에서 "다시 쓰기(uncordon)" 를 drain 이 끝나기 전에 누르면 drain 이 끝나지 않는다.
  test("drain 도중 uncordon 해서 대체 Pod 가 그 노드로 와도 drain 은 끝난다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 300, memory: 128 }));
    c.apply(pdb("web-pdb", { app: "web" }, { minAvailable: 2 }));
    c.runFor(30_000);
    const node = ["w1", "w2"].find((n) => alive(c).filter((p) => p.spec.nodeName === n).length === 2)!;
    const r = k(c, `drain ${node}`);
    c.runFor(1000);
    k(c, `uncordon ${node}`);
    c.runFor(120_000);
    // 전제: 대체 Pod 중 하나 이상이 다시 그 노드로 왔다
    expect(alive(c).some((p) => p.spec.nodeName === node)).toBe(true);
    expect(r.drain!.done).toBe(true);
    expect(r.drain!.lines.at(-1)).toBe(`node/${node} drained`);
  });
});

describe("review4 Eviction API", () => {
  // 기대(k8s v1.31 eviction.go canIgnorePDB): phase Pending(ImagePullBackOff 등)·Succeeded·Failed Pod 는 PDB 를 보지 않고 지운다.
  // 실제(sim): api.evict 는 Ready 가 아닌 Pod 에 IfHealthyBudget 만 적용 → currentHealthy < desiredHealthy 면 429 로 영원히 거절.
  // 학습 영향: "망가진(ImagePullBackOff) Pod 하나가 drain 을 막는다" 는 실제로는 일어나지 않는 일을 가르친다.
  test("Pending(ImagePullBackOff) Pod 는 PDB 가 부족해도 evict 된다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, nodeSelector: onW2 }));
    c.apply(deployment("web-canary", { replicas: 1, image: "nginx:9.99", cpu: 100, memory: 64, labels: { app: "web" }, nodeSelector: onW1 }));
    c.apply(pdb("web-pdb", { app: "web" }, { minAvailable: 3 }));
    c.runFor(20_000);
    const broken = pods(c).find((p) => p.spec.nodeName === "w1")!;
    expect(broken.status.phase).toBe("Pending"); // 전제
    expect(() => c.api.evict(broken.metadata.name, "default", "kubectl")).not.toThrow();
  });

  // 기대(k8s v1.31 eviction.go): Pod 를 고르는 PDB 가 둘 이상이면 500 "This pod has more than one PodDisruptionBudget, which the eviction subresource does not support."
  //       어떤 PDB 의 disruptionsAllowed 도 바꾸지 않는다.
  // 실제(sim): PDB 를 하나씩 보며 허락한 PDB 를 먼저 깎고(저장·watch 발행), 다음 PDB 가 거절하면 429 — 거절됐는데 앞 PDB 는 이미 줄어 있다 (원자성 깨짐).
  //       둘 다 허락하면 그냥 evict 된다.
  test("PDB 두 개가 같은 Pod 를 고르면 evict 는 거절되고 PDB 상태는 그대로", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.apply(pdb("a", { app: "web" }, { minAvailable: 1 })); // 허용 2
    c.apply(pdb("b", { app: "web" }, { minAvailable: 3 })); // 허용 0
    c.runFor(15_000);
    const before = c.api.get("PodDisruptionBudget", "a")!.status.disruptionsAllowed;
    const victim = alive(c)[0]!.metadata.name;
    let err: unknown;
    try {
      c.api.evict(victim, "default", "kubectl");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    // 거절된 요청이 PDB a 를 깎아 두면 안 된다 (지금은 2 → 1 로 줄어 있음)
    expect(c.api.get("PodDisruptionBudget", "a")!.status.disruptionsAllowed).toBe(before);
    expect((err as ApiError).message).toBe("This pod has more than one PodDisruptionBudget, which the eviction subresource does not support.");
  });
});

describe("review4 disruption controller", () => {
  // 기대(k8s v1.31 disruption.go getExpectedScale): Deployment 가 주인인 ReplicaSet 의 Pod 는 Deployment 의 spec.replicas(4)로 센다.
  //       maxUnavailable 1 → desiredHealthy 3, Ready 4 → 허용 1.
  // 실제(sim): computePdbStatus 가 RS spec.replicas 합(옛 4 + 새 1 = 5)을 expectedPods 로 써서 desiredHealthy 4 → 허용 0.
  // 학습 영향: 롤아웃(maxSurge) 중에는 drain 이 실제보다 더 막힌다. kubectl get pdb 의 ALLOWED DISRUPTIONS 가 실제와 다르다.
  test("롤아웃 중(surge) PDB maxUnavailable 의 expectedPods 는 Deployment replicas", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    const m = deployment("api", { replicas: 4, image: "example/api:1.1", cpu: 100, memory: 64, port: 8080, readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 2 } });
    m.spec.strategy = { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } };
    c.apply(m);
    c.apply(pdb("api-pdb", { app: "api" }, { maxUnavailable: 1 }));
    c.runFor(30_000);
    k(c, "set image deployment/api api=example/api:2.0"); // 새 Pod 1개가 Ready 가 안 돼 멈춤 (옛 4 Ready)
    c.runFor(30_000);
    const s = c.api.get("PodDisruptionBudget", "api-pdb")!.status;
    expect(s.currentHealthy).toBe(4); // 전제
    expect(s.expectedPods).toBe(4);
    expect(s.disruptionsAllowed).toBe(1);
  });
});
