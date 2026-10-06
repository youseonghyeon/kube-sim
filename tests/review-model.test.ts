// 리뷰 재현 테스트 (모델·화면). 리뷰(2026-10-02)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다. 테스트 이름은 결함 설명이다.
import { describe, expect, test } from "vitest";
import { runKubectl } from "../src/core/kubectl";
import { DefSync } from "../src/model/defSync";
import { EXAMPLES, resolveCommand } from "../src/model/examples";
import { toYaml } from "../src/core/yaml";
import { cluster, pods, web } from "./helpers";

describe("review: 모델·화면 결함", () => {
  test("YAML 탭의 requests 가 내부 단위 숫자(cpu: 250, memory: 128)로 나온다 — 실제 YAML 로 읽으면 250코어·128바이트", () => {
    // 기대: 인스펙터 YAML 탭은 실제 매니페스트처럼 cpu: 250m, memory: 128Mi.
    // 실제: toYaml(obj) 가 코어 내부 표현(millicore·MiB 숫자)을 그대로 찍는다. requests 를 배우는 사용자가
    //       이 YAML 을 복사하면 250 CPU·128 바이트를 요청하게 된다.
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    const y = toYaml(pods(c)[0]);
    expect(y).toContain("cpu: 250m");
    expect(y).toContain("memory: 128Mi");
  });

  test("YAML 탭의 condition status 가 따옴표 없이 True 로 나온다 (YAML 에서는 boolean)", () => {
    // 기대: 실제 kubectl -o yaml 처럼 status: "True" — 쿠버네티스 condition status 는 문자열이다.
    // 실제: scalar() 가 소문자 true/false 만 따옴표를 붙여 True/False 는 맨 글자로 나온다.
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    const y = toYaml(pods(c)[0]);
    expect(y).toContain('status: "True"');
  });

  test("pending 예제: '해 볼 것' 순서대로 하면 'replicas 줄이기' 때 Pending Pod 가 이미 없다", () => {
    // 기대: '해 볼 것' 3번 expect 는 "ReplicaSet 은 지울 Pod 로 아직 안 뜬 것(Pending)부터 고릅니다" — 볼 수 있어야 한다.
    // 실제: 2번 'requests 줄이기'(400m) 뒤에는 4개가 모두 Running 이라 3번에서 Pending 이 없다 → 약속한 학습 포인트가 안 보인다.
    const ex = EXAMPLES.find((e) => e.id === "pending")!;
    const s = new DefSync();
    s.reset(ex.build(), "x");
    s.cluster.runFor(120_000);
    const step3 = ex.tries.findIndex((t) => t.title === "replicas 줄이기");
    for (const t of ex.tries.slice(0, step3)) {
      if (!t.command) continue;
      runKubectl(s.cluster, resolveCommand(s.cluster.api.list("Pod"), t.command)!);
      s.cluster.runFor(60_000);
    }
    expect(s.cluster.api.list("Pod").some((p) => !p.spec.nodeName)).toBe(true);
  });
});
