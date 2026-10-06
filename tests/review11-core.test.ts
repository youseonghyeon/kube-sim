// 리뷰 11: 코어 컨트롤 루프(HPA·ReplicaSet) 결함 재현 테스트. 모두 지금 코드에서 실패해야 한다 (고친 뒤 통과).
// 실제 동작의 근거는 각 테스트 이름과 주석에 적은 업스트림 파일(v1.30 기준).
import { describe, expect, test } from "vitest";
import { deployment, hpa, service } from "../src/core/cluster";
import { HPA_SYNC_MS } from "../src/core/controllers/hpa";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const replicas = (c: C, name = "web") => c.api.get("Deployment", name)!.spec.replicas;
const webPods = (c: C) => pods(c).filter((p) => p.metadata.labels.app === "web" && p.metadata.deletionTimestamp === undefined);

describe("HPA (pkg/controller/podautoscaler)", () => {
  test("줄일 때 Pending·Ready 아닌 Pod 는 무시한다 — 100% 로 치지 않는다 (replica_calculator.go GetResourceReplicas: unreadyPods 는 metrics 에서 빼고, missingPods 만 100%)", () => {
    // 노드 2개 × 2000m, Pod 하나가 1000m 를 요청 → 4개만 뜨고 2개는 Insufficient cpu 로 Pending. 부하 0 → 사용률 0%
    const c = cluster();
    c.apply(deployment("web", { replicas: 6, image: "example/php-apache:1.0", cpu: 1000, memory: 64, port: 80 }));
    c.apply(hpa("web", { min: 1, max: 10, cpuPercent: 50 }));
    c.runFor(10_000); // HPA 가 손대기 전(첫 주기 15초)
    expect(webPods(c).filter((p) => !p.spec.nodeName).length).toBe(2); // Insufficient cpu 로 Pending
    c.runFor(110_000);
    // 실제: Pending 2개는 unreadyPods → 줄일 때 metrics 에서 빠짐 → ceil(0 × 4) = 0 → minReplicas 1 로 바로.
    // 지금 코드: "Ready 아닌 Pod 2개를 100% 로 침" → 6 → 5 로만 줄이고, 그 5 를 5분 안정화 창이 붙잡아 1 까지 여러 번의 5분이 걸린다
    expect(replicas(c)).toBe(1);
  });

  test("현재 replicas 가 minReplicas 보다 작으면 metrics 를 못 구해도 minReplicas 로 올린다 (horizontal.go reconcileAutoscaler: currentReplicas < minReplicas 분기가 metrics 계산보다 앞)", () => {
    const c = cluster();
    // requests.cpu 가 없어 사용률(<unknown>)을 낼 수 없는 대상
    c.apply(deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 0, memory: 64, port: 80 }));
    c.apply(hpa("web", { min: 2, max: 5, cpuPercent: 50 }));
    c.runFor(60_000);
    expect(replicas(c)).toBe(2);
  });

  test("현재 replicas 가 maxReplicas 보다 크면 그 주기에는 maxReplicas 로 자른다 — metrics 로 계산한 값(min)으로 한 번에 내려가지 않는다 (horizontal.go: currentReplicas > MaxReplicas 분기)", () => {
    const c = cluster([{ name: "worker-1", cpu: 4000 }, { name: "worker-2", cpu: 4000 }]);
    c.apply(deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 200, memory: 64, port: 80 }));
    c.apply(hpa("web", { min: 1, max: 3, cpuPercent: 50 }));
    c.runFor(30_000);
    kubectl(c, "kubectl scale deployment/web --replicas=6");
    c.runFor(HPA_SYNC_MS + 1);
    // 실제: 6 > max 3 → "Current number of replicas above Spec.MaxReplicas" 로 3. 다음 주기에 metrics 로 1.
    expect(replicas(c)).toBe(3);
  });

  test("늘리기 정책(두 배 또는 +4)에 막히면 ScalingLimited=True · ScaleUpLimit (horizontal.go normalizeDesiredReplicasWithBehaviors → convertDesiredReplicasWithBehaviorRate)", () => {
    const c = cluster([{ name: "worker-1", cpu: 4000 }, { name: "worker-2", cpu: 4000 }]);
    c.apply(deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 200, memory: 64, port: 80 }));
    c.apply(service("web", { selector: { app: "web" }, port: 80 }));
    c.apply(hpa("web", { min: 1, max: 10, cpuPercent: 50 }));
    c.runFor(30_000);
    // 1 Pod 가 1601m = 800% → ceil(1 × 16) = 16 이지만 한 번에 5 까지 → 5
    c.setLoad("web", 160);
    c.runFor(HPA_SYNC_MS + 1);
    expect(replicas(c)).toBe(5);
    const limited = c.api.get("HorizontalPodAutoscaler", "web")!.status.conditions.find((x) => x.type === "ScalingLimited")!;
    expect(limited.status).toBe("True");
    expect(limited.reason).toBe("ScaleUpLimit");
  });
});

describe("ReplicaSet 컨트롤러 (pkg/controller/replicaset)", () => {
  test("Pod 템플릿의 annotations 를 Pod 에 복사한다 (controller_utils.go GetPodFromTemplate: Labels·Annotations·Finalizers)", () => {
    const c = cluster();
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 32, podAnnotations: { "checksum/config": "abc123" } }));
    c.runFor(5_000);
    const [p] = webPods(c);
    expect(p).toBeDefined();
    // Deployment → ReplicaSet 템플릿에는 복사되지만 ReplicaSet → Pod 에서 빠진다 (Helm 의 checksum/config, rollout restart 의 restartedAt 이 Pod 에 안 보임)
    expect(c.api.list("ReplicaSet")[0]!.spec.template.metadata.annotations?.["checksum/config"]).toBe("abc123");
    expect(p!.metadata.annotations?.["checksum/config"]).toBe("abc123");
  });

  test("줄일 때 같은 노드에 몰린(doubled up) Pod 를 먼저 지운다 — 최근 것이 아니라 (replica_set.go getPodsRankedByRelatedPodsOnSameNode, controller_utils.go ActivePodsWithRanks.Less 5번)", () => {
    // 노드 하나에 Pod 2개 → 노드를 더하고 3개로 → 새 Pod 는 빈 노드로 → 다시 2개로 줄이면
    const c = cluster([{ name: "worker-1" }]);
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 32 }));
    c.runFor(30_000);
    expect(webPods(c).map((p) => p.spec.nodeName)).toEqual(["worker-1", "worker-1"]);
    c.addNode({ name: "worker-2", cpu: 2000, memory: 4096 });
    c.runFor(5_000);
    kubectl(c, "kubectl scale deployment/web --replicas=3");
    c.runFor(30_000);
    expect(webPods(c).map((p) => p.spec.nodeName).sort()).toEqual(["worker-1", "worker-1", "worker-2"]);
    kubectl(c, "kubectl scale deployment/web --replicas=2");
    c.runFor(1_000);
    // 실제: worker-1 의 두 Pod 가 rank 2 (같은 노드에 둘) → 그중 하나를 지워 노드마다 하나씩 남는다.
    // 지금 코드: "최근 생성" 만 보고 worker-2 의 새 Pod 를 지워 둘 다 worker-1 에 남는다 (노드 장애 한 번에 모두 죽는 배치)
    expect(webPods(c).map((p) => p.spec.nodeName).sort()).toEqual(["worker-1", "worker-2"]);
  });
});
