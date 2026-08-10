import { z } from "zod";

import { ConfirmedFindingSchema } from "./finding";
import {
  AuditIdSchema,
  SeveritySchema,
  StepIndexSchema,
  TimestampSchema,
  UrlSchema,
  ViewportSchema,
} from "./primitives";

/** Why a run ended. Always recorded — "it just stopped" is not an answer. */
export const TerminationReasonSchema = z.enum([
  /** The agent decided STOP. */
  "AGENT_STOPPED",
  /** The agent reported, and nothing was left to investigate. */
  "INVESTIGATION_COMPLETE",
  /** The step budget ran out. The backstop that guarantees termination. */
  "STEP_BUDGET_EXHAUSTED",
  /** The wall-clock budget ran out. */
  "TIME_BUDGET_EXHAUSTED",
  /**
   * The same state came back too many times in a row.
   *
   * The safety net for a page that answers every keypress identically: without
   * it, an agent that keeps choosing CONTINUE would spend the entire step budget
   * learning nothing.
   */
  "REPEATED_STATE",
  /** The page navigated off the target origin. */
  "NAVIGATED_AWAY",
  /** The model returned something unparseable often enough to give up. */
  "DECISION_INVALID",
  /** The AI provider failed or was unreachable. */
  "AI_ERROR",
  /** The browser driver failed. */
  "DRIVER_ERROR",
  /** A human stopped it. */
  "CANCELLED",
]);
export type TerminationReason = z.infer<typeof TerminationReasonSchema>;

export const AuditConfigSchema = z.object({
  maxSteps: z.number().int().positive(),
  settleMs: z.number().int().nonnegative(),
  viewport: ViewportSchema,
  /** Model identifier. Never a key — a key belongs in the environment only. */
  model: z.string().min(1),
});
export type AuditConfig = z.infer<typeof AuditConfigSchema>;

export const AuditErrorSchema = z.object({
  code: z.enum(["NAVIGATION_FAILED", "BROWSER_ERROR", "AI_ERROR", "INTERNAL"]),
  /** Scrubbed before it gets here: provider errors can echo request headers. */
  message: z.string().min(1),
});
export type AuditError = z.infer<typeof AuditErrorSchema>;

export const AuditStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type AuditStatus = z.infer<typeof AuditStatusSchema>;

/**
 * Summary counts for a finished run.
 *
 * `reachedCount` against `discoveredCount` is the headline number: the share of
 * a page's controls a keyboard user can actually get to.
 */
export const AuditSummarySchema = z.object({
  stepsExecuted: z.number().int().nonnegative(),
  discoveredCount: z.number().int().nonnegative(),
  reachedCount: z.number().int().nonnegative(),
  unreachableCount: z.number().int().nonnegative(),
  findingCountBySeverity: z.record(SeveritySchema, z.number().int().nonnegative()),
});
export type AuditSummary = z.infer<typeof AuditSummarySchema>;

/**
 * The deliverable.
 *
 * Only confirmed findings appear. A suspicion the agent never corroborated is
 * working state, not a result, and publishing it would make the report
 * something a reader has to second-guess.
 */
export const AuditReportSchema = z.object({
  auditId: AuditIdSchema,
  url: UrlSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  terminationReason: TerminationReasonSchema,
  config: AuditConfigSchema,
  findings: z.array(ConfirmedFindingSchema).readonly(),
  summary: AuditSummarySchema,
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

const auditBase = {
  id: AuditIdSchema,
  url: UrlSchema,
  config: AuditConfigSchema,
  createdAt: TimestampSchema,
};

/**
 * A run, as a state machine.
 *
 * Discriminated on `status` so that fields only exist where they mean
 * something: there is no `completedAt` on a run that has not started, and no
 * way to read a report off one that failed. `startedAt` appears from RUNNING
 * onward, which is exactly when it becomes knowable.
 */
export const AuditSchema = z.discriminatedUnion("status", [
  z.object({ ...auditBase, status: z.literal("PENDING") }),
  z.object({
    ...auditBase,
    status: z.literal("RUNNING"),
    startedAt: TimestampSchema,
    currentStep: StepIndexSchema,
  }),
  z.object({
    ...auditBase,
    status: z.literal("COMPLETED"),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    report: AuditReportSchema,
  }),
  z.object({
    ...auditBase,
    status: z.literal("FAILED"),
    startedAt: TimestampSchema,
    failedAt: TimestampSchema,
    error: AuditErrorSchema,
  }),
  z.object({
    ...auditBase,
    status: z.literal("CANCELLED"),
    startedAt: TimestampSchema,
    cancelledAt: TimestampSchema,
    /** Partial results are still worth keeping. */
    report: AuditReportSchema.nullable(),
  }),
]);
export type Audit = z.infer<typeof AuditSchema>;

export type PendingAudit = Extract<Audit, { status: "PENDING" }>;
export type RunningAudit = Extract<Audit, { status: "RUNNING" }>;
export type CompletedAudit = Extract<Audit, { status: "COMPLETED" }>;
export type FailedAudit = Extract<Audit, { status: "FAILED" }>;
export type CancelledAudit = Extract<Audit, { status: "CANCELLED" }>;

/** A run in a terminal state does not transition again. */
export function isTerminal(audit: Audit): boolean {
  return (
    audit.status === "COMPLETED" ||
    audit.status === "FAILED" ||
    audit.status === "CANCELLED"
  );
}
