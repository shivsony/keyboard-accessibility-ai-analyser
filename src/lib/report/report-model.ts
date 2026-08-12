import { z } from "zod";

import {
  ConfidenceSchema,
  FindingTypeSchema,
  KeyboardActionSchema,
  SeveritySchema,
  StepIndexSchema,
  TerminationReasonSchema,
  TimestampSchema,
  UrlSchema,
} from "@/lib/shared/domain";

/**
 * The report data model.
 *
 * Built from the **validated audit trace**, never from raw model output. Every
 * factual field here — the journey, the map, the evidence — is derived from what
 * the browser recorded. The model's contribution is confined to the fields that
 * say so: `aiExplanation`, `likelyCause`, `suggestedFix`, and the potential
 * issues section.
 *
 * Two deliberate absences:
 *
 * - **No score.** A number out of a hundred invites comparison between pages
 *   that were explored to different depths, and implies a completeness this
 *   tool does not have. Counts and findings are what it can honestly report.
 * - **No compliance claim.** The tool observes keyboard behaviour; it does not
 *   evaluate conformance. Citing a success criterion it cannot substantiate
 *   would discredit the findings that are real.
 */

/** How the report refers to a finding, depending on what backs it. */
export const IssueStandingSchema = z.enum([
  /** Corroborated by the trace and validated. */
  "CONFIRMED_ISSUE",
  /** The agent suspected it; the evidence did not establish it. */
  "POTENTIAL_ISSUE",
]);
export type IssueStanding = z.infer<typeof IssueStandingSchema>;

// ---------------------------------------------------------------------------
// 1. Overview
// ---------------------------------------------------------------------------

export const ReportOverviewSchema = z.object({
  url: UrlSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  durationMs: z.number().int().nonnegative(),
  stepsExecuted: z.number().int().nonnegative(),
  interactiveElementsDiscovered: z.number().int().nonnegative(),
  elementsReached: z.number().int().nonnegative(),
  elementsNotReached: z.number().int().nonnegative(),
  confirmedIssueCount: z.number().int().nonnegative(),
  potentialIssueCount: z.number().int().nonnegative(),
  /** Why the run ended. A truncated run's coverage should be read differently. */
  terminationReason: TerminationReasonSchema,
  /**
   * How the audit was produced.
   *
   * Recorded because the findings are only comparable to another run's when
   * these match — and because an agent that could not see the page cannot
   * notice that a control is visually first and focused last.
   */
  method: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    multimodal: z.boolean(),
    promptVersion: z.string().min(1),
  }),
});
export type ReportOverview = z.infer<typeof ReportOverviewSchema>;

// ---------------------------------------------------------------------------
// 2. Keyboard navigation map
// ---------------------------------------------------------------------------

export const MapNodeSchema = z.object({
  id: z.string().min(1),
  /** What a reader calls it: accessible name, else role, else the selector. */
  label: z.string().min(1),
  role: z.string().nullable(),
  elementId: z.string().nullable(),
  firstSeenAtStep: StepIndexSchema,
  visitCount: z.number().int().positive(),
});
export type MapNode = z.infer<typeof MapNodeSchema>;

export const MapEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  action: KeyboardActionSchema,
  /** "Tab" / "Shift+Tab" — how the key is written for a reader. */
  actionLabel: z.string().min(1),
  atStep: StepIndexSchema,
});
export type MapEdge = z.infer<typeof MapEdgeSchema>;

export const NavigationMapSchema = z.object({
  nodes: z.array(MapNodeSchema).readonly(),
  edges: z.array(MapEdgeSchema).readonly(),
  /** Loops the traversal fell into, as ordered node ids. */
  cycles: z.array(z.array(z.string()).readonly()).readonly(),
  /** Controls the page offers that the traversal never arrived at. */
  unreachedElements: z
    .array(z.object({ elementId: z.string(), label: z.string() }))
    .readonly(),
});
export type NavigationMap = z.infer<typeof NavigationMapSchema>;

