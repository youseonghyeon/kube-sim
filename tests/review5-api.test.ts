// 리뷰 5 (2026-10-02, 바깥에서 들어오는 길)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다.
import { describe, expect, test } from "vitest";
import { service } from "../src/core/cluster";
import { cluster } from "./helpers";

describe("review5 Service externalTrafficPolicy 검증", () => {
  // 기대(실제 API 서버 validateServiceExternalTrafficPolicy): ClusterIP Service 를 externalTrafficPolicy 와 함께 만들면
  //       `spec.externalTrafficPolicy: Invalid value: "Local": may only be set for externally-accessible services` 로 거절.
  //       (kubectl patch 경로는 이미 이 문구로 거절한다 — kubectl.ts:806)
  // 실제(sim): allocateServiceAddresses 가 조용히 지워 apply 가 성공한다 — 정의 편집기·apply 로 넣은 Local 이 말없이 사라짐.
  // 학습 영향: Local 을 넣었는데 아무 효과도 경고도 없어, Local 이 왜 안 먹는지 모른다. patch 와 apply 가 다르게 동작.
  // 원인: src/core/api/server.ts:315.
  test("ClusterIP + externalTrafficPolicy: Local 생성은 Invalid 로 거절된다", () => {
    const c = cluster([{ name: "w1" }]);
    expect(() => c.apply(service("b", { selector: { app: "x" }, port: 80, externalTrafficPolicy: "Local" }))).toThrow(/may only be set for externally-accessible services/);
  });
});
