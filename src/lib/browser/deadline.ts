import { BrowserLayerError } from "./errors";

/**
 * The audit-wide time budget.
 *
 * Per-operation timeouts alone do not bound a run: a hundred operations that
 * each finish just inside their limit still run forever. The deadline is the
 * ceiling on the whole session, and every operation is clamped to whatever is
 * left of it.
 */
export class Deadline {
  private readonly endsAt: number;

  private constructor(endsAt: number) {
    this.endsAt = endsAt;
  }

  static in(milliseconds: number, now: number = Date.now()): Deadline {
    return new Deadline(now + milliseconds);
  }

  /** A deadline that never expires. For tests and unbounded local use. */
  static never(): Deadline {
    return new Deadline(Number.POSITIVE_INFINITY);
  }

  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.endsAt - now);
  }

  hasExpired(now: number = Date.now()): boolean {
    return this.remainingMs(now) <= 0;
  }

  /**
   * The timeout an operation should actually use: its own limit, or whatever
   * remains of the audit, whichever is smaller.
   */
  clamp(operationTimeoutMs: number, now: number = Date.now()): number {
    return Math.min(operationTimeoutMs, this.remainingMs(now));
  }

  assertNotExpired(now: number = Date.now()): void {
    if (this.hasExpired(now)) {
      throw new BrowserLayerError("AUDIT_TIMEOUT", "The audit time budget is exhausted");
    }
  }
}

/**
 * Bounds a promise that has no timeout of its own.
 *
 * `page.evaluate` will happily wait forever on a page that has wedged its own
 * main thread, so the calls that Playwright does not time out get one here.
 * The underlying promise is not cancellable — the rejection releases *us*, and
 * teardown handles the rest.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout: () => BrowserLayerError,
): Promise<T> {
  if (!Number.isFinite(timeoutMs)) {
    return operation;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(onTimeout());
      },
      Math.max(0, timeoutMs),
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // The loser of the race may still reject later; without this, Node reports
    // an unhandled rejection for a promise nobody is waiting on any more.
    void operation.catch(() => undefined);
  }
}
