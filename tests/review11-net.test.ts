// 리뷰 11: 네트워킹(kube-proxy·NetworkPolicy)·GitOps(Argo CD)·kubectl 출력 결함 재현 테스트. 모두 지금 코드에서 실패해야 한다 (고친 뒤 통과).
import { describe, expect, test } from "vitest";
import { application, deployment, hpa, service, statefulSet, type Manifest } from "../src/core/cluster";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

type C = ReturnType<typeof cluster>;
const kubectl = (c: C, line: string) => runKubectl(c, line);
const REPO = "https://github.com/youseonghyeon/net-sim.git";
const app = (c: C, name = "net-sim") => c.api.get("Application", name, "argocd")!;
const podOf = (c: C, label: string) => pods(c).find((p) => p.metadata.labels.app === label && p.metadata.deletionTimestamp === undefined)!;

describe("kube-proxy", () => {
  // 실제(k8s 1.28+ ProxyTerminatingEndpoints GA, pkg/proxy/topology.go CategorizeEndpoints): ready 엔드포인트가 하나도 없으면
  //   serving && terminating 인 엔드포인트로 보낸다 — 단일 replica 를 지워도 preStop 동안 요청은 계속 그 Pod 가 받는다.
  // 지금 코드(kubeproxy.ts buildRules): conditions.ready 만 보므로 1초 뒤 "has no endpoints" REJECT → 멀쩡히 서비스 중인 Pod 를 두고 연결 거부.
  test("ready 가 없고 terminating·serving 만 있으면 그 엔드포인트로 보낸다 (REJECT 가 아니다)", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80, preStop: 10 }));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
    c.apply(service("web", { selector: { app: "web" }, port: 80 }));
    c.runFor(15_000);
    const victim = podOf(c, "web").metadata.name;
    kubectl(c, "kubectl scale deployment/web --replicas=0"); // 대체 Pod 없이 하나뿐인 Pod 가 Terminating
    c.runFor(3_000); // 규칙은 1초 뒤 다시 씀 — preStop 10초라 앱은 아직 응답한다
    const ep = c.api.list("EndpointSlice")[0]!.endpoints.find((e) => e.targetRef.name === victim)!;
    expect(ep.conditions).toMatchObject({ ready: false, serving: true, terminating: true });
    const r = c.requestFromPod(podOf(c, "client").metadata.name, "curl", "http://web");
    expect(r.ok).toBe(true);
    expect(r.servedBy).toBe(victim);
    expect(c.kubeProxies.get("w1")!.iptablesSave()).not.toContain("default/web has no endpoints");
  });

  // 실제(pkg/proxy/iptables/proxier.go, ExternalPolicyLocal): KUBE-EXT 의 첫 규칙 `-s <clusterCIDR> ... "pod traffic for ... external destinations" -j KUBE-SVC`
  //   → Pod 에서 자기 노드IP:NodePort 로 보낸 것은 Local 과 상관없이 모든 엔드포인트로 (SNAT 없음). 지금 코드의 iptablesSave 도 이 규칙을 찍는다.
  // 지금 코드(request.ts viaService): outside=nodeport 면 출발이 Pod 여도 Local 로 취급 → 이 노드에 Pod 가 없다며 DROP(시간 초과) — 자기가 찍은 규칙과 모순.
  test("Pod → 자기 노드IP:NodePort (Local): 'pod traffic' 규칙으로 다른 노드의 Pod 에도 간다", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80, nodeSelector: { "kubernetes.io/hostname": "w2" } }));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32, nodeSelector: { "kubernetes.io/hostname": "w1" } }));
    c.apply(service("web", { selector: { app: "web" }, port: 80, type: "NodePort", externalTrafficPolicy: "Local" }));
    c.runFor(15_000);
    const np = c.api.get("Service", "web")!.spec.ports[0]!.nodePort!;
    const w1 = c.api.get("Node", "w1")!.status.addresses.find((a) => a.type === "InternalIP")!.address;
    expect(c.kubeProxies.get("w1")!.iptablesSave()).toContain("pod traffic for default/web external destinations");
    const r = c.requestFromPod(podOf(c, "client").metadata.name, "curl", `http://${w1}:${np}`);
    expect(r.ok).toBe(true);
    expect(r.servedBy).toBe(podOf(c, "web").metadata.name);
  });

  // 실제(proxier.go 1.31): Local 인데 이 노드에 엔드포인트가 없으면 filter 테이블 KUBE-EXTERNAL-SERVICES 에 `"... has no local endpoints" ... -j DROP`,
  //   nat 의 KUBE-EXT → KUBE-SVL 점프는 생략. KUBE-MARK-DROP 체인은 kube-proxy 가 더 이상 만들지 않는다.
  // 지금 코드(kubeproxy.ts iptablesSave): nat 의 KUBE-SVL 안에 `-j KUBE-MARK-DROP` 을 찍는다. (tests/ingress.test.ts:141 이 지금 모양을 고정하고 있음)
  test("iptables-save: Local 에 로컬 엔드포인트가 없으면 filter 테이블의 DROP (KUBE-MARK-DROP 아님)", () => {
    const c = cluster([{ name: "w1" }, { name: "w2" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, port: 80, nodeSelector: { "kubernetes.io/hostname": "w2" } }));
    c.apply(service("web", { selector: { app: "web" }, port: 80, type: "NodePort", externalTrafficPolicy: "Local" }));
    c.runFor(15_000);
    const save = c.kubeProxies.get("w1")!.iptablesSave();
    const filter = save.split("*nat")[0]!;
    expect(filter).toMatch(/-A KUBE-EXTERNAL-SERVICES .*"default\/web has no local endpoints".* -j DROP/);
    expect(save).not.toContain("KUBE-MARK-DROP");
  });
});

