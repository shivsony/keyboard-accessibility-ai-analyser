import "server-only";

import { getEnv, type Env } from "@/lib/shared/env";

import { OpenAIProvider } from "./openai-provider";
import { AIProviderError, NOT_CONFIGURED_MESSAGE, type AIProvider } from "./types";

/**
 * Builds the configured provider, or refuses to start.
 *
 * There is no fallback. A missing key fails the audit here, loudly, rather than
 * substituting a mock — a run that quietly produced fabricated findings would
 * be far worse than one that would not start, because nobody would know to
 * distrust the report.
 *
 * Configuration is read here and nowhere else, so there is exactly one place
 * the key is handled.
 */
export function createAIProvider(env: Env = getEnv()): AIProvider {
  switch (env.AI_PROVIDER) {
    case "openai": {
      const apiKey = env.OPENAI_API_KEY;

      if (apiKey === undefined || apiKey.trim() === "") {
        throw new AIProviderError("NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
      }

      return new OpenAIProvider({ apiKey, model: env.OPENAI_MODEL });
    }
  }
}

/**
 * Whether an audit could start, without building anything.
 *
 * For a UI that wants to say "add a key in .env.local" before the user waits
 * for a browser to launch. Returns a boolean and a message — never the key,
 * never a fragment of it, and never a hint about its shape (SECURITY.md §4).
 */
export function checkAIConfiguration(
  env: Env = getEnv(),
): { configured: true } | { configured: false; message: string } {
  try {
    createAIProvider(env);
    return { configured: true };
  } catch (error) {
    return {
      configured: false,
      message: error instanceof AIProviderError ? error.message : NOT_CONFIGURED_MESSAGE,
    };
  }
}
