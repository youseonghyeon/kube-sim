// 리뷰 6 (2026-10-02, GitOps)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { application, deployment, service, type Manifest } from "../src/core/cluster";
import { runArgocd } from "../src/core/gitops/cli";
import { runKubectl } from "../src/core/kubectl";
import { cluster } from "./helpers";

const REPO = "https://github.com/youseonghyeon/net-sim.git";
function files(tag: string, replicas = 1, withSvc = true): Record<string, Manifest> {
  const out: Record<string, Manifest> = { "deploy/deployment.yaml": deployment("net-sim", { replicas, image: `ghcr.io/youseonghyeon/net-sim:${tag}`, cpu: 10, memory: 16, port: 8080 }) };
  if (withSvc) out["deploy/service.yaml"] = service("net-sim", { selector: { app: "net-sim" }, port: 8080 });
  return out;
}
function setup(automated?: { prune: boolean; selfHeal: boolean }, f = files("aaa111")) {
  const c = cluster([{ name: "w1" }, { name: "w2" }]);
  c.gitCommit(REPO, f, "first");
  c.apply(application("net-sim", { repoURL: REPO, path: "deploy", automated }));
  c.runFor(15_000);
  return c;
}
type C = ReturnType<typeof cluster>;
const app = (c: C) => c.api.get("Application", "net-sim", "argocd")!;
const syncCount = (c: C) => c.trace.events.filter((e) => e.kind === "gitops.sync").length;

