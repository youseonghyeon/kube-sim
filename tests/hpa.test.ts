// 5e: HPA — CPU 사용률(requests 대비 %)로 replicas, 늘리기 정책, 줄이기 안정화 5분, requests 없으면 <unknown>, Git 의 replicas 와 싸움.
import { describe, expect, test } from "vitest";
import { application, deployment, hpa, service, type Manifest } from "../src/core/cluster";
import { HPA_SYNC_MS, SCALE_DOWN_WINDOW_MS } from "../src/core/controllers/hpa";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { cluster } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const replicas = (c: C, name = "web") => c.api.get("Deployment", name)!.spec.replicas;

function web(c: C, cpu = 200) {
  c.apply(deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu, memory: 64, port: 80 }));
  c.apply(service("web", { selector: { app: "web" }, port: 80 }));
  c.apply(hpa("web", { min: 1, max: 10, cpuPercent: 50 }));
  c.runFor(30_000);
}

describe("HPA: requests 대비 사용률로 늘리고 줄인다", () => {
  test("부하 40 rps → 1 Pod 가 401m = 200% → ceil(1 × 200/50) = 4 → 새 Pod 가 Ready 일 때까지 그대로 → 다 뜨면 Pod 마다 101m = 50% 로 안정", () => {
    const c = cluster([{ name: "worker-1", cpu: 4000 }, { name: "worker-2", cpu: 4000 }]);
    web(c);
    expect(kubectl(c, "kubectl get hpa").output).toMatch(/web\s+Deployment\/web\s+cpu: 0%\/50%\s+1\s+10\s+1\s+/);
    c.setLoad("web", 40);
    c.runFor(HPA_SYNC_MS + 1);
    expect(replicas(c)).toBe(4);
    const up = c.trace.events.filter((e) => e.actor === "horizontal-pod-autoscaler").at(-1)!;
    expect(up.msg).toContain("cpu 사용 401m / requests 200m = 200% (목표 50%) → 원하는 ceil(1 × 200%/50%) = 4 → replicas 1 → 4");
    expect(c.api.events.some((e) => e.reason === "SuccessfulRescale" && e.message === "New size: 4; reason: cpu resource utilization (percentage of request) above target")).toBe(true);
    // 새 Pod 가 뜨는 동안: Ready 1개만 200% 지만 나머지 3개를 0% 로 쳐서 50% → 그대로 (과하게 늘리지 않음)
    c.runFor(HPA_SYNC_MS);
    expect(replicas(c)).toBe(4);
    c.runFor(60_000);
    expect(replicas(c)).toBe(4);
    expect(kubectl(c, "kubectl get hpa").output).toContain("cpu: 50%/50%");
    // 부하를 두 배로 → 4 Pod × 200% → 한 번에 두 배 또는 +4 중 큰 것(8)까지
    c.setLoad("web", 160);
    c.runFor(HPA_SYNC_MS);
    expect(replicas(c)).toBe(8);
  });

  test("부하를 멈추면 5분(안정화 창) 동안은 그대로, 그 뒤에 minReplicas 까지", () => {
    const c = cluster([{ name: "worker-1", cpu: 4000 }, { name: "worker-2", cpu: 4000 }]);
    web(c);
    c.setLoad("web", 40);
    c.runFor(90_000);
    const n = replicas(c);
    expect(n).toBeGreaterThan(1);
    c.setLoad("web", 0);
    const stop = c.now;
    c.runFor(SCALE_DOWN_WINDOW_MS - 30_000);
    expect(replicas(c)).toBe(n);
    c.runFor(60_000);
    expect(replicas(c)).toBe(1);
    const down = c.api.events.filter((e) => e.reason === "SuccessfulRescale").at(-1)!;
    expect(down.message).toBe("New size: 1; reason: All metrics below target");
    expect(c.now - stop).toBeGreaterThanOrEqual(SCALE_DOWN_WINDOW_MS - 30_000);
  });

  test("requests 가 없으면 <unknown> — FailedGetResourceMetric, 늘리지 않는다 → requests 를 주면 된다", () => {
    const c = cluster();
    web(c, 0);
    c.setLoad("web", 40);
    c.runFor(60_000);
    expect(replicas(c)).toBe(1);
    expect(kubectl(c, "kubectl get hpa").output).toContain("cpu: <unknown>/50%");
    expect(c.api.events.some((e) => e.reason === "FailedGetResourceMetric" && /^failed to get cpu utilization: missing request for cpu in container web of Pod web-/.test(e.message))).toBe(true);
    kubectl(c, "kubectl set resources deployment/web --requests=cpu=200m");
    c.runFor(60_000);
    expect(replicas(c)).toBeGreaterThan(1);
  });

  test("kubectl scale 로 바꿔도 다음 15초에 HPA 가 되돌린다 (지난 추천이 모두 1 이라 안정화도 막지 않음)", () => {
    const c = cluster([{ name: "worker-1", cpu: 4000 }, { name: "worker-2", cpu: 4000 }]);
    web(c);
    kubectl(c, "kubectl scale deployment/web --replicas=6");
    c.runFor(HPA_SYNC_MS + 1);
    expect(replicas(c)).toBe(1);
  });
});

