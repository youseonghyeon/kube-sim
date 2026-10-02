// 컨트롤러 공통 틀: watch → 워크큐(같은 키는 합침) → reconcile(key) → 실패면 지수 백오프로 다시 큐에.
// 백오프는 일반 타이머다 (끝이 있다 — 성공하면 멈춤). 실패 횟수에 상한을 둬 끝없이 돌지 않게 한다.
import { ApiError, type ApiServer } from "../api/server";
import type { Clock } from "../clock";
import type { Trace } from "../trace";

/** client-go 기본 rate limiter 처럼 5ms 부터 두 배 (상한은 학습용으로 줄임: 실제 1000초) */
const RETRY_BASE_MS = 5;
const RETRY_MAX_MS = 60_000;
/** 이만큼 연속 실패하면 포기하고 로그에 남긴다 (끝없는 재시도 방지) */
const RETRY_LIMIT = 15;

export interface ComponentContext {
  clock: Clock;
  api: ApiServer;
  trace: Trace;
}

export abstract class Controller {
  private readonly queue = new Set<string>();
  private scheduled = false;
  private readonly failures = new Map<string, number>();

  constructor(
    readonly name: string,
    protected readonly ctx: ComponentContext,
  ) {}

  protected get api(): ApiServer {
    return this.ctx.api;
  }

  protected get now(): number {
    return this.ctx.clock.now;
  }

  enqueue(key: string): void {
    this.queue.add(key);
    if (this.scheduled) return;
    this.scheduled = true;
    // 같은 순간에 들어온 키를 모두 모은 뒤 처리 (net-sim LESSONS 4v)
    this.ctx.clock.after(0, this.name, () => this.drain());
  }

  private drain(): void {
    this.scheduled = false;
    const keys = [...this.queue];
    this.queue.clear();
    for (const key of keys) {
      try {
        this.reconcile(key);
        this.failures.delete(key);
      } catch (e) {
        const n = (this.failures.get(key) ?? 0) + 1;
        this.failures.set(key, n);
        const msg = e instanceof ApiError ? `${e.reason}: ${e.message}` : e instanceof Error ? e.message : String(e);
        if (n > RETRY_LIMIT) {
          this.ctx.trace.add(this.name, "controller.retry", `${key} reconcile 이 ${RETRY_LIMIT}번 연속 실패해 포기합니다 (${msg}) — 오브젝트를 고치면 다시 시도합니다`);
          this.failures.delete(key);
          continue;
        }
        const delay = Math.min(RETRY_BASE_MS * 2 ** (n - 1), RETRY_MAX_MS);
        this.ctx.trace.add(this.name, "controller.retry", `${key} reconcile 실패 (${msg}) → ${fmtDelay(delay)} 뒤 다시 시도 (${n}번째)`);
        this.ctx.clock.after(delay, this.name, () => this.enqueue(key));
      }
    }
  }

  protected abstract reconcile(key: string): void;
}

export function nsKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? "default"}/${name}`;
}

export function splitKey(key: string): [string, string] {
  const i = key.indexOf("/");
  return [key.slice(0, i), key.slice(i + 1)];
}

function fmtDelay(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${ms / 1000}초`;
}
