import { z } from "zod";

import { FocusStateSchema, InteractiveElementSchema } from "./element";
import {
  ScreenshotIdSchema,
  StepIndexSchema,
  TimestampSchema,
  UrlSchema,
  ViewportSchema,
} from "./primitives";
import { AccessibilitySnapshotSchema, DOMSnapshotSchema } from "./snapshot";

/**
 * Everything the agent perceives at one step — and exactly what the model is
 * shown before it decides.
 *
 * All of it is page-controlled: `dom.summary`, accessible names, and the pixels
 * in the screenshot are written by the site under test. Treat every field as
 * untrusted data, never as instruction (SECURITY.md §1).
 */
export const AgentObservationSchema = z.object({
  step: StepIndexSchema,
  url: UrlSchema,
  /** Reference into `AgentState.screenshots`. */
  screenshotId: ScreenshotIdSchema,
  focus: FocusStateSchema,
  dom: DOMSnapshotSchema,
  aria: AccessibilitySnapshotSchema,
  /** Interactive elements visible to discovery at this step. */
  interactiveElements: z.array(InteractiveElementSchema).readonly(),
  viewport: ViewportSchema,
  timestamp: TimestampSchema,
});
export type AgentObservation = z.infer<typeof AgentObservationSchema>;
