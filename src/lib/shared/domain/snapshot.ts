import { z } from "zod";

import {
  ScreenshotIdSchema,
  StepIndexSchema,
  TimestampSchema,
  ViewportSchema,
} from "./primitives";

/**
 * A bounded structural digest of the DOM — not the full document.
 *
 * Truncation is deliberate and recorded: an observation that silently dropped
 * half the page would make a finding unreproducible, so `truncated` travels
 * with the evidence.
 */
export const DOMSnapshotSchema = z.object({
  /** Structural summary. Page-controlled text — untrusted, escaped on display. */
  summary: z.string(),
  /** Nodes considered when building the summary, before truncation. */
  nodeCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  capturedAt: TimestampSchema,
});
export type DOMSnapshot = z.infer<typeof DOMSnapshotSchema>;

/**
 * The ARIA view of the page, as emitted by Playwright's `ariaSnapshot()`.
 *
 * This deliberately preserves Playwright's YAML instead of reverse-engineering
 * it into a lossy local tree. `mode: "ai"` includes stable-in-snapshot element
 * references and iframe contents, both useful to a model reasoning about the
 * current browser state. It is evidence, not an accessibility verdict.
 */
export const AccessibilitySnapshotSchema = z.object({
  snapshot: z.string(),
  nodeCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  capturedAt: TimestampSchema,
});
export type AccessibilitySnapshot = z.infer<typeof AccessibilitySnapshotSchema>;

/**
 * A screenshot on disk.
 *
 * Observations and findings reference screenshots by id rather than embedding
 * image data, so state stays cheap to pass around and to serialize.
 */
export const ScreenshotEvidenceSchema = z.object({
  id: ScreenshotIdSchema,
  /** Path relative to the run directory. Never an absolute host path. */
  path: z.string().min(1),
  step: StepIndexSchema,
  viewport: ViewportSchema,
  capturedAt: TimestampSchema,
  format: z.literal("png"),
});
export type ScreenshotEvidence = z.infer<typeof ScreenshotEvidenceSchema>;
