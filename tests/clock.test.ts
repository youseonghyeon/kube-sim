import { expect, test } from "vitest";
import { Clock } from "../src/core/clock";

test("같은 시각이면 넣은 순서대로", () => {
  const c = new Clock();
  const out: string[] = [];
  c.after(10, "a", () => out.push("a"));
  c.after(5, "b", () => out.push("b"));
  c.after(10, "c", () => out.push("c"));
  c.runToIdle();
  expect(out).toEqual(["b", "a", "c"]);
  expect(c.now).toBe(10);
});

test("배경 타이머는 시계를 움직이지 않는다 — 주기 동작이 있어도 runToIdle 이 끝난다", () => {
  const c = new Clock();
  let beats = 0;
  const beat = () => {
    beats++;
    c.background(1000, "heartbeat", beat);
  };
  c.background(1000, "heartbeat", beat);
  c.runToIdle();
  expect(beats).toBe(0);
  expect(c.now).toBe(0);
  // 다른 일로 시간이 지나가면 그 사이 배경 타이머가 발화
  c.after(3500, "work", () => {});
  c.runToIdle();
  expect(beats).toBe(3);
  c.runUntil(10_000);
  expect(beats).toBe(10);
});

test("취소한 타이머는 발화하지 않고 시계도 그 시각으로 뛰지 않는다", () => {
  const c = new Clock();
  let fired = false;
  const h = c.after(60_000, "x", () => (fired = true));
  h.cancel();
  c.runToIdle();
  expect(fired).toBe(false);
  expect(c.now).toBe(0);
  expect(c.peekNextTime()).toBeUndefined();
});

test("끝나지 않는 일반 타이머 사슬은 상한에서 멈추고 고치는 법을 알린다", () => {
  const c = new Clock();
  const loop = () => c.after(1, "loop", loop);
  loop();
  expect(() => c.runToIdle(100)).toThrow(/runToIdle: 이벤트 100개 초과/);
});
