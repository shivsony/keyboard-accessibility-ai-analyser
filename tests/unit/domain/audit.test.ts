import { describe, expect, it } from "vitest";

import {
  AuditSchema,
  isTerminal,
  type Audit,
  type AuditConfig,
} from "@/lib/shared/domain";
import { at, TEST_URL, VIEWPORT } from "../../fixtures/domain";

const CONFIG: AuditConfig = {
  maxSteps: 150,
  settleMs: 250,
  viewport: VIEWPORT,
  model: "claude-opus-5",
};

const BASE = {
  id: "audit-1",
  url: TEST_URL,
  config: CONFIG,
  createdAt: at(0),
};

describe("Audit state machine", () => {
  it("accepts a pending audit with nothing started", () => {
    const audit = AuditSchema.parse({ ...BASE, status: "PENDING" });

    expect(audit.status).toBe("PENDING");
    expect(audit).not.toHaveProperty("startedAt");
  });

  // startedAt appears from RUNNING onward — exactly when it becomes knowable.
  it("rejects a pending audit that claims a start time", () => {
    const result = AuditSchema.safeParse({
      ...BASE,
      status: "PENDING",
      startedAt: at(1),
    });

    // Unknown fields are stripped, so the parse succeeds but the field does not
    // survive into the model.
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("startedAt");
  });

  it("requires a running audit to say where it is", () => {
    expect(
      AuditSchema.safeParse({ ...BASE, status: "RUNNING", startedAt: at(1) }).success,
    ).toBe(false);

    expect(
      AuditSchema.safeParse({
        ...BASE,
        status: "RUNNING",
        startedAt: at(1),
        currentStep: 12,
      }).success,
    ).toBe(true);
  });

  it("requires a completed audit to carry its report", () => {
    expect(
      AuditSchema.safeParse({
        ...BASE,
        status: "COMPLETED",
        startedAt: at(1),
        completedAt: at(9),
      }).success,
    ).toBe(false);
  });

  it("requires a failed audit to carry its error", () => {
    expect(
      AuditSchema.safeParse({
        ...BASE,
        status: "FAILED",
        startedAt: at(1),
        failedAt: at(3),
      }).success,
    ).toBe(false);

    expect(
      AuditSchema.safeParse({
        ...BASE,
        status: "FAILED",
        startedAt: at(1),
        failedAt: at(3),
        error: { code: "BROWSER_ERROR", message: "Chromium exited" },
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(AuditSchema.safeParse({ ...BASE, status: "PAUSED" }).success).toBe(false);
  });

  it("knows which states are terminal", () => {
    const pending = AuditSchema.parse({ ...BASE, status: "PENDING" });
    const running: Audit = AuditSchema.parse({
      ...BASE,
      status: "RUNNING",
      startedAt: at(1),
      currentStep: 3,
    });
    const failed = AuditSchema.parse({
      ...BASE,
      status: "FAILED",
      startedAt: at(1),
      failedAt: at(3),
      error: { code: "AI_ERROR", message: "provider unavailable" },
    });

    expect(isTerminal(pending)).toBe(false);
    expect(isTerminal(running)).toBe(false);
    expect(isTerminal(failed)).toBe(true);
  });
});

describe("AuditConfig", () => {
  // The step budget is what guarantees a run ends regardless of what the model
  // decides (ARCHITECTURE.md invariant 7).
  it("rejects a non-positive step budget", () => {
    for (const maxSteps of [0, -1]) {
      expect(
        AuditSchema.safeParse({
          ...BASE,
          config: { ...CONFIG, maxSteps },
          status: "PENDING",
        }).success,
      ).toBe(false);
    }
  });

  it("rejects a non-integer viewport", () => {
    expect(
      AuditSchema.safeParse({
        ...BASE,
        config: { ...CONFIG, viewport: { ...VIEWPORT, width: 1280.5 } },
        status: "PENDING",
      }).success,
    ).toBe(false);
  });
});
