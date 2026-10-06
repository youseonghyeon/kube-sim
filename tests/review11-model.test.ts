// 리뷰 11: 모델(src/model) 과 예제 "해 볼 것" 설명의 결함 재현 테스트. 모두 지금 코드에서 실패해야 한다 (고친 뒤 통과).
import { describe, expect, test } from "vitest";
import { DefSync } from "../src/model/defSync";
import { exampleById, type ClusterDef } from "../src/model/examples";
import { runKubectl } from "../src/core/kubectl";

function load(id: string, ms = 30_000) {
  const ex = exampleById(id)!;
  const s = new DefSync();
  const def = ex.build();
  s.reset(def, id);
  s.cluster.runFor(ms);
  return { s, c: s.cluster, def, ex };
}

describe("저장된 정의(localStorage) 복원", () => {
  // store.ts 의 isDef 는 nodes 만 검사한다. 매니페스트가 깨져 있으면(옛 버전·손으로 고친 값) DefSync.reset 이 던지고,
  // SimController 생성자(모듈 평가 시점)에서 터져 화면 전체가 빈 채로 남는다 — 새로고침해도 같은 값을 다시 읽으므로 영영 복구되지 않는다.
  test("매니페스트에 resources 가 없는 Deployment 가 저장돼 있어도 reset 이 던지지 않는다 (그 매니페스트만 실패로 남기고 나머지는 올린다)", () => {
    const def: ClusterDef = {
      nodes: [{ name: "worker-1", cpu: 2000, memory: 4096 }],
      manifests: [
        {
          kind: "Deployment",
          metadata: { name: "old" },
          spec: { replicas: 1, selector: { matchLabels: { app: "old" } }, template: { metadata: { labels: { app: "old" } }, spec: { containers: [{ name: "old", image: "nginx:1.27" }] } } },
        } as never,
      ],
    };
    const s = new DefSync();
    expect(() => s.reset(def, "저장된 구성으로 시작")).not.toThrow();
    expect(s.cluster.api.list("Node")).toHaveLength(1);
  });

  test("metadata 가 없는 매니페스트({})가 섞여 있어도 reset 이 던지지 않는다", () => {
    const def: ClusterDef = { nodes: [{ name: "worker-1", cpu: 2000, memory: 4096 }], manifests: [{} as never] };
    const s = new DefSync();
    expect(() => s.reset(def, "저장된 구성으로 시작")).not.toThrow();
  });
});

describe("예제 '해 볼 것' 의 sick 동작 (sim.actionBlocked / runAction)", () => {
  // actionPod 는 "이름순 첫 번째 돌고 있는 Pod" 만 본다. 인스펙터의 '앱 고장 내기' 로 다른 Pod 를 고장 내면
  // 해 볼 것의 '고치기' 는 "고장 난 Pod 가 없습니다" 로 비활성이고, '고장 내기' 는 멀쩡한 첫 Pod 를 하나 더 고장 낸다.
  test("readiness: 두 번째 Pod 를 고장 내면 '고치기' 가 그 Pod 를 고친다 (비활성이 아님)", async () => {
    const { sim } = await import("../src/model/sim");
    const { loadExample } = await import("../src/model/store");
    loadExample("readiness");
    sim.reset();
    const c = sim.cluster;
    c.runFor(40_000);
    const ex = exampleById("readiness")!;
    const heal = ex.tries.find((t) => t.title === "고치기")!.action!;
    const apis = c.api.list("Pod", "default").filter((p) => p.metadata.labels.app === "api");
    expect(apis.length).toBe(3);
    c.setPodHealth(apis[1]!.metadata.name, false); // 인스펙터 버튼과 같음
    expect(c.podSick(apis[1]!.metadata.name)).toBe(true);
    expect(sim.actionBlocked(heal)).toBeUndefined();
    expect(sim.runAction(heal)).toBeUndefined();
    expect(apis.map((p) => c.podSick(p.metadata.name))).toEqual([false, false, false]);
  });

  test("readiness: 이미 고장 난 Pod 가 있으면 '고장 내기' 는 막힌다 (한 개만 고장 내는 실습)", async () => {
    const { sim } = await import("../src/model/sim");
    const { loadExample } = await import("../src/model/store");
    loadExample("readiness");
    sim.reset();
    const c = sim.cluster;
    c.runFor(40_000);
    const ex = exampleById("readiness")!;
    const sick = ex.tries.find((t) => t.title === "api Pod 하나 고장 내기")!.action!;
    const apis = c.api.list("Pod", "default").filter((p) => p.metadata.labels.app === "api");
    c.setPodHealth(apis[2]!.metadata.name, false);
    expect(sim.actionBlocked(sick)).toBe("이미 고장 냈습니다");
  });
});

describe("예제 설명과 실제 동작", () => {
  // graceful 'Pod 하나 지우기': 설명은 "연결 거부" 만 말했지만, nginx 가 0.3초 만에 끝나 Pod 가 사라진 뒤에도 규칙에 남은 IP 로 가서
  // "이미 사라진 Pod 의 IP → 응답 없음" 으로도 실패한다. 설명을 두 가지(연결 거부 → 응답 없음)로 고쳤다.
  test("graceful: preStop 없이 Pod 를 지울 때의 실패 이유가 설명(연결 거부 · 응답 없음)과 같다", () => {
    const { c } = load("graceful");
    const client = c.api.list("Pod", "default").find((p) => p.metadata.labels.app === "client")!.metadata.name;
    c.startTraffic(client, "http://web", 100);
    c.runFor(3000);
    const victim = c.api.list("Pod", "default").find((p) => p.metadata.labels.app === "web")!.metadata.name;
    runKubectl(c, `kubectl delete pod ${victim}`);
    c.runFor(10_000);
    const reasons = c.traffic!.samples.filter((x) => !x.ok).map((x) => x.reason ?? "");
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((r) => r.includes("연결 거부") || r.includes("응답 없음"))).toBe(true);
    const ex = exampleById("graceful")!.tries.find((t) => t.title === "Pod 하나 지우기")!;
    expect(ex.expect).toContain("연결 거부");
    expect(ex.expect).toContain("응답 없음");
  });
});
