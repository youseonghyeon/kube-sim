// 리뷰 4 (2026-10-02, 배포·종료·PDB/drain)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { deployment, type DeploymentManifest } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

const k = (c: ReturnType<typeof cluster>, line: string) => runKubectl(c, line);
const alive = (c: ReturnType<typeof cluster>) => pods(c).filter((p) => p.metadata.deletionTimestamp === undefined);

function api(replicas = 4): DeploymentManifest {
  return deployment("api", { replicas, image: "example/api:1.1", cpu: 100, memory: 64, port: 8080, readiness: { httpGet: { path: "/ready", port: 8080 }, periodSeconds: 2 } });
}

/** 기본 25%/25%, replicas 4 → 2.0 으로 바꾸면 새 2 (Ready 안 됨) + 옛 3 에서 멈춘다 */
function stuck() {
  const c = cluster([{ name: "w1" }, { name: "w2" }]);
  c.apply(api());
  c.runFor(30_000);
  k(c, "set image deployment/api api=example/api:2.0");
  const t0 = c.now;
  c.runFor(30_000);
  return { c, t0 };
}

describe("review4 Recreate", () => {
  // 기대(k8s v1.31 recreate.go): 옛 Pod 가 하나라도 남아 있으면(Terminating 포함, oldPodsRunning) 새 RS 를 늘리지 않는다.
  //       옛 RS 정리(cleanupDeployment)는 DeploymentComplete 뒤에만 한다.
  // 실제(sim): cleanupHistory 가 롤아웃 중에도 매 reconcile 마다 돌아, revisionHistoryLimit 0 이면 Pod 가 아직 Terminating(preStop) 인
  //       옛 RS 를 지운다 → recreate() 의 oldPods 계산(옛 RS uid 로 찾음)에서 빠져 새 Pod 를 바로 만든다. 옛·새 버전이 동시에 돈다.
  // 학습 영향: "Recreate 는 옛·새가 섞이지 않는다" 는 핵심 보장이 revisionHistoryLimit 설정 하나로 깨진다.
  test("revisionHistoryLimit 0 이어도 Recreate 는 옛 Pod(Terminating 포함)가 다 사라진 뒤에 새 Pod 를 만든다", () => {
    const mixedDuringRecreate = (limit?: number) => {
      const c = cluster([{ name: "w1" }]);
      const m = deployment("web", { replicas: 2, image: "nginx:1.27", cpu: 100, memory: 64, preStop: 5 });
      m.spec.strategy = { type: "Recreate" };
      if (limit !== undefined) m.spec.revisionHistoryLimit = limit;
      c.apply(m);
      c.runFor(15_000);
      k(c, "set image deployment/web web=nginx:1.28");
      let mixed = false;
      for (let t = 0; t < 30_000; t += 50) {
        c.runFor(50);
        if (new Set(pods(c).map((p) => p.spec.containers[0]!.image)).size > 1) mixed = true;
      }
      return mixed;
    };
    expect(mixedDuringRecreate()).toBe(false); // 기본(10)은 맞다
    expect(mixedDuringRecreate(0)).toBe(false); // limit 0 이면 옛 Pod 가 Terminating 인 동안 새 Pod 가 생긴다
  });
});

describe("review4 Deployment status", () => {
  // 기대(k8s v1.31 sync.go calculateStatus): unavailableReplicas = (모든 RS 의 spec.replicas 합) − availableReplicas = 5 − 3 = 2.
  //       kubectl describe: "4 desired | 2 updated | 5 total | 3 available | 2 unavailable".
  // 실제(sim): updateStatus 가 spec.replicas(4) − available(3) = 1 로 계산.
  // 학습 영향: 멈춘 롤아웃에서 "Ready 안 된 Pod 2개" 가 describe 에 1 로 보여 숫자가 맞지 않는다 (5 total − 3 available ≠ 1).
  test("멈춘 롤아웃의 unavailableReplicas 는 전체(5) − available(3) = 2", () => {
    const { c } = stuck();
    expect(c.api.get("Deployment", "api")!.status.unavailableReplicas).toBe(2);
    expect(k(c, "describe deployment api").output).toMatch(/Replicas:\s+4 desired \| 2 updated \| 5 total \| 3 available \| 2 unavailable/);
  });

  // 기대(k8s v1.31 deployment/util DeploymentProgressing): 진전 = updatedReplicas 증가 · 옛 replicas 감소 · ready/available 증가 뿐.
  //       옛 Pod 가 Ready 를 잃는 것(감소)은 진전이 아니므로 마감은 마지막 진전(롤아웃 시작) + 600초에 온다.
  // 실제(sim): updateStatus 의 progressed 가 "값이 바뀌기만 하면" 진전으로 봐서 lastUpdateTime 을 갱신 → 마감이 뒤로 밀린다.
  // 학습 영향: 롤아웃이 멈춘 동안 옛 Pod 가 아파도(오히려 더 나빠져도) ProgressDeadlineExceeded 가 늦게 온다.
  test("옛 Pod 가 Ready 를 잃는 것은 진전이 아니다 — 마감은 그대로 600초", () => {
    const { c, t0 } = stuck();
    c.runFor(300_000 - (c.now - t0));
    const old = alive(c).find((p) => p.spec.containers[0]!.image === "example/api:1.1")!;
    expect(c.setPodHealth(old.metadata.name, false)).toBe(true);
    c.runFor(620_000 - (c.now - t0)); // 롤아웃 시작 + 620초
    expect(c.api.get("Deployment", "api")!.status.conditions?.find((x) => x.type === "Progressing")?.reason).toBe("ProgressDeadlineExceeded");
  });
});

describe("review4 kubectl rollout status", () => {
  // 기대(kubectl v1.31 rollout_status.go): generation > observedGeneration 이면 조건을 보지 않고 "Waiting for deployment spec update to be observed...".
  //       마감 초과 검사는 observedGeneration 이 따라잡은 뒤에만.
  // 실제(sim): rolloutStatusLine 이 ProgressDeadlineExceeded 를 generation 검사보다 먼저 봐서, 고친 이미지를 막 넣은 직후에도 error 를 낸다.
  test("마감 초과 뒤 새 이미지를 넣은 직후는 spec update 대기", () => {
    const { c } = stuck();
    c.runFor(700_000);
    expect(k(c, "rollout status deployment/api").output).toBe('error: deployment "api" exceeded its progress deadline'); // 전제
    k(c, "set image deployment/api api=example/api:1.0");
    expect(k(c, "rollout status deployment/api").output.split("\n")[0]).toBe("Waiting for deployment spec update to be observed...");
  });
});
