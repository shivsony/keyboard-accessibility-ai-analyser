import "server-only";

import {
  AgentObservationSchema,
  screenshotId,
  type AgentObservation,
  type DOMSnapshot,
  type FocusState,
  type InteractiveElement,
  type ScreenshotId,
  type StepIndex,
  type Url,
} from "@/lib/shared/domain";

import type { ObservationCapture, ScreenshotCapture } from "./types";

/**
 * The read-only slice of the browser driver needed to observe a state.
 *
 * Keeping the engine dependent on this narrow interface prevents it from
 * acquiring keyboard-driving capabilities by accident.
 */
export type ObservationSource = {
  currentUrl(): Url;
  screenshot(): Promise<ScreenshotCapture>;
  captureDom(): Promise<DOMSnapshot>;
  captureAccessibility(): Promise<AgentObservation["aria"]>;
  captureFocus(atStep: StepIndex): Promise<FocusState>;
  captureInteractiveElements(atStep: StepIndex): Promise<readonly InteractiveElement[]>;
};

/**
 * Produces the descriptive record for one browser state.
 *
 * It does not interpret any capture as an accessibility violation. The engine
 * returns screenshot bytes alongside the observation so the evidence layer can
 * persist them while the observation retains a cheap, serializable reference.
 */
export class ObservationEngine {
  #source: ObservationSource;

  constructor(source: ObservationSource) {
    this.#source = source;
  }

  async observe(
    step: StepIndex,
    screenshotReference: ScreenshotId = screenshotId(`observation-${step}`),
  ): Promise<ObservationCapture> {
    const url = this.#source.currentUrl();
    const timestamp = new Date().toISOString();
    const [screenshot, focus, interactiveElements, dom, aria] = await Promise.all([
      this.#source.screenshot(),
      this.#source.captureFocus(step),
      this.#source.captureInteractiveElements(step),
      this.#source.captureDom(),
      this.#source.captureAccessibility(),
    ]);

    return {
      observation: AgentObservationSchema.parse({
        step,
        url,
        screenshotId: screenshotReference,
        focus,
        dom,
        aria,
        interactiveElements,
        viewport: screenshot.viewport,
        timestamp,
      }),
      screenshot,
    };
  }
}
