import "server-only";

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AgentObservationSchema,
  KeyboardActionSchema,
  StepEvidenceReferenceSchema,
  StepIndexSchema,
  TimestampSchema,
  type AgentObservation,
  type AuditId,
  type KeyboardAction,
  type StepEvidenceReference,
  type StepIndex,
  type Timestamp,
} from "@/lib/shared/domain";
import type { ScreenshotCapture } from "@/lib/browser";

/** Data produced once a keyboard action has completed and the page was observed again. */
export type CompletedStepEvidence = {
  readonly step: StepIndex;
  /** The action actually executed; null when the step completed without one. */
  readonly action: KeyboardAction | null;
  readonly timestamp: Timestamp;
  /** One capture of the post-action state — never screenshots of internal reads. */
  readonly screenshot: ScreenshotCapture;
  readonly before: AgentObservation;
  readonly after: AgentObservation;
};

/** JSON written beside the screenshot. The larger ARIA YAML stays in `aria.yml`. */
type StoredStepEvidence = {
  readonly stepId: string;
  readonly step: StepIndex;
  readonly action: KeyboardAction | null;
  readonly timestamp: Timestamp;
  readonly evidence: StepEvidenceReference;
  readonly screenshotId: AgentObservation["screenshotId"];
  readonly focusedElementBefore: AgentObservation["focus"];
  readonly focusedElementAfter: AgentObservation["focus"];
  readonly dom: AgentObservation["dom"];
  readonly aria: Omit<AgentObservation["aria"], "snapshot">;
  readonly url: AgentObservation["url"];
  readonly viewport: AgentObservation["viewport"];
};

/**
 * Stores portable, per-step reproduction bundles under `artifacts/<audit-id>`.
 *
 * This collector writes exactly one screenshot for each completed agent step.
 * Internal browser reads remain in memory; recording them would produce noise
 * without improving reproduction.
 */
export class EvidenceCollector {
  #auditId: AuditId;
  #auditDirectory: string;

  constructor(options: { auditId: AuditId; artifactsDirectory?: string }) {
    this.#auditId = options.auditId;
    const auditSegment = safeAuditDirectoryName(options.auditId);
    this.#auditDirectory = path.resolve(
      options.artifactsDirectory ?? path.resolve("artifacts"),
      auditSegment,
    );
  }

  /** Absolute local location for writing only; never place this path in a report. */
  get auditDirectory(): string {
    return this.#auditDirectory;
  }

  async collectCompletedStep(
    input: CompletedStepEvidence,
  ): Promise<StepEvidenceReference> {
    const step = StepIndexSchema.parse(input.step);
    const action = KeyboardActionSchema.nullable().parse(input.action);
    const timestamp = TimestampSchema.parse(input.timestamp);
    const before = AgentObservationSchema.parse(input.before);
    const after = AgentObservationSchema.parse(input.after);

    if (!sameViewport(input.screenshot.viewport, after.viewport)) {
      throw new Error(
        "Screenshot viewport must match the post-action observation viewport",
      );
    }

    const stepId = stepDirectoryId(step);
    const reference = StepEvidenceReferenceSchema.parse({
      auditId: this.#auditId,
      step,
      stepId,
      directory: `steps/${stepId}`,
      screenshot: `steps/${stepId}/screenshot.png`,
      observation: `steps/${stepId}/observation.json`,
      aria: `steps/${stepId}/aria.yml`,
    });
    const stepDirectory = path.join(this.#auditDirectory, reference.directory);
    const record: StoredStepEvidence = {
      stepId,
      step,
      action,
      timestamp,
      evidence: reference,
      screenshotId: after.screenshotId,
      focusedElementBefore: before.focus,
      focusedElementAfter: after.focus,
      dom: after.dom,
      aria: {
        nodeCount: after.aria.nodeCount,
        truncated: after.aria.truncated,
        capturedAt: after.aria.capturedAt,
      },
      url: after.url,
      viewport: after.viewport,
    };

    await mkdir(path.dirname(stepDirectory), { recursive: true });
    // A duplicate completed-step record would silently replace reproduction
    // evidence. Refuse it instead; callers must start a new audit to retry.
    await mkdir(stepDirectory);
    await Promise.all([
      writeFile(
        path.join(this.#auditDirectory, reference.screenshot),
        input.screenshot.png,
      ),
      writeFile(
        path.join(this.#auditDirectory, reference.aria),
        after.aria.snapshot,
        "utf8",
      ),
      writeFile(
        path.join(this.#auditDirectory, reference.observation),
        `${JSON.stringify(record, null, 2)}\n`,
        "utf8",
      ),
    ]);

    return reference;
  }

  /** Removes this audit's evidence only. It never deletes another audit's output. */
  async cleanup(): Promise<void> {
    await rm(this.#auditDirectory, { recursive: true, force: true });
  }
}

function safeAuditDirectoryName(auditId: AuditId): string {
  if (
    auditId === "." ||
    auditId === ".." ||
    auditId.includes(path.sep) ||
    auditId.includes("/") ||
    auditId.includes("\\")
  ) {
    throw new Error("Audit ID cannot contain a path separator");
  }
  return auditId;
}

function stepDirectoryId(step: StepIndex): string {
  return String(step + 1).padStart(3, "0");
}

function sameViewport(
  left: ScreenshotCapture["viewport"],
  right: AgentObservation["viewport"],
): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.deviceScaleFactor === right.deviceScaleFactor
  );
}
