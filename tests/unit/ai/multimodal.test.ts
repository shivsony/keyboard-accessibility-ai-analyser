import { describe, expect, it } from "vitest";

import {
  MockAIProvider,
  mockContinue,
  OpenAIProvider,
  type OpenAIChatClient,
} from "@/lib/ai";

import { makeAnalysisInput, RAW_CONTINUE } from "../../fixtures/ai";

/**
 * The model sees the page, or the step fails.
 *
 * The behaviour these tests exist to prevent is the quiet one: a run that
 * reports as multimodal while the agent was reasoning from text. Its findings
 * would look identical and mean less, and nobody reading the report would know.
 *
 * No test here reaches the network.
 */

const KEY = "sk-test-not-a-real-key";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

type Call = { model: string; messages: unknown[] };

function fakeClient(
  responses: readonly (string | Error)[],
): OpenAIChatClient & { readonly calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  return {
    calls,
    chat: {
      completions: {
        async create(body) {
          calls.push(body as Call);
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
  options: { imageMode?: "required" | "text-only"; maxRetries?: number } = {},
) {
  const client = fakeClient(responses);
  return {
    client,
    subject: new OpenAIProvider({
      apiKey: KEY,
      model: "gpt-4o",
      client,
      maxRetries: 0,
      ...options,
    }),
  };
}

/** Every content part of the user message. */
function userContent(
  call: Call | undefined,
): { type?: string; [key: string]: unknown }[] {
  const messages = (call?.messages ?? []) as { role: string; content: unknown }[];
  const user = messages.find((message) => message.role === "user");
  return (user?.content ?? []) as { type?: string }[];
}

describe("the image input", () => {
  it("sends the screenshot as an image part alongside the text", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    const parts = userContent(client.calls[0]);

    expect(parts.map((part) => part.type)).toEqual(["text", "image_url"]);
    expect(parts[1]?.image_url).toMatchObject({
      url: expect.stringContaining("data:image/png;base64,"),
    });
  });

  it("encodes the actual bytes it was given", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    const url = (userContent(client.calls[0])[1]?.image_url as { url: string }).url;
    const encoded = url.replace("data:image/png;base64,", "");

    expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(PNG));
  });

  it("sends the structured state as text in the same message", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    const text = String(userContent(client.calls[0])[0]?.text);

    for (const section of [
      "AUDIT GOAL",
      "FOCUS IS NOW ON",
      "DISCOVERED INTERACTIVE ELEMENTS",
      "DOM SUMMARY",
      "ACCESSIBILITY TREE",
      "KEYBOARD HISTORY",
      "NAVIGATION SO FAR",
      "PREVIOUS FINDINGS",
    ]) {
      expect(text).toContain(section);
    }
  });

  // The model should know an image is there, and what it is for.
  it("tells the model the screenshot is attached and is not the truth about focus", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    const text = String(userContent(client.calls[0])[0]?.text);

    expect(text).toContain("A SCREENSHOT of the current viewport is attached");
    expect(text).toContain("source of truth");
  });

  it("reports itself as multimodal", () => {
    const { subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    expect(subject.multimodal).toBe(true);
  });

  // The key authorises the request from Node. The image is encoded here too —
  // neither ever passes through a browser.
  it("keeps the credential out of the request body", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    expect(JSON.stringify(client.calls[0])).not.toContain(KEY);
  });
});

