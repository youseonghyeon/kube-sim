// 리뷰 재현 테스트 (kubectl 출력 충실도). 리뷰(2026-10-02)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다. 테스트 이름은 결함 설명이다.
import { describe, expect, test } from "vitest";
import { HASH_LABEL } from "../src/core/controllers/deployment";
import { runKubectl } from "../src/core/kubectl";
import { templateHash } from "../src/core/rng";
import { fmtAge } from "../src/core/units";
import { cluster, pods, web } from "./helpers";

describe("review: kubectl 결함", () => {
  test("describe deployment: replicas 0 이면 NewReplicaSet 에 옛 템플릿의 ReplicaSet 이 나온다", () => {
    // 기대: NewReplicaSet = 지금 템플릿 해시의 ReplicaSet (실제 kubectl 은 템플릿이 같은 RS 를 고른다).
    // 실제: kubectl.ts 는 "replicas>0 인 첫 RS, 없으면 이름순 첫 RS" 를 골라, 0 으로 줄인 뒤에는
    //       이름이 앞서는 옛 RS(redis:7 템플릿)를 NewReplicaSet, 지금 RS 를 OldReplicaSets 로 보여 준다.
    const c = cluster();
    c.apply(web(1, "redis:7"));
    c.runToIdle();
    runKubectl(c, "set image deployment/web web=nginx:1.27");
    c.runToIdle();
    runKubectl(c, "scale deployment/web --replicas=0");
    c.runToIdle();
    const d = c.api.get("Deployment", "web")!;
    const current = c.api.list("ReplicaSet").find((r) => r.metadata.labels[HASH_LABEL] === templateHash(d.spec.template))!;
    const out = runKubectl(c, "describe deployment web").output;
    const line = out.split("\n").find((l) => l.startsWith("NewReplicaSet:"))!;
    expect(line).toContain(current.metadata.name);
  });

  test("get pods -n kube-system 이 default 의 Pod 를 그대로 보여 준다 (-n 을 조용히 무시)", () => {
    // 기대: 축소판이라 default 만 있다면, 다른 네임스페이스는 실제처럼 "No resources found in kube-system namespace."
    //       (또는 '축소판: default 만' 오류). 학습자가 kube-system 에 web Pod 가 있다고 오해하면 안 된다.
    // 실제: parseFlags 가 -n 값을 읽고 버린다 → default 의 Pod 목록이 나온다.
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    const out = runKubectl(c, "get pods -n kube-system").output;
    expect(out).not.toContain(pods(c)[0]!.metadata.name);
  });

  test("delete pod --grace-period=5 가 무시되고 유예 30초로 지운다", () => {
    // 기대: 실제 kubectl 처럼 deletionGracePeriodSeconds = 5 (describe 의 Termination Grace Period: 5s).
    // 실제: del() 은 --force 와 --grace-period=0 이 함께일 때만 플래그를 보고, 나머지는 조용히 기본 30초.
    //       (추측: --force 단독도 실제 kubectl 은 grace 0 으로 바꾸지만 여기서는 일반 삭제)
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    const name = pods(c)[0]!.metadata.name;
    expect(runKubectl(c, `delete pod ${name} --grace-period=5`).ok).toBe(true);
    expect(c.api.get("Pod", name)?.metadata.deletionGracePeriodSeconds).toBe(5);
  });

  test("delete deployment 출력이 실제(v1.31)와 다르다", () => {
    // 기대: kubectl v1.31 → `deployment.apps "web" deleted` (리소스는 group 포함, pod 와 같은 모양).
    // 실제: `deployment "web" deleted from default namespace` — .apps 가 빠지고, pod 에는 없는 접미사가 붙는다.
    const c = cluster();
    c.apply(web(1));
    c.runToIdle();
    expect(runKubectl(c, "delete deployment web").output).toBe('deployment.apps "web" deleted');
  });

  test("AGE: 48시간~8일, 2년 이상 표기가 HumanDuration 과 다르다", () => {
    // 기대 (apimachinery duration.HumanDuration): 50h → 2d2h, 800d → 2y70d.
    // 실제: 2d, 800d. (+1분·30× 로 오래 돌린 이벤트 LAST SEEN 에서 보인다 — 낮은 우선순위)
    expect(fmtAge(50 * 3600_000)).toBe("2d2h");
    expect(fmtAge(800 * 24 * 3600_000)).toBe("2y70d");
  });
});