// ---------------------------------------------------------------------------
// 3. Exact keyboard journey
// ---------------------------------------------------------------------------

/** One line of "1. Tab → Logo". */
export const JourneyStepSchema = z.object({
  ordinal: z.number().int().positive(),
  step: StepIndexSchema,
  action: KeyboardActionSchema,
  actionLabel: z.string().min(1),
  /** Where focus ended up. */
  landedOn: z.string().min(1),
  landedOnElementId: z.string().nullable(),
  /** False when the key moved nothing — a fact, not a verdict. */
  focusChanged: z.boolean(),
});
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

export const KeyboardJourneySchema = z.object({
  startedFrom: z.string().min(1),
  steps: z.array(JourneyStepSchema).readonly(),
  /** The bare sequence, for pasting into a bug report. */
  sequence: z.array(z.string()).readonly(),
});
export type KeyboardJourney = z.infer<typeof KeyboardJourneySchema>;

// ---------------------------------------------------------------------------
// 4. Findings
// ---------------------------------------------------------------------------

export const ReportFindingSchema = z.object({
  id: z.string().min(1),
  standing: z.literal("CONFIRMED_ISSUE"),
  type: FindingTypeSchema,
  title: z.string().min(1),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,

  affectedElement: z
    .object({
      elementId: z.string(),
      label: z.string(),
      role: z.string().nullable(),
      selector: z.string(),
    })
    .nullable(),

  /**
   * What a keyboard user should be able to do, and what happened instead.
   *
   * Both derived from the trace and the document, never from the model. The
   * "expected" side is only ever a fact about the page — DOM order, or the
   * plain requirement that an interactive control be reachable — because
   * asserting an intended order the page never declared would be fabrication.
   */
  expected: z.string().min(1),
  actual: z.string().min(1),

  /** Exact reproduction path, from a cold page load. */
  reproduction: z.object({
    sequence: z.array(z.string()).readonly(),
    focusPath: z.array(z.string()).readonly(),
    steps: z.object({ from: StepIndexSchema, to: StepIndexSchema }),
  }),

  screenshotIds: z.array(z.string()).readonly(),
  ariaEvidence: z.string(),
  domEvidence: z.string(),

  /** The model's interpretation, attributed as such. */
  aiExplanation: z.string().min(1),
  likelyCause: z.string().min(1),
  suggestedFix: z.string().min(1),
});
export type ReportFinding = z.infer<typeof ReportFindingSchema>;

/**
 * A suspicion the evidence did not establish.
 *
 * Carries no reproduction path and no evidence, because there is none — that is
 * precisely why it is not a confirmed issue. It appears in the report so a
 * reader knows what the agent looked at and could not settle, which is useful
 * even though it is not actionable.
 */
export const PotentialIssueSchema = z.object({
  id: z.string().min(1),
  standing: z.literal("POTENTIAL_ISSUE"),
  type: FindingTypeSchema,
  confidence: ConfidenceSchema,
  raisedAtStep: StepIndexSchema,
  aiExplanation: z.string().min(1),
  /** Why it was not confirmed, when the validator said. */
  notConfirmedBecause: z.array(z.string()).readonly(),
});
export type PotentialIssue = z.infer<typeof PotentialIssueSchema>;

// ---------------------------------------------------------------------------
// 5. Evidence
// ---------------------------------------------------------------------------