describe("Argo CD health", () => {
  // 실제(gitops-engine pkg/health/health_statefulset.go): readyReplicas < spec.replicas 면 Progressing "Waiting for N pods to be ready...",
  //   updateRevision != currentRevision 면 Progressing. 지금 코드(argocd.ts healthOf): StatefulSet 은 default → 늘 Healthy.
  test("StatefulSet 의 Pod 가 아직 Ready 가 아니면 Progressing (Healthy 가 아니다)", () => {
    const c = cluster();
    const files: Record<string, Manifest> = {
      "deploy/svc.yaml": service("db", { selector: { app: "db" }, port: 8080, headless: true }),
      "deploy/sts.yaml": statefulSet("db", { replicas: 3, image: "example/kv:1.0", cpu: 100, memory: 64, port: 8080, storage: [{ name: "data", mountPath: "/data", size: 1024 }] }),
    };
    c.gitCommit(REPO, files, "first");
    c.apply(application("net-sim", { repoURL: REPO, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(1_500); // sync 직후 — db-0 도 아직 pull 중
    const sts = c.api.get("StatefulSet", "db")!;
    expect(sts.status.readyReplicas).toBeLessThan(3);
    expect(app(c).status.resources.find((r) => r.kind === "StatefulSet")?.health).toBe("Progressing");
    expect(app(c).status.health.status).toBe("Progressing");
  });

  // 실제(gitops-engine pkg/health/health_hpa.go isDegraded): ScalingActive/FailedGetResourceMetric 조건이면 Degraded.
  //   requests 가 없어 <unknown> 인 HPA 는 Argo CD 화면에서 Degraded 로 보인다 — "왜 Degraded 지?" 가 배울 거리.
  // 지금 코드(argocd.ts healthOf): HPA 는 default → Healthy.
  test("HPA 가 FailedGetResourceMetric 이면 Degraded", () => {
    const c = cluster();
    const files: Record<string, Manifest> = {
      "deploy/deployment.yaml": deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 0, memory: 64, port: 80 }),
      "deploy/service.yaml": service("web", { selector: { app: "web" }, port: 80 }),
      "deploy/hpa.yaml": hpa("web", { min: 1, max: 10, cpuPercent: 50 }),
    };
    c.gitCommit(REPO, files, "first");
    c.apply(application("net-sim", { repoURL: REPO, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(60_000);
    const h = c.api.get("HorizontalPodAutoscaler", "web")!;
    expect(h.status.conditions.some((x) => x.type === "ScalingActive" && x.reason === "FailedGetResourceMetric")).toBe(true);
    expect(app(c).status.resources.find((r) => r.kind === "HorizontalPodAutoscaler")?.health).toBe("Degraded");
    expect(app(c).status.health.status).toBe("Degraded");
  });
});

describe("argocd CLI 출력", () => {
  // 실제(argo-cd cmd/argocd/commands/app.go formatSyncPolicy): 자동 sync 가 아니면 "Manual" ("<none>" 은 옛 버전).
  test("argocd app list 의 SYNCPOLICY 는 수동이면 Manual", () => {
    const c = cluster();
    c.gitCommit(REPO, { "deploy/deployment.yaml": deployment("net-sim", { replicas: 1, image: "ghcr.io/youseonghyeon/net-sim:latest", cpu: 10, memory: 16, port: 8080 }) }, "first");
    c.apply(application("net-sim", { repoURL: REPO, path: "deploy" }));
    c.runFor(5_000);
    const out = runArgocd(c, "argocd app list").output;
    expect(out).toMatch(/argocd\/net-sim\s+\S+\s+default\s+default\s+\S+\s+\S+\s+Manual\s+/);
    expect(out).not.toContain("<none>      <none>");
  });
});

describe("kubectl 출력", () => {
  function webAndClient() {
    const c = cluster();
    c.apply(deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, port: 80 }));
    c.apply(deployment("client", { replicas: 1, image: "curlimages/curl:8.10.1", cpu: 50, memory: 32 }));
    c.runFor(15_000);
    return c;
  }

  // 실제 kubectl: -l / --selector 는 라벨 셀렉터. 지금 코드: "-l" 을 Pod 이름으로 읽어 `Error from server (NotFound): pods "-l" not found`,
  //   --selector=app=web 은 조용히 무시하고 전부 보여 준다 (가장 흔한 get 플래그).
  test("kubectl get pods -l app=web 은 라벨로 거른다", () => {
    const c = webAndClient();
    const r = kubectl(c, "kubectl get pods -l app=web");
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/^web-/m);
    expect(r.output).not.toMatch(/^client-/m);
  });

  test("kubectl get pods --selector=app=client 도 라벨로 거른다 (무시하지 않는다)", () => {
    const c = webAndClient();
    const r = kubectl(c, "kubectl get pods --selector=app=client");
    expect(r.ok).toBe(true);
    expect(r.output).not.toMatch(/^web-/m);
    expect(r.output).toMatch(/^client-/m);
  });

  // 실제 kubectl get all 의 "all" 카테고리에는 horizontalpodautoscaler.autoscaling 도 들어간다 (HPA 연습 문서의 출력 그대로).
  test("kubectl get all 에 horizontalpodautoscaler.autoscaling 이 나온다", () => {
    const c = cluster();
    c.apply(deployment("web", { replicas: 1, image: "example/php-apache:1.0", cpu: 200, memory: 64, port: 80 }));
    c.apply(hpa("web", { min: 1, max: 10, cpuPercent: 50 }));
    c.runFor(30_000);
    expect(kubectl(c, "kubectl get all").output).toMatch(/horizontalpodautoscaler\.autoscaling\/web\s+Deployment\/web\s+cpu: /);
  });
});
