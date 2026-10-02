// 리뷰 4 (2026-10-02, 배포·종료·PDB/drain)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { deployment } from "../src/core/cluster";
import { runKubectl } from "../src/core/kubectl";
import { cluster, pods } from "./helpers";

describe("review4 preStop 이 유예를 다 쓴 경우", () => {
  // 기대(k8s v1.31 kuberuntime_container.go killContainer): preStop 이 유예를 다 써도 gracePeriod < minimumGracePeriodInSeconds(2) 이면 2초로 올려
  //       StopContainer(SIGTERM) 를 보낸다 ("always give containers a minimal shutdown window to avoid unnecessary SIGKILLs").
  //       nginx 는 SIGTERM 에 0.3초 만에 exit 0 → Pod 는 30.3초쯤 사라지고 SIGKILL 은 없다.
  // 실제(sim): kubelet.terminate 가 preStopMs >= grace 면 SIGTERM 없이 grace 시각에 finish(137) — "SIGKILL" 로 가르친다.
  // 참고: tests/shutdown.test.ts 의 "preStop 이 유예 시간을 넘으면 SIGKILL" 이 지금 동작을 고정하고 있어, 고치면 그 테스트도 바꿔야 한다.
  // 학습 영향: "preStop 이 길면 SIGKILL 당한다" 는 실제와 다른 결론. 실제는 2초 창이 있어 SIGTERM 을 처리하는 앱은 정상 종료한다.
  test("preStop 40초 · 유예 30초: 30초에 SIGTERM, 2초 창 안에 정상 종료 (SIGKILL 없음)", () => {
    const c = cluster([{ name: "w1" }]);
    c.apply(deployment("web", { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64, preStop: 40 }));
    c.runFor(10_000);
    const p = pods(c)[0]!.metadata.name;
    const from = c.trace.events.length;
    runKubectl(c, `delete pod ${p}`);
    c.runFor(30_100);
    expect(c.api.get("Pod", p)).toBeDefined(); // 30초에 SIGTERM, nginx 는 0.3초 뒤 종료 → 아직 있음
    c.runFor(2_000);
    expect(c.api.get("Pod", p)).toBeUndefined();
    const mine = c.trace.events.slice(from).filter((e) => e.actor.startsWith("kubelet") && e.msg.includes(p));
    expect(mine.some((e) => e.msg.includes("SIGTERM"))).toBe(true);
    expect(mine.some((e) => e.msg.includes("SIGKILL"))).toBe(false);
  });
});