export const EvidenceItemSchema = z.object({
  step: StepIndexSchema,
  screenshotId: z.string(),
  screenshotPath: z.string(),
  action: z.string().nullable(),
  focus: z.string(),
  url: UrlSchema,
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const EvidenceSectionSchema = z.object({
  items: z.array(EvidenceItemSchema).readonly(),
  screenshotCount: z.number().int().nonnegative(),
  /** Whether any capture was truncated. Truncation changes what is provable. */
  anyCaptureTruncated: z.boolean(),
});
export type EvidenceSection = z.infer<typeof EvidenceSectionSchema>;

// ---------------------------------------------------------------------------
// 6. AI analysis
// ---------------------------------------------------------------------------

/**
 * What the model said, kept separate from what the browser recorded.
 *
 * Its own section so a reader can see the interpretation as interpretation. The
 * decisions are quoted rather than summarised, because a summary of reasoning is
 * another layer of interpretation on top of the first.
 */
export const AiAnalysisSchema = z.object({
  /** Steps where the model was consulted. */
  decisionsMade: z.number().int().nonnegative(),
  /**
   * Steps the traversal policy decided without a model call.
   *
   * Reported so the ratio is visible: a run that swept forty steps and asked
   * twice is a different thing from one that asked forty-two times, and the
   * report should not hide which it was.
   */
  sweptSteps: z.number().int().nonnegative(),
  investigationsOpened: z.number().int().nonnegative(),
  investigationsConfirmed: z.number().int().nonnegative(),
  investigationsAbandoned: z.number().int().nonnegative(),
  /** The reasoning behind each decision, in order. */
  reasoningTrail: z
    .array(
      z.object({
        step: StepIndexSchema,
        decision: z.string(),
        mode: z.string(),
        reason: z.string(),
        confidence: ConfidenceSchema,
      }),
    )
    .readonly(),
});
export type AiAnalysis = z.infer<typeof AiAnalysisSchema>;

// ---------------------------------------------------------------------------
// 7. Suggested fixes
// ---------------------------------------------------------------------------

export const SuggestedFixSchema = z.object({
  findingId: z.string().min(1),
  title: z.string().min(1),
  severity: SeveritySchema,
  fix: z.string().min(1),
  affectedElementLabel: z.string().nullable(),
});
export type SuggestedFix = z.infer<typeof SuggestedFixSchema>;

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const KeyboardAccessibilityReportSchema = z.object({
  auditId: z.string().min(1),
  generatedAt: TimestampSchema,
  /** Bumped when the report shape changes, so stored reports stay readable. */
  reportVersion: z.literal("1.0.0"),

  overview: ReportOverviewSchema,
  navigationMap: NavigationMapSchema,
  keyboardJourney: KeyboardJourneySchema,
  confirmedIssues: z.array(ReportFindingSchema).readonly(),
  potentialIssues: z.array(PotentialIssueSchema).readonly(),
  evidence: EvidenceSectionSchema,
  aiAnalysis: AiAnalysisSchema,
  suggestedFixes: z.array(SuggestedFixSchema).readonly(),

  /**
   * What this report does not claim.
   *
   * Carried in the data rather than left to whoever renders it, so no surface
   * can present the findings as a conformance verdict by omission.
   */
  limitations: z.array(z.string()).readonly(),
});
export type KeyboardAccessibilityReport = z.infer<
  typeof KeyboardAccessibilityReportSchema
>;

// ---------------------------------------------------------------------------
// HTML view model
// ---------------------------------------------------------------------------

/**
 * The same report, shaped for rendering.
 *
 * A view model, not markup: ordered sections with titles and pre-resolved
 * display strings, so a renderer decides only how things look, never what they
 * mean. Building it here keeps the phrasing — "confirmed issue", "potential
 * issue" — in one place rather than scattered across templates.
 */
export const HtmlReportSectionSchema = z.object({
  id: z.enum([
    "overview",
    "navigation-map",
    "keyboard-journey",
    "findings",
    "evidence",
    "ai-analysis",
    "suggested-fixes",
  ]),
  title: z.string().min(1),
  /** One line telling the reader what they are looking at. */
  summary: z.string().min(1),
  /** Present but empty, so a renderer can say so rather than hide the section. */
  isEmpty: z.boolean(),
});
export type HtmlReportSection = z.infer<typeof HtmlReportSectionSchema>;

export const HtmlReportViewModelSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().min(1),
  sections: z.array(HtmlReportSectionSchema).readonly(),
  report: KeyboardAccessibilityReportSchema,
  /** Severity ordered for display, worst first. */
  severityOrder: z.array(SeveritySchema).readonly(),
});
export type HtmlReportViewModel = z.infer<typeof HtmlReportViewModelSchema>;
