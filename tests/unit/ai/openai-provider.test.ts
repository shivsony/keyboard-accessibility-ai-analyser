import { describe, expect, it, vi } from "vitest";

import { AIProviderError, OpenAIProvider, type OpenAIChatClient } from "@/lib/ai";

import { actionFor } from "@/lib/shared/domain";

import { makeAnalysisInput, RAW_CONTINUE } from "../../fixtures/ai";

/**
 * The provider, driven by a fake client.
 *
 * **No test here reaches the network.** The client is injected, which is also
 * why `OpenAIChatClient` is declared structurally: a test can satisfy it
 * without importing the SDK, and the SDK stays confined to one file.
 */

const KEY = "sk-test-not-a-real-key";

type CreateCall = {
  model: string;
  messages: unknown[];
  response_format?: unknown;
};

function fakeClient(
  responses: readonly (string | Error)[],
): OpenAIChatClient & { readonly calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  let index = 0;

  return {
    calls,
    chat: {
      completions: {
        async create(body) {
          calls.push(body as CreateCall);
          const next = responses[Math.min(index, responses.length - 1)];
          index += 1;

          if (next instanceof Error) throw next;
          return { choices: [{ message: { content: next ?? "" } }] };
        },
      },
    },
  };
}

function provider(
  responses: readonly (string | Error)[],
  options: { maxRetries?: number } = {},
) {
  const client = fakeClient(responses);
  return {
    client,
    provider: new OpenAIProvider({
      apiKey: KEY,
      model: "gpt-4o",
      client,
      ...options,
    }),
  };
}

describe("construction", () => {
  it("reports its identity without leaking the key", () => {
    const { provider: subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    expect(subject.name).toBe("openai");
    expect(subject.model).toBe("gpt-4o");
    expect(JSON.stringify(subject)).not.toContain(KEY);
  });

  // The factory checks first, but a provider built directly must not reach the
  // network with an empty key and fail with something obscure from the SDK.
  it("refuses to construct without a key", () => {
    expect(
      () => new OpenAIProvider({ apiKey: "", model: "gpt-4o", client: fakeClient([""]) }),
    ).toThrow("AI provider is not configured. Set OPENAI_API_KEY.");
  });
});

describe("analyzeObservation", () => {
  it("returns a validated decision", async () => {
    const { provider: subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    const decision = await subject.analyzeObservation(makeAnalysisInput());

    expect(decision.decision).toBe("CONTINUE");
    expect(actionFor(decision)).toBe("TAB");
  });

  it("asks for the decision schema in strict mode", async () => {
    const { client, provider: subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput());

    expect(client.calls[0]?.model).toBe("gpt-4o");
    expect(client.calls[0]?.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "agent_decision", strict: true },
    });
  });

  it("sends the state the agent knows", async () => {
    const { client, provider: subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput());

    const serialized = JSON.stringify(client.calls[0]?.messages);
    expect(serialized).toContain("Logo");
    expect(serialized).toContain("NOT REACHED");
    expect(serialized).toContain("Logo --TAB--> Search");
  });

  it("attaches a screenshot when there is one", async () => {
    const { client, provider: subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(
      makeAnalysisInput({ screenshot: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
    );

    expect(JSON.stringify(client.calls[0]?.messages)).toContain("data:image/png;base64,");
  });

  it("omits the image when the model should not get one", async () => {
    const client = fakeClient([JSON.stringify(RAW_CONTINUE)]);
    const subject = new OpenAIProvider({
      apiKey: KEY,
      model: "gpt-4o",
      client,
      sendScreenshot: false,
    });

    await subject.analyzeObservation(
      makeAnalysisInput({ screenshot: new Uint8Array([1, 2, 3]) }),
    );

    expect(JSON.stringify(client.calls[0]?.messages)).not.toContain("image_url");
  });
});

describe("untrusted output", () => {
  // The structured-output mode shapes the reply; Zod decides whether it is
  // acceptable. The flat JSON schema cannot express that STOP carries no action.
  it("rejects a well-formed response that breaks a domain rule", async () => {
    // INVESTIGATE with no suspected issue: the flat JSON schema permits it,
    // because it cannot express which fields go with which decision.
    const { provider: subject } = provider(
      [
        JSON.stringify({
          decision: "INVESTIGATE",
          action: "TAB",
          reason: "Something looks off.",
          confidence: 0.9,
          suspectedIssue: null,
          issue: null,
          targetElementId: null,
        }),
      ],
      { maxRetries: 0 },
    );

    await expect(subject.analyzeObservation(makeAnalysisInput())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects an action outside the allowlist", async () => {
    const { provider: subject } = provider(
      [JSON.stringify({ ...RAW_CONTINUE, action: "ENTER" })],
      { maxRetries: 0 },
    );

    await expect(subject.analyzeObservation(makeAnalysisInput())).rejects.toThrow(
      AIProviderError,
    );
  });

  it("rejects a response that is not JSON", async () => {
    const { provider: subject } = provider(["I think you should press Tab!"], {
      maxRetries: 0,
    });

    await expect(subject.analyzeObservation(makeAnalysisInput())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects an empty response", async () => {
    const { provider: subject } = provider([""], { maxRetries: 0 });

    await expect(subject.analyzeObservation(makeAnalysisInput())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  // Fields the model invents are stripped at the parse boundary, so nothing
  // downstream can act on them.
  it("strips fields the model was not asked for", async () => {
    const { provider: subject } = provider([
      JSON.stringify({
        ...RAW_CONTINUE,
        selector: "#admin",
        script: "fetch('https://evil.test')",
      }),
    ]);

    const decision = await subject.analyzeObservation(makeAnalysisInput());

    expect(decision).not.toHaveProperty("selector");
    expect(decision).not.toHaveProperty("script");
  });

  it("retries a bad response, then gives up rather than guessing", async () => {
    const { client, provider: subject } = provider(["not json"], { maxRetries: 2 });

    await expect(subject.analyzeObservation(makeAnalysisInput())).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(client.calls).toHaveLength(3);
  });

  it("accepts a valid response after an invalid one", async () => {
    const { provider: subject } = provider(["not json", JSON.stringify(RAW_CONTINUE)]);

    const decision = await subject.analyzeObservation(makeAnalysisInput());

    expect(decision.decision).toBe("CONTINUE");
  });
});

describe("failures", () => {
  it("wraps a request failure with a code", async () => {
    const { provider: subject } = provider([new Error("connection reset")]);

    await expect(subject.analyzeObservation(makeAnalysisInput())).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
  });

  // SDK errors routinely echo request headers, and this message ends up in
  // logs and bug reports.
  it("scrubs the key out of a provider error", async () => {
    const { provider: subject } = provider([
      new Error(`401 Unauthorized: Bearer ${KEY} is invalid`),
    ]);

    try {
      await subject.analyzeObservation(makeAnalysisInput());
      expect.unreachable("expected a failure");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(KEY);
      expect(message).toContain("[redacted]");
    }
  });

  it("reports cancellation as its own outcome", async () => {
    const controller = new AbortController();
    controller.abort();

    const { provider: subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput(), { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("passes the abort signal to the client", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify(RAW_CONTINUE) } }],
    }));

    const subject = new OpenAIProvider({
      apiKey: KEY,
      model: "gpt-4o",
      client: { chat: { completions: { create } } },
    });

    await subject.analyzeObservation(makeAnalysisInput(), { signal: controller.signal });

    expect(create).toHaveBeenCalledWith(expect.anything(), {
      signal: controller.signal,
    });
  });
});
