import { describe, expect, it } from "vitest";

import { BrowserLayerError, Deadline, withTimeout } from "@/lib/browser";

describe("Deadline", () => {
  const T0 = 1_000_000;

  it("tracks the remaining budget", () => {
    const deadline = Deadline.in(5_000, T0);

    expect(deadline.remainingMs(T0)).toBe(5_000);
    expect(deadline.remainingMs(T0 + 2_000)).toBe(3_000);
    expect(deadline.hasExpired(T0 + 4_999)).toBe(false);
  });

  it("never reports negative time remaining", () => {
    const deadline = Deadline.in(1_000, T0);

    expect(deadline.remainingMs(T0 + 10_000)).toBe(0);
    expect(deadline.hasExpired(T0 + 10_000)).toBe(true);
  });

  // Per-operation timeouts alone do not bound a run: a hundred operations that
  // each finish just inside their limit still run forever.
  it("clamps an operation timeout to what is left of the audit", () => {
    const deadline = Deadline.in(5_000, T0);

    expect(deadline.clamp(30_000, T0)).toBe(5_000);
    expect(deadline.clamp(1_000, T0)).toBe(1_000);
    expect(deadline.clamp(30_000, T0 + 4_000)).toBe(1_000);
    expect(deadline.clamp(30_000, T0 + 9_000)).toBe(0);
  });

  it("throws once the budget is exhausted", () => {
    const deadline = Deadline.in(1_000, T0);

    expect(() => deadline.assertNotExpired(T0)).not.toThrow();
    expect(() => deadline.assertNotExpired(T0 + 2_000)).toThrow(BrowserLayerError);

    try {
      deadline.assertNotExpired(T0 + 2_000);
    } catch (error) {
      if (error instanceof BrowserLayerError) expect(error.code).toBe("AUDIT_TIMEOUT");
    }
  });

  it("supports an unbounded deadline for local use", () => {
    const deadline = Deadline.never();

    expect(deadline.hasExpired()).toBe(false);
    expect(deadline.clamp(30_000)).toBe(30_000);
  });
});

describe("withTimeout", () => {
  it("passes through a value that arrives in time", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, () => fail())).resolves.toBe(
      "ok",
    );
  });

  it("passes through a rejection unchanged", async () => {
    const boom = new Error("boom");

    await expect(withTimeout(Promise.reject(boom), 1_000, () => fail())).rejects.toBe(
      boom,
    );
  });

  // page.evaluate will wait forever on a page that has wedged its own main
  // thread, so the calls Playwright does not bound get bounded here.
  it("rejects with the supplied error when the operation hangs", async () => {
    const forever = new Promise<never>(() => {});

    await expect(withTimeout(forever, 10, fail)).rejects.toThrow(BrowserLayerError);
  });

  it("does not leave an unhandled rejection behind after timing out", async () => {
    let rejectLate: (error: Error) => void = () => undefined;
    const late = new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    });

    await expect(withTimeout(late, 10, fail)).rejects.toThrow(BrowserLayerError);

    // The loser of the race rejects after nobody is waiting. Without the
    // catch inside withTimeout, Node reports an unhandled rejection here.
    rejectLate(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("skips the race entirely when the timeout is infinite", async () => {
    await expect(
      withTimeout(Promise.resolve(7), Number.POSITIVE_INFINITY, fail),
    ).resolves.toBe(7);
  });
});

function fail(): BrowserLayerError {
  return new BrowserLayerError("AUDIT_TIMEOUT", "timed out");
}