describe("kubectl", () => {
  test("autoscale · get · describe (실제 모양)", () => {
    const c = cluster();
    c.apply(deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 200, memory: 64, port: 80 }));
    c.runFor(10_000);
    expect(kubectl(c, "kubectl autoscale deployment web --cpu-percent=50 --min=1 --max=10").output).toBe("horizontalpodautoscaler.autoscaling/web autoscaled");
    expect(kubectl(c, "kubectl autoscale deployment web --max=3").output).toContain("AlreadyExists");
    expect(kubectl(c, "kubectl autoscale deployment web --cpu-percent=50").output).toContain("--max=MAXPODS is required");
    c.runFor(20_000);
    const d = kubectl(c, "kubectl describe hpa web").output;
    expect(d).toMatch(/resource cpu on pods  \(as a percentage of request\):\s+0% \(1m\) \/ 50%/);
    expect(d).toMatch(/ScalingLimited\s+True\s+TooFewReplicas\s+the desired replica count is less than the minimum replica count/); // 유휴: 추천 0 → minReplicas 로 자름
    expect(d).toMatch(/Deployment pods:\s+1 current \/ 1 desired/);
    expect(d).toMatch(/ScalingActive\s+True\s+ValidMetricFound/);
  });
});

describe("apply 와 replicas (HPA 가 맡을 때)", () => {
  test("replicas 를 적지 않은 매니페스트는 라이브 값을 지키고, 지난번에 적었다가 지우면 한 번은 기본값 1", () => {
    const c = cluster();
    const m = deployment("web", { replicas: 3, image: "nginx:1.27", cpu: 50, memory: 32 });
    c.apply(m);
    c.runFor(5_000);
    const noReplicas = structuredClone(m) as Manifest & { spec: { replicas?: number } };
    delete noReplicas.spec.replicas;
    c.apply(noReplicas);
    expect(replicas(c)).toBe(1); // 지난번 apply 에 있었던 replicas 를 지웠다 → 필드가 지워져 기본값
    kubectl(c, "kubectl scale deployment/web --replicas=4");
    c.apply(noReplicas);
    expect(replicas(c)).toBe(4); // 이제 last-applied 에도 없으니 라이브 값 그대로
  });
});

describe("Argo CD selfHeal 과 HPA", () => {
  const REPO = "https://github.com/example/web.git";
  const files = (withReplicas: boolean) => {
    const d = deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 200, memory: 64, port: 80 }) as Manifest & { spec: { replicas?: number } };
    if (!withReplicas) delete d.spec.replicas;
    return { "deploy/deployment.yaml": d, "deploy/service.yaml": service("web", { selector: { app: "web" }, port: 80 }), "deploy/hpa.yaml": hpa("web", { min: 1, max: 10, cpuPercent: 50 }) };
  };

  test("Git 에 replicas 가 있으면 HPA 가 늘린 것을 selfHeal 이 되돌려 출렁인다 → Git 에서 replicas 를 빼면 멈춘다", () => {
    const c = cluster([{ name: "worker-1", cpu: 4000 }, { name: "worker-2", cpu: 4000 }]);
    c.gitCommit(REPO, files(true), "first");
    c.apply(application("web", { repoURL: REPO, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(30_000);
    c.setLoad("web", 40);
    const from = c.trace.events.length;
    c.runFor(120_000);
    const ev = c.trace.events.slice(from);
    const hpaUps = ev.filter((e) => e.actor === "horizontal-pod-autoscaler" && /replicas 1 → \d/.test(e.msg)).length;
    const heals = ev.filter((e) => e.kind === "gitops.selfheal" || (e.kind === "gitops.sync" && e.msg.includes("selfHeal"))).length;
    expect(hpaUps).toBeGreaterThanOrEqual(2);
    expect(heals).toBeGreaterThanOrEqual(2);
    // 고치기: Git 에서 replicas 를 뺀다
    c.gitCommit(REPO, files(false), "hpa 가 replicas 를 맡게");
    runArgocd(c, "argocd app get web --refresh");
    c.runFor(60_000);
    const settled = c.trace.events.length;
    c.runFor(120_000);
    const after = c.trace.events.slice(settled);
    expect(after.filter((e) => e.kind === "gitops.selfheal").length).toBe(0);
    expect(replicas(c)).toBeGreaterThan(1);
    expect(c.api.get("Application", "web", "argocd")!.status.sync.status).toBe("Synced");
  });
});
