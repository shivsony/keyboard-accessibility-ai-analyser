import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EvidenceCollector } from "@/lib/evidence";
import { auditId, focusOn, screenshotId } from "@/lib/shared/domain";
import type { ScreenshotCapture } from "@/lib/browser";

import { at, makeElement, makeObservation, VIEWPORT } from "../../fixtures/domain";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function collectorForTest(): Promise<EvidenceCollector> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "evidence-collector-"));
  temporaryDirectories.push(directory);
  return new EvidenceCollector({
    auditId: auditId("audit-fixture"),
    artifactsDirectory: path.join(directory, "artifacts"),
  });
}

function screenshot(atStep: number): ScreenshotCapture {
  return {
    // A PNG signature is enough here: Playwright's screenshot bytes are
    // covered at the browser boundary, while this test covers persistence.
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    viewport: VIEWPORT,
    capturedAt: at(atStep),
  };
}

describe("EvidenceCollector", () => {
  it("writes one portable evidence bundle for each completed agent step", async () => {
    const collector = await collectorForTest();
    const before = makeObservation(0, { focus: focusOn(makeElement("before")) });
    const after = makeObservation(1, {
      screenshotId: screenshotId("after-step-0"),
      focus: focusOn(makeElement("after")),
    });

    const reference = await collector.collectCompletedStep({
      step: 0,
      action: "TAB",
      timestamp: at(1),
      screenshot: screenshot(1),
      before,
      after,
    });

    expect(reference).toEqual({
      auditId: "audit-fixture",
      step: 0,
      stepId: "001",
      directory: "steps/001",
      screenshot: "steps/001/screenshot.png",
      observation: "steps/001/observation.json",
      aria: "steps/001/aria.yml",
    });
    expect(reference.screenshot).not.toContain(collector.auditDirectory);

    await expect(
      readFile(path.join(collector.auditDirectory, reference.screenshot)),
    ).resolves.toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(
      readFile(path.join(collector.auditDirectory, reference.aria), "utf8"),
    ).resolves.toBe(after.aria.snapshot);

    const stored = JSON.parse(
      await readFile(path.join(collector.auditDirectory, reference.observation), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      stepId: "001",
      step: 0,
      action: "TAB",
      timestamp: at(1),
      screenshotId: "after-step-0",
      focusedElementBefore: { kind: "ELEMENT", element: { id: "before" } },
      focusedElementAfter: { kind: "ELEMENT", element: { id: "after" } },
      dom: after.dom,
      url: after.url,
      viewport: VIEWPORT,
    });
    expect(stored).not.toHaveProperty("aria.snapshot");
    expect(stored).toHaveProperty("evidence.aria", "steps/001/aria.yml");
  });

  it("removes only the current audit's artifacts during cleanup", async () => {
    const collector = await collectorForTest();
    const observation = makeObservation(0);

    await collector.collectCompletedStep({
      step: 0,
      action: null,
      timestamp: at(0),
      screenshot: screenshot(0),
      before: observation,
      after: observation,
    });
    const otherCollector = new EvidenceCollector({
      auditId: auditId("other-audit"),
      artifactsDirectory: path.dirname(collector.auditDirectory),
    });
    await otherCollector.collectCompletedStep({
      step: 0,
      action: null,
      timestamp: at(0),
      screenshot: screenshot(0),
      before: observation,
      after: observation,
    });

    await collector.cleanup();

    await expect(stat(collector.auditDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(otherCollector.auditDirectory)).resolves.toBeDefined();
    await expect(collector.cleanup()).resolves.toBeUndefined();
  });
});
