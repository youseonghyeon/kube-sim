// 시뮬레이션 시계와 이벤트 큐 (net-sim network.ts 의 큐 개념).
// - 일반 타이머: 시계를 그 시각으로 움직일 수 있다. 끝이 있는 기다림(이미지 pull, 재시작 백오프)에 쓴다.
// - 배경 타이머: 스스로는 시계를 움직이지 않고, 다른 일로 시간이 그 시각을 지날 때만 발화한다.
//   끝나지 않는 주기 동작(heartbeat·resync·probe 주기)은 반드시 이것으로 — 일반 타이머로 넣으면 runToIdle 이 끝나지 않는다.
// 같은 시각이면 넣은 순서(seq) 로 꺼낸다 → 결정론.

export interface TimerHandle {
  readonly at: number;
  readonly cancelled: boolean;
  cancel(): void;
}

interface Entry {
  at: number;
  seq: number;
  actor: string;
  run: () => void;
  cancelled: boolean;
}

class Heap {
  private h: Entry[] = [];

  get size(): number {
    return this.h.length;
  }

  push(e: Entry): void {
    this.h.push(e);
    let i = this.h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(this.h[i]!, this.h[p]!)) break;
      [this.h[i], this.h[p]] = [this.h[p]!, this.h[i]!];
      i = p;
    }
  }

  /** 취소된 항목을 건너뛴 맨 앞 */
  peek(): Entry | undefined {
    while (this.h.length && this.h[0]!.cancelled) this.pop();
    return this.h[0];
  }

  pop(): Entry | undefined {
    const h = this.h;
    if (!h.length) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }

  clear(): void {
    this.h = [];
  }
}

function less(a: Entry, b: Entry): boolean {
  return a.at !== b.at ? a.at < b.at : a.seq < b.seq;
}

export class Clock {
  /** 마지막으로 처리한 이벤트 시각(ms) */
  now = 0;
  /** 처리한 이벤트 수 */
  eventCount = 0;
  private seq = 0;
  private readonly q = new Heap();
  private readonly bg = new Heap();

  /** delay(ms) 뒤에 한 번 실행하는 일반 타이머 */
  after(delay: number, actor: string, run: () => void): TimerHandle {
    return this.push(this.q, delay, actor, run);
  }

  /** 배경 타이머: 시계를 스스로 움직이지 않는다 (주기 동작 전용) */
  background(delay: number, actor: string, run: () => void): TimerHandle {
    return this.push(this.bg, delay, actor, run);
  }

  private push(heap: Heap, delay: number, actor: string, run: () => void): TimerHandle {
    if (!(delay >= 0)) throw new Error(`clock: 음수·NaN 지연 ${delay}ms (${actor})`);
    const e: Entry = { at: this.now + delay, seq: this.seq++, actor, run, cancelled: false };
    heap.push(e);
    return {
      at: e.at,
      get cancelled() {
        return e.cancelled;
      },
      cancel: () => {
        e.cancelled = true;
      },
    };
  }

  peekNextTime(): number | undefined {
    return this.q.peek()?.at;
  }

  peekBackgroundTime(): number | undefined {
    return this.bg.peek()?.at;
  }

  /** limit 시각 이하의 이벤트 하나를 처리한다 (배경 타이머 포함). 없으면 false */
  stepUntil(limit: number): boolean {
    const next = this.peekNextTime();
    const bgAt = this.peekBackgroundTime();
    let e: Entry | undefined;
    if (bgAt !== undefined && bgAt <= limit && (next === undefined || bgAt < next)) e = this.bg.pop();
    else if (next !== undefined && next <= limit) e = this.q.pop();
    if (!e) return false;
    this.now = Math.max(this.now, e.at);
    this.eventCount++;
    e.run();
    return true;
  }

  private hasEventUntil(time: number): boolean {
    const next = this.peekNextTime();
    const bg = this.peekBackgroundTime();
    return (next !== undefined && next <= time) || (bg !== undefined && bg <= time);
  }

  /** 다음 일반 이벤트까지 (그 사이 배경 타이머 포함) 하나 처리 */
  step(): boolean {
    const next = this.peekNextTime();
    if (next === undefined) return false;
    return this.stepUntil(next);
  }

  /** time 까지 진행. 배경 타이머도 그 사이에 발화한다 */
  runUntil(time: number, maxEvents = 100_000): number {
    let n = 0;
    while (this.stepUntil(time)) {
      if (++n >= maxEvents && this.hasEventUntil(time)) throw new Error(`runUntil: 이벤트 ${maxEvents}개 초과 — 컨트롤러가 서로를 계속 고치는 구성인지 확인하세요`);
    }
    if (time > this.now) this.now = time;
    return n;
  }

  /** 일반 이벤트가 없을 때까지 진행 (배경 타이머만 남으면 멈춘다) */
  runToIdle(maxEvents = 100_000): number {
    let n = 0;
    while (this.step()) {
      if (++n >= maxEvents && this.peekNextTime() !== undefined) throw new Error(`runToIdle: 이벤트 ${maxEvents}개 초과 — 끝나지 않는 일반 타이머 사슬이 있는지 확인하세요`);
    }
    return n;
  }
}
