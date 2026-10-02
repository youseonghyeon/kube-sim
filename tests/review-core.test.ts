// 리뷰 재현 테스트 (코어). 리뷰(2026-10-02)에서 찾은 결함마다 하나 — 고친 뒤 회귀 방지로 남긴다. 테스트 이름은 결함 설명이다.
import { describe, expect, test } from "vitest";
import { deployment } from "../src/core/cluster";
import { Clock } from "../src/core/clock";
import { cluster, pods, web } from "./helpers";

describe("review: 코어 결함", () => {
  test("긴 Deployment 이름(50자)이면 Pod 가 영원히 안 생긴다 — 실제는 generateName 이 이름을 잘라 만든다", () => {
    // 기대: Deployment 이름이 API 검증(63자)을 통과했으면 Pod 1개가 생겨 Running.
    // 실제: RS 이름 61자는 통과하지만 Pod 이름 `${rs}-xxxxx` 가 67자라 create 가 Invalid →
    //       replicaset-controller 가 15번 재시도 후 포기, Deployment 는 0/1 에서 영원히 멈춘다.
    // 실제 쿠버네티스는 generateName 의 앞부분을 58자로 잘라(maxGeneratedNameLength) 항상 63자 이하로 만든다.
    const c = cluster();
    const name = "a".repeat(50);
    c.apply(deployment(name, { replicas: 1, image: "nginx:1.27", cpu: 100, memory: 64 }));
    c.runToIdle();
    expect(c.trace.events.filter((e) => e.kind === "controller.retry")).toHaveLength(0);
    expect(pods(c)).toHaveLength(1);
  });

  test("Deployment 를 지우고 같은 이름·템플릿으로 바로 다시 만들면 AlreadyExists reconcile 실패가 반복된다", () => {
    // 기대: 지우고 다시 만드는 것은 흔한 동작(kubectl delete → apply). 재시도 없이 새 ReplicaSet 이 생긴다.
    // 실제: 옛 ReplicaSet(web-<hash>)은 가비지 컬렉터가 100ms 뒤에야 지우는데, 그 사이에 옛 RS 의
    //       watch 이벤트(주인 이름 web)가 새 Deployment 를 깨워 같은 이름의 RS 를 만들려다 AlreadyExists →
    //       로그에 "reconcile 실패 (AlreadyExists ...)" 가 여러 줄 찍힌다. 결국 맞춰지지만 학습자에게는 이유 없는 오류로 보인다.
    //       실제 deployment-controller 는 이름 충돌 시 collisionCount 를 올려 다른 해시로 만든다.
    const c = cluster();
    c.apply(web(3));
    c.runFor(110);
    c.api.delete("Deployment", "web", "default", "kubectl");
    c.apply(web(3));
    c.runToIdle();
    const retries = c.trace.events.filter((e) => e.kind === "controller.retry").map((e) => e.msg);
    expect(retries).toEqual([]);
    expect(pods(c).filter((p) => p.metadata.deletionTimestamp === undefined)).toHaveLength(3);
  });

  test("Pending Pod 가 다른 노드의 이미지 pull 완료(Node status.images 변경)만으로 다시 스케줄 시도된다", () => {
    // 기대: 자리가 없어 기다리는 Pod 는 '클러스터가 바뀌면'(자원·cordon·taint·라벨 변화, Pod 삭제) 다시 시도한다.
    //       실제 kube-scheduler 의 nodeSchedulingPropertiesChange 는 status.images 변화를 무시한다.
    // 실제: kubelet 이 pull 을 끝내고 Node.status.images 를 고치면 Node MODIFIED → retryUnschedulable →
    //       scheduler.fail 이 한 번 더 찍힌다(트레이스에 왜 다시 시도했는지도 없다 — _why 를 버림).
    //       pending 예제에서 학습자는 3.9초에 아무 변화 없이 "맞는 노드 없음" 을 또 본다.
    const c = cluster([
      { name: "n1", cpu: 1000 },
      { name: "n2", cpu: 1000 },
    ]);
    c.apply(deployment("api", { replicas: 3, image: "nginx:1.27", cpu: 600, memory: 128 }));
    c.runToIdle();
    const fails = c.trace.events.filter((e) => e.kind === "scheduler.fail");
    expect(fails).toHaveLength(1);
  });

  test("replicas 0 인 Deployment 의 템플릿을 바꾸면 'Scaled up replica set … from 0 to 0' 이벤트가 남는다", () => {
    // 기대: 실제 deployment-controller 는 새 RS 를 0 으로 만들 때 ScalingReplicaSet 이벤트를 남기지 않는다(newReplicasCount > 0 일 때만).
    // 실제: "Scaled up replica set web-xxx from 0 to 0" — 늘어난 것이 없는데 'up' 이라고 보인다.
    const c = cluster();
    c.apply(web(0));
    c.runToIdle();
    c.apply(web(0, "nginx:1.28"));
    c.runToIdle();
    const msgs = c.api.events.filter((e) => e.reason === "ScalingReplicaSet").map((e) => e.message);
    expect(msgs.filter((m) => /from 0 to 0$/.test(m))).toEqual([]);
  });

  test("runToIdle(maxEvents) 는 정확히 maxEvents 개를 처리하고 끝나도 '초과' 로 던진다 (off-by-one)", () => {
    // 기대: 이벤트 1개를 처리하고 큐가 비었으면 runToIdle(1) 은 정상 종료 (메시지도 '초과' 라고 말한다).
    // 실제: ++n >= maxEvents 라 N 번째 이벤트를 처리한 직후 무조건 던진다. runUntil 도 같다.
    //       fastForward(runFor(ms, 100_000)) 가 딱 한도만큼 일한 경우 "폭주" 로 잘못 멈춘다.
    const clock = new Clock();
    clock.after(1, "x", () => {});
    expect(() => clock.runToIdle(1)).not.toThrow();
    const c2 = new Clock();
    c2.after(1, "x", () => {});
    expect(() => c2.runUntil(10, 1)).not.toThrow();
  });
});
