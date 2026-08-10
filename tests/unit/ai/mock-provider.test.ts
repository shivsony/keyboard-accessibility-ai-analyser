import { describe, expect, it } from "vitest";

import {
  AIProviderError,
  MockAIProvider,
  mockContinue,
  mockStop,
  type AIProvider,
} from "@/lib/ai";

import { makeAnalysisInput } from "../../fixtures/ai";

describe("MockAIProvider", () => {
  it("satisfies the provider interface", () => {
    // Assigning to the interface is the assertion: if the shapes drift, the
    // mock stops being a stand-in and every test using it becomes a lie.
    const provider: AIProvider = new MockAIProvider();

    expect(provider.name).toBe("mock");
    expect(provider.model).toBe("mock");
  });

  it("returns scripted decisions in order", async () => {
    const provider = new MockAIProvider({
      script: [mockContinue("TAB"), mockContinue("SHIFT_TAB"), mockStop()],
    });

    const input = makeAnalysisInput();
    expect((await provider.analyzeObservation(input)).action).toBe("TAB");
    expect((await provider.analyzeObservation(input)).action).toBe("SHIFT_TAB");
    expect((await provider.analyzeObservation(input)).decision).toBe("STOP");
  });

  // A loop driven by a mock that runs out should end, not spin.
  it("stops once the script is exhausted", async () => {
    const provider = new MockAIProvider({ script: [mockContinue()] });
    const input = makeAnalysisInput();

    await provider.analyzeObservation(input);

    expect((await provider.analyzeObservation(input)).decision).toBe("STOP");
    expect((await provider.analyzeObservation(input)).decision).toBe("STOP");
  });

  it("can repeat its last decision instead", async () => {
    const provider = new MockAIProvider({
      script: [mockContinue("SHIFT_TAB")],
      whenExhausted: "repeat-last",
    });
    const input = makeAnalysisInput();

    await provider.analyzeObservation(input);

    expect((await provider.analyzeObservation(input)).action).toBe("SHIFT_TAB");
  });

  it("can fail on exhaustion, for tests about running out", async () => {
    const provider = new MockAIProvider({ script: [], whenExhausted: "throw" });

    await expect(provider.analyzeObservation(makeAnalysisInput())).rejects.toThrow(
      AIProviderError,
    );
  });

  it("can decide from the input", async () => {
    const provider = new MockAIProvider({
      respond: (input) => (input.stepsRemaining > 0 ? mockContinue("TAB") : mockStop()),
    });

    expect(
      (await provider.analyzeObservation(makeAnalysisInput({ stepsRemaining: 5 })))
        .decision,
    ).toBe("CONTINUE");
    expect(
      (await provider.analyzeObservation(makeAnalysisInput({ stepsRemaining: 0 })))
        .decision,
    ).toBe("STOP");
  });

  it("records what it was asked, so tests can assert on what the model saw", async () => {
    const provider = new MockAIProvider();

    await provider.analyzeObservation(makeAnalysisInput({ step: 3 }));
    await provider.analyzeObservation(makeAnalysisInput({ step: 4 }));

    expect(provider.callCount).toBe(2);
    expect(provider.received.map((input) => input.step)).toEqual([3, 4]);
  });

  it("returns decisions that pass domain validation", async () => {
    const provider = new MockAIProvider({ script: [mockContinue(), mockStop()] });
    const input = makeAnalysisInput();

    const first = await provider.analyzeObservation(input);
    const second = await provider.analyzeObservation(input);

    expect(first.action).not.toBeNull();
    expect(second.action).toBeNull();
    expect(second.suspectedIssue).toBeNull();
  });
});
