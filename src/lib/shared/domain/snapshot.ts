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
 * A node in the accessibility tree.
 *
 * Recursive, so the schema needs an explicit type annotation — TypeScript
 * cannot infer a type that refers to itself.
 */
export type AccessibilityNode = {
  role: string;
  name: string | null;
  value: string | null;
  focused: boolean;
  disabled: boolean;
  children: readonly AccessibilityNode[];
};

export const AccessibilityNodeSchema: z.ZodType<AccessibilityNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    name: z.string().nullable(),
    value: z.string().nullable(),
    focused: z.boolean(),
    disabled: z.boolean(),
    children: z.array(AccessibilityNodeSchema).readonly(),
  }),
);

/** The ARIA view of the page: what assistive technology would be told exists. */
export const AccessibilitySnapshotSchema = z.object({
  root: AccessibilityNodeSchema.nullable(),
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