describe("when the screenshot cannot be submitted", () => {
  // The central rule: never drop the image and carry on.
  it("fails the step when no screenshot was supplied", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: null })),
    ).rejects.toMatchObject({ code: "IMAGE_SUBMISSION_FAILED" });

    // No request was made at all: a screenshot problem is detected before it
    // can cost a call.
    expect(client.calls).toHaveLength(0);
  });

  it("fails on an empty capture", async () => {
    const { subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: new Uint8Array() })),
    ).rejects.toMatchObject({ code: "IMAGE_SUBMISSION_FAILED" });
  });

  it("fails on a capture that is not a PNG", async () => {
    const { subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await expect(
      subject.analyzeObservation(
        makeAnalysisInput({ screenshot: new Uint8Array([1, 2, 3, 4, 5]) }),
      ),
    ).rejects.toMatchObject({ code: "IMAGE_SUBMISSION_FAILED" });
  });

  it("fails on a capture too large to send, and says what to change", async () => {
    const oversized = new Uint8Array(16 * 1024 * 1024);
    oversized.set([0x89, 0x50, 0x4e, 0x47]);

    const { subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: oversized })),
    ).rejects.toThrow(/Reduce the viewport/);
  });

  // One retry, with the same image — a transient handling failure is worth
  // another attempt.
  it("retries once when the provider rejects the image", async () => {
    const { client, subject } = provider([
      new Error("Invalid image: could not process image_url"),
      JSON.stringify(RAW_CONTINUE),
    ]);

    const decision = await subject.analyzeObservation(
      makeAnalysisInput({ screenshot: PNG }),
    );

    expect(decision.decision).toBe("CONTINUE");
    expect(client.calls).toHaveLength(2);
  });

  it("retries with the image still attached, never without it", async () => {
    const { client, subject } = provider([
      new Error("unsupported_image format"),
      JSON.stringify(RAW_CONTINUE),
    ]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    for (const call of client.calls) {
      expect(userContent(call).map((part) => part.type)).toEqual(["text", "image_url"]);
    }
  });

  it("fails clearly when the retry fails too", async () => {
    const { client, subject } = provider([
      new Error("Invalid image supplied to image_url"),
    ]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG })),
    ).rejects.toMatchObject({ code: "IMAGE_SUBMISSION_FAILED" });

    // Exactly one retry, then it stops.
    expect(client.calls).toHaveLength(2);
  });

  it("says why it failed rather than degrading", async () => {
    const { subject } = provider([new Error("vision is not enabled for this model")]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG })),
    ).rejects.toThrow(/failed rather than retried without the image/);
  });

  // A non-image failure keeps its own code, so the two causes stay separable.
  it("does not treat every failure as an image failure", async () => {
    const { client, subject } = provider([new Error("connection reset by peer")]);

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG })),
    ).rejects.toMatchObject({ code: "REQUEST_FAILED" });

    expect(client.calls).toHaveLength(1);
  });
});

describe("text-only mode", () => {
  // Available, but only as a deliberate choice, and the run says so.
  it("is opt-in and reports itself as not multimodal", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)], {
      imageMode: "text-only",
    });

    expect(subject.multimodal).toBe(false);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    expect(userContent(client.calls[0]).map((part) => part.type)).toEqual(["text"]);
  });

  it("tells the model no screenshot was submitted", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)], {
      imageMode: "text-only",
    });

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: null }));

    expect(String(userContent(client.calls[0])[0]?.text)).toContain(
      "NO SCREENSHOT was submitted",
    );
  });

  it("still validates the decision through Zod", async () => {
    const { subject } = provider([JSON.stringify({ ...RAW_CONTINUE, action: "ENTER" })], {
      imageMode: "text-only",
    });

    await expect(
      subject.analyzeObservation(makeAnalysisInput({ screenshot: null })),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("the mocked multimodal provider", () => {
  it("defaults to multimodal, matching the real provider", () => {
    expect(new MockAIProvider().multimodal).toBe(true);
  });

  it("records which steps actually carried a screenshot", async () => {
    const mock = new MockAIProvider({ script: [mockContinue(), mockContinue()] });

    await mock.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));
    await mock.analyzeObservation(makeAnalysisInput({ screenshot: null }));

    expect(mock.callCount).toBe(2);
    expect(mock.screenshotsReceived).toBe(1);
  });

  it("can stand in for a text-only model", () => {
    expect(new MockAIProvider({ multimodal: false }).multimodal).toBe(false);
  });
});

describe("prompt selection", () => {
  // The full exploration method is dead weight when the model is being asked
  // one narrow question about a trace that has already been swept.
  it("sends the compact prompt at a decision point", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(
      makeAnalysisInput({ screenshot: PNG, decisionPoint: "CANDIDATE_FINDING" }),
    );

    const messages = (client.calls[0]?.messages ?? []) as {
      role: string;
      content: unknown;
    }[];
    const system = String(messages.find((m) => m.role === "system")?.content);

    expect(system).toContain("reviewing a recorded browser trace");
    expect(system.length).toBeLessThan(3_000);
  });

  it("sends the full prompt when the model drives every step", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    const messages = (client.calls[0]?.messages ?? []) as {
      role: string;
      content: unknown;
    }[];
    const system = String(messages.find((m) => m.role === "system")?.content);

    expect(system).toContain("You are a keyboard accessibility testing agent");
  });

  // The single largest per-call saving after cutting the calls themselves.
  it("asks for low-detail images by default", async () => {
    const { client, subject } = provider([JSON.stringify(RAW_CONTINUE)]);

    await subject.analyzeObservation(makeAnalysisInput({ screenshot: PNG }));

    expect(userContent(client.calls[0])[1]?.image_url).toMatchObject({
      detail: "low",
    });
  });
});
