import { describe, expect, it } from "vitest";

import {
  AIProviderError,
  checkAIConfiguration,
  createAIProvider,
  NOT_CONFIGURED_MESSAGE,
} from "@/lib/ai";
import { parseEnv } from "@/lib/shared/env";

/**
 * Configuration is the one place the AI layer is allowed to refuse to run.
 *
 * These tests exist mostly to pin the *absence* of a fallback: the failure mode
 * that matters is not a crash, it is a run that quietly produces fabricated
 * findings nobody knows to distrust.
 */

const KEY = "sk-test-not-a-real-key";

describe("createAIProvider", () => {
  it("builds the OpenAI provider when configured", () => {
    const provider = createAIProvider(parseEnv({ OPENAI_API_KEY: KEY }));

    expect(provider.name).toBe("openai");
    expect(provider.model).toBe("gpt-4o");
  });

  it("honours a configured model", () => {
    const provider = createAIProvider(
      parseEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: "gpt-4o-mini" }),
    );

    expect(provider.model).toBe("gpt-4o-mini");
  });

  it("fails with the documented message when the key is missing", () => {
    expect(() => createAIProvider(parseEnv({}))).toThrow(AIProviderError);
    expect(() => createAIProvider(parseEnv({}))).toThrow(
      "AI provider is not configured. Set OPENAI_API_KEY.",
    );
  });

  it("uses the same message for a blank key", () => {
    // An empty string parses as absent for our purposes; a key of spaces is a
    // .env file someone half-filled in, and deserves the same guidance.
    expect(() => createAIProvider(parseEnv({ OPENAI_API_KEY: "   " }))).toThrow(
      NOT_CONFIGURED_MESSAGE,
    );
  });

  it("reports the failure with a code the caller can branch on", () => {
    try {
      createAIProvider(parseEnv({}));
      expect.unreachable("expected a configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(AIProviderError);
      if (error instanceof AIProviderError) expect(error.code).toBe("NOT_CONFIGURED");
    }
  });

  // The failure that matters most: a run that silently produces mock findings
  // would be worse than one that will not start, because the report would look
  // real.
  it("never falls back to a mock provider", () => {
    let built: { name: string } | null = null;

    try {
      built = createAIProvider(parseEnv({}));
    } catch {
      // expected
    }

    expect(built).toBeNull();
  });
});

describe("checkAIConfiguration", () => {
  it("reports a configured environment", () => {
    expect(checkAIConfiguration(parseEnv({ OPENAI_API_KEY: KEY }))).toEqual({
      configured: true,
    });
  });

  it("reports an unconfigured one with the guidance message", () => {
    expect(checkAIConfiguration(parseEnv({}))).toEqual({
      configured: false,
      message: NOT_CONFIGURED_MESSAGE,
    });
  });

  // A status endpoint is a place keys leak. It answers whether, never what.
  it("never reveals the key, or any part of it", () => {
    const result = checkAIConfiguration(parseEnv({ OPENAI_API_KEY: KEY }));
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain(KEY.slice(0, 8));
  });

  it("does not hint at the key's shape when it is missing", () => {
    const result = checkAIConfiguration(parseEnv({}));

    expect(JSON.stringify(result)).not.toContain("sk-");
  });
});
