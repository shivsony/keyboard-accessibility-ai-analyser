import { z } from "zod";

import { AuditIdSchema, StepIndexSchema } from "./primitives";

/**
 * Portable links to one completed step's evidence bundle.
 *
 * Paths are always relative to the audit directory, never to a developer's
 * machine. A report can therefore be moved with its `artifacts/<audit-id>`
 * directory and still resolve its evidence.
 */
export const StepEvidenceReferenceSchema = z.object({
  auditId: AuditIdSchema,
  step: StepIndexSchema,
  /** Zero-padded directory name, for deterministic lexical ordering. */
  stepId: z.string().regex(/^\d{3,}$/),
  directory: z.string().regex(/^steps\/\d{3,}$/),
  screenshot: z.string().regex(/^steps\/\d{3,}\/screenshot\.png$/),
  observation: z.string().regex(/^steps\/\d{3,}\/observation\.json$/),
  aria: z.string().regex(/^steps\/\d{3,}\/aria\.yml$/),
});
export type StepEvidenceReference = z.infer<typeof StepEvidenceReferenceSchema>;
