// 화면 시계: 할 일(일반 이벤트)이 있을 때만 재생 속도로 흐르고, 없으면 멈춘다.
// net-sim 은 대기 이벤트만 있으면 그 시각으로 점프했지만, 여기서는 기다림 자체(이미지 pull 3초, 백오프 10초)가 배울 거리라 점프하지 않는다.
// 오래 기다려야 하면 속도를 올리거나 "+10초"·"+1분" 으로 흘려보낸다. DOM·신호에 의존하지 않아 유닛 테스트가 된다.
import type { Clock } from "../core/clock";

/** 한 화면 프레임에 처리할 이벤트 상한. 넘으면 폭주로 보고 일시정지 */
export const EVENT_BURST_LIMIT = 4000;

export interface ClockResult {
  time: number;
  changed: boolean;
  burst: boolean;
}

/** @returns 조용해서 아무것도 하지 않았으면 null */
export function advanceClock(clock: Clock, dtMs: number, speed: number, burstLimit = EVENT_BURST_LIMIT): ClockResult | null {
  if (clock.peekNextTime() === undefined) return null;
  const target = clock.now + dtMs * speed;
  let n = 0;
  while (clock.stepUntil(target)) {
    if (++n > burstLimit) return { time: clock.now, changed: true, burst: true };
  }
  if (target > clock.now) clock.now = target;
  return { time: clock.now, changed: n > 0, burst: false };
}
