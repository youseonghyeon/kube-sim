// 리뷰 4 (2026-10-02, 배포·종료·PDB/drain)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { runKubectl } from "../src/core/kubectl";
import { DefSync } from "../src/model/defSync";
import { exampleById } from "../src/model/examples";

describe("review4 rolling 예제", () => {
  // 문구(examples.ts rolling "이미지 바꾸기"): "전체 Pod 는 5개를 넘지 않고 Ready 는 3개 밑으로 내려가지 않습니다."
  // 실제(sim · 실제 k8s 모두): maxSurge 는 Terminating Pod 를 세지 않는다. 이 예제는 preStop 5초라 옛 Pod 가 5초 넘게 Terminating 으로 남아
  //       kubectl get pods(그리고 캔버스)에 web Pod 가 최대 8개 보인다. 동작은 맞고 문구가 틀렸다.
  // 학습 영향: 학습자가 화면에서 Pod 8개를 세고 "maxSurge 가 안 지켜졌다" 고 오해한다. 문구에 "(Terminating 제외)" 를 밝혀야 한다.
  test("이미지를 바꾸는 동안 kubectl get pods 의 web Pod 는 5개를 넘지 않는다 (문구 그대로)", () => {
    const s = new DefSync();
    s.reset(exampleById("rolling")!.build(), "rolling");
    const c = s.cluster;
    c.runFor(60_000);
    const step = exampleById("rolling")!.tries.find((t) => t.title === "이미지 바꾸기")!;
    expect(step.expect).toContain("Terminating 을 빼면 전체 Pod 는 5개를 넘지 않고"); // 고친 문구: Terminating 은 세지 않는다고 밝힘
    runKubectl(c, step.command!);
    let maxShown = 0;
    for (let t = 0; t < 60_000; t += 100) {
      c.runFor(100);
      const rows = runKubectl(c, "get pods").output.split("\n").filter((l) => l.startsWith("web-") && !l.includes("Terminating"));
      maxShown = Math.max(maxShown, rows.length);
    }
    expect(maxShown).toBeLessThanOrEqual(5);
  });
});
