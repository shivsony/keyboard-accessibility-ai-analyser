import { z } from "zod";

/**
 * Shared primitives for the domain model.
 *
 * Conventions used throughout `domain/`:
 *
 * - **`null`, not `optional`.** Absence is modelled explicitly so that
 *   `exactOptionalPropertyTypes` never turns "field omitted" and "field is
 *   undefined" into two different states. A run record is serialized to JSON and
 *   read back; one representation of absence is enough.
 * - **Arrays are `.readonly()`.** State is threaded through the agent loop and
 *   must not be mutated in place by whichever module happens to hold it.
 * - **Timestamps are ISO strings.** `Date` does not survive a JSON round-trip,
 *   and every observation ends up in a run directory.
 * - **Nothing here imports a framework.** No React, no Next, no Playwright.
 */

/** Branded string ids, so an ElementId can never be passed where a NodeId belongs. */
export const AuditIdSchema = z.string().min(1).brand<"AuditId">();
export type AuditId = z.infer<typeof AuditIdSchema>;

export const ElementIdSchema = z.string().min(1).brand<"ElementId">();
export type ElementId = z.infer<typeof ElementIdSchema>;

export const NodeIdSchema = z.string().min(1).brand<"NodeId">();
export type NodeId = z.infer<typeof NodeIdSchema>;

export const ScreenshotIdSchema = z.string().min(1).brand<"ScreenshotId">();
export type ScreenshotId = z.infer<typeof ScreenshotIdSchema>;

export const FindingIdSchema = z.string().min(1).brand<"FindingId">();
export type FindingId = z.infer<typeof FindingIdSchema>;

export const auditId = (value: string): AuditId => AuditIdSchema.parse(value);
export const elementId = (value: string): ElementId => ElementIdSchema.parse(value);
export const nodeId = (value: string): NodeId => NodeIdSchema.parse(value);
export const screenshotId = (value: string): ScreenshotId =>
  ScreenshotIdSchema.parse(value);
export const findingId = (value: string): FindingId => FindingIdSchema.parse(value);

/**
 * Zero-based index of a step in the agent loop.
 *
 * Step `n` is the nth iteration of observe → decide → guard → execute.
 */
export const StepIndexSchema = z.number().int().nonnegative();
export type StepIndex = z.infer<typeof StepIndexSchema>;

/** ISO-8601 instant. */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/**
 * Model confidence, 0–1.
 *
 * Branded because a bare `number` here is easy to confuse with a severity score
 * or a step count, and the value drives whether a finding is reported.
 */
export const ConfidenceSchema = z.number().min(0).max(1).brand<"Confidence">();
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const confidence = (value: number): Confidence => ConfidenceSchema.parse(value);

/** Impact of a confirmed finding on a keyboard user. */
export const SeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_ORDER: readonly Severity[] = Object.freeze([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

/** Viewport the observation was taken at. Screenshots are only meaningful with it. */
export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
});
export type Viewport = z.infer<typeof ViewportSchema>;

/** CSS-pixel rect, page-relative. Used as evidence, never to target an action. */
export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});
export type BoundingBox = z.infer<typeof BoundingBoxSchema>;

/** Absolute http(s) URL. */
export const UrlSchema = z
  .url()
  .refine(
    (value) => value.startsWith("http://") || value.startsWith("https://"),
    "URL must be http or https",
  );
export type Url = z.infer<typeof UrlSchema>;