describe("review6 Argo CD", () => {
  // 기대(실제 Argo CD autoSync): automated.prune=false 이고 남은 차이가 "prune 대상" 뿐이면
  //   "Skipping auto-sync: need to prune extra resources only but automated prune is disabled" 로 sync 를 하지 않는다 — OutOfSync 로 머문다.
  // 실제(sim): selfHeal 이 켜져 있으면 5초마다 같은 no-op sync 를 영원히 되풀이한다 (60초에 12번, history·이벤트가 계속 쌓이고
  //   runToIdle 이 끝나지 않는다 — 일반 타이머 사슬).
  // 학습 영향: 로그가 "self-heal → 바뀐 것 없음" 으로 도배되고 history 가 쓸모없어진다. prune 을 끈 채 Git 에서 파일을 지우면 바로 재현된다(UI 체크박스로 가능).
  test("prune 꺼짐 + selfHeal: prune 대상만 남으면 sync 를 되풀이하지 않는다", () => {
    const c = setup({ prune: false, selfHeal: true });
    c.gitCommit(REPO, files("aaa111", 1, false), "remove service");
    c.argocd.refresh("net-sim");
    c.runFor(2_000);
    expect(app(c).status.sync.status).toBe("OutOfSync");
    const before = syncCount(c);
    c.runFor(60_000);
    expect(syncCount(c) - before).toBe(0);
    expect(() => c.runToIdle(20_000)).not.toThrow();
  });

  // 기대(실제 Argo CD, syncPolicy.automated.allowEmpty 기본 false): Git 경로가 비어 모든 리소스가 prune 대상이 되면
  //   "Skipping sync attempt to <sha>: auto-sync will wipe out all resources" 로 자동 sync 를 거절한다. 리소스는 남고 앱은 OutOfSync.
  // 실제(sim): 자동 sync 가 prune 으로 Deployment·Service 를 모두 지우고 Synced/Healthy 로 보인다.
  // 학습 영향: Git 편집기에서 파일을 다 지우는 실수 하나로 서비스가 사라진다고 잘못 배운다 — Argo CD 의 핵심 안전장치(allowEmpty)를 놓친다.
  test("자동 sync 는 Git 경로가 비면 전부 지우지 않는다 (allowEmpty=false)", () => {
    const c = setup({ prune: true, selfHeal: true });
    c.gitCommit(REPO, {}, "remove everything");
    c.argocd.refresh("net-sim");
    c.runFor(10_000);
    expect(c.api.get("Deployment", "net-sim")).toBeDefined();
    expect(c.api.get("Service", "net-sim")).toBeDefined();
    expect(app(c).status.sync.status).toBe("OutOfSync");
  });

  // 기대(실제 Argo CD): `argocd app sync` (리비전 지정 없음) 는 sync 할 때 targetRevision(main)을 Git 에서 새로 풀어 최신 커밋을 적용한다
  //   (CompareAppState noRevisionCache=true). 폴링 캐시는 "자동으로 알아채는 시점" 에만 영향을 준다.
  // 실제(sim): 마지막으로 가져온(폴링·Refresh) 리비전으로 sync 한다 → push 직후 수동 sync 를 해도 옛 이미지가 "unchanged" 로 적용되고 Synced 로 보인다.
  // 학습 영향: "Sync 버튼을 눌렀는데 왜 새 커밋이 안 들어가지?" 를 실제와 반대로 배운다. gitops 예제의 마지막 "손으로 sync" 도 이 때문에 옛 리비전으로 끝난다.
  test("수동 sync 는 캐시된 리비전이 아니라 지금 Git HEAD 를 적용한다", () => {
    const c = setup(undefined);
    runArgocd(c, "argocd app sync net-sim");
    c.runFor(5_000);
    const head = c.gitCommit(REPO, files("bbb222"), "ci: bump image tag to bbb222", "github-actions");
    runArgocd(c, "argocd app sync net-sim");
    c.runFor(5_000);
    expect(c.api.get("Deployment", "net-sim")!.spec.template.spec.containers[0]!.image).toBe("ghcr.io/youseonghyeon/net-sim:bbb222");
    expect(app(c).status.operationState?.syncResult?.revision).toBe(head.sha);
  });

  // 기대(실제 Argo CD = kubectl apply 의 3-way merge, 또는 server-side apply): Git 에 없는 필드는 지우지 않는다.
  //   kubectl rollout restart 가 붙인 spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] 은 last-applied 에 없으므로
  //   selfHeal 이 replicas 만 되돌릴 때 그대로 남는다 (그래서 rollout restart 는 Argo CD 아래서도 OutOfSync 가 아니고 되돌려지지도 않는다).
  // 실제(sim): Cluster.apply 가 spec 을 통째로 바꿔 annotation 이 사라진다 → 템플릿 해시가 restart 전으로 돌아가 옛 ReplicaSet 으로 다시 롤아웃된다.
  //   (defSync.ts 머리 주석 "라이브에서 kubectl 로 바꾼 값은 매니페스트에 있는 필드만 덮인다" 와도 어긋난다.)
  // 학습 영향: replicas 드리프트 하나를 고쳤을 뿐인데 Pod 가 전부 교체되는 "유령 롤아웃" 을 보게 된다.
  test("selfHeal 로 replicas 를 되돌려도 rollout restart 표시는 남고 다시 롤아웃하지 않는다", () => {
    const c = setup({ prune: true, selfHeal: true });
    runKubectl(c, "rollout restart deployment/net-sim");
    c.runFor(30_000);
    const restarted = c.api.get("Deployment", "net-sim")!.spec.template.metadata.annotations?.["kubectl.kubernetes.io/restartedAt"];
    expect(restarted).toBeDefined();
    const activeRs = c.api.list("ReplicaSet", "default").find((r) => r.spec.replicas === 1)!.metadata.name;
    runKubectl(c, "scale deployment/net-sim --replicas=3");
    c.runFor(30_000);
    expect(c.api.get("Deployment", "net-sim")!.spec.replicas).toBe(1); // selfHeal 은 됐다
    expect(c.api.get("Deployment", "net-sim")!.spec.template.metadata.annotations?.["kubectl.kubernetes.io/restartedAt"]).toBe(restarted);
    expect(c.api.list("ReplicaSet", "default").find((r) => r.spec.replicas === 1)?.metadata.name).toBe(activeRs);
  });

  // 기대(실제 Argo CD): history 의 ID 는 계속 늘어난다 (마지막 ID + 1). 오래된 것은 revisionHistoryLimit(10) 만큼만 남긴다.
  // 실제(sim): id = history.length 라서 10개가 찬 뒤에는 새 항목이 모두 ID 10 → 같은 ID 가 여럿.
  // 학습 영향: `argocd app history` 에서 ID 로 배포를 구분할 수 없다 (실제로는 `argocd app rollback <ID>` 의 인자).
  test("argocd app history 의 ID 는 겹치지 않는다", () => {
    const c = setup(undefined);
    for (let i = 0; i < 13; i++) {
      runArgocd(c, "argocd app sync net-sim");
      c.runFor(1_000);
    }
    const ids = app(c).status.history.map((h) => h.id);
    expect(ids.length).toBe(10);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.at(-1)).toBe(12);
  });

  // 기대(실제 Argo CD): Application 의 source(repoURL·path·targetRevision)가 바뀌면 새 source 로 다시 비교하고,
  //   자동 sync 는 (리비전, source) 쌍마다 한 번이라 같은 리비전이어도 새 source 로 sync 한다.
  // 실제(sim): 앱마다 "가져온 리비전" 캐시가 source 와 무관하게 남는다 → repoURL 을 바꾸면 옛 저장소의 SHA 를 새 저장소에서 찾다가 빈 목록이 되어
  //   prune 으로 기존 리소스를 다 지우고, 새 저장소의 리소스는 만들지 않은 채 Synced(리소스 0개)로 보인다. path 만 바꾸면 자동 sync 가 돌지 않는다.
  // 학습 영향: Application 을 다른 저장소로 옮기는 흔한 작업에서 서비스가 사라지고 화면은 정상으로 보인다.
  test("Application 의 repoURL 을 바꾸면 새 저장소를 가져와 그 매니페스트로 sync 한다", () => {
    const REPO2 = "https://github.com/youseonghyeon/other.git";
    const c = setup({ prune: true, selfHeal: true });
    const head2 = c.gitCommit(REPO2, { "deploy/d.yaml": deployment("other", { replicas: 1, image: "nginx:1.27", cpu: 10, memory: 16 }) }, "other");
    c.apply(application("net-sim", { repoURL: REPO2, path: "deploy", automated: { prune: true, selfHeal: true } }));
    c.runFor(20_000);
    expect(c.api.get("Deployment", "other")).toBeDefined();
    expect(app(c).status.sync.revision).toBe(head2.sha);
  });

  test("Application 의 path 만 바꿔도 (같은 리비전) 자동 sync 가 새 path 를 적용한다", () => {
    const c = setup({ prune: true, selfHeal: false }, { ...files("aaa111"), "deploy2/d.yaml": deployment("other", { replicas: 1, image: "nginx:1.27", cpu: 10, memory: 16 }) });
    c.apply(application("net-sim", { repoURL: REPO, path: "deploy2", automated: { prune: true, selfHeal: false } }));
    c.runFor(20_000);
    expect(c.api.get("Deployment", "other")).toBeDefined();
    expect(app(c).status.sync.status).toBe("Synced");
  });

  // 기대(실제 Argo CD): 적용이 거절된 리소스가 있으면 sync operation 은 phase Failed
  //   ("one or more objects failed to apply, reason: ...") 로 끝나고, 자동 sync 는 같은 리비전을 재시도하지 않는다(retry 정책이 없으면).
  // 실제(sim): ArgoCD.sync 가 ApiError 를 그대로 던진다 → `argocd app sync` 는 예외(화면에서는 "내부 오류"), operationState 는 비고,
  //   자동 sync 는 컨트롤러 백오프로 15번 넘게 다시 돌며 그때마다 앞쪽 매니페스트만 부분 적용한다.
  // 학습 영향: 축소판이라도 "sync 실패" 를 볼 길이 없다. 지금 UI 의 Git 편집기로는 잘못된 매니페스트를 만들 수 없어 심각도는 낮다.
  test("적용이 거절되는 매니페스트가 있으면 sync 는 Failed 로 끝난다 (예외가 아니라)", () => {
    const bad = service("bad", { selector: { app: "x" }, port: 80, type: "NodePort", nodePort: 80 });
    const c = setup(undefined, { ...files("aaa111"), "deploy/bad.yaml": bad });
    let r: ReturnType<typeof runArgocd> | undefined;
    expect(() => (r = runArgocd(c, "argocd app sync net-sim"))).not.toThrow();
    expect(r?.ok).toBe(false);
    expect(app(c).status.operationState?.phase).toBe("Failed");
  });
});
