import "server-only";

import { getEnv, type Env } from "@/lib/shared/env";

import { OpenAIProvider } from "./openai-provider";
import {
  AIProviderError,
  notConfiguredMessage,
  NOT_CONFIGURED_MESSAGE,
  type AIProvider,
} from "./types";

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
  const provider = env.AI_PROVIDER;

  const apiKey = provider === "groq" ? env.GROQ_API_KEY : env.OPENAI_API_KEY;

  if (apiKey === undefined || apiKey.trim() === "") {
    throw new AIProviderError("NOT_CONFIGURED", notConfiguredMessage(provider));
  }

  if (provider === "groq") {
    return new OpenAIProvider({
      name: "groq",
      apiKey,
      model: env.GROQ_MODEL,
      baseURL: env.GROQ_BASE_URL,
      // Groq speaks the same chat-completions format but does not offer strict
      // json_schema on every model, so the shape travels in the prompt and Zod
      // does the enforcing — which it does either way.
      responseFormat: "json_object",
      // Text-only by default: Groq's free models have no vision. `required`
      // against a text-only model fails every step, which is the intended
      // behaviour but a poor default to hand somebody.
      imageMode: env.AI_IMAGE_MODE ?? "text-only",
    });
  }

  return new OpenAIProvider({
    apiKey,
    model: env.OPENAI_MODEL,
    imageMode: env.AI_IMAGE_MODE ?? "required",
  });
}

/**
 * Whether an audit could start, without building anything.
 *
 * For a UI that wants to say "add a key in .env.local" before the user waits
 * for a browser to launch. Returns a boolean and a message — never the key,
 * never a fragment of it, and never a hint about its shape (SECURITY.md §4).
 */
export function checkAIConfiguration(
  env?: Env,
): { configured: true } | { configured: false; message: string } {
  try {
    // Resolved inside the try: reading the environment can itself fail, and a
    // status check that throws is no use to a caller trying to report the
    // problem politely.
    createAIProvider(env ?? getEnv());
    return { configured: true };
  } catch (error) {
    return {
      configured: false,
      message: error instanceof AIProviderError ? error.message : NOT_CONFIGURED_MESSAGE,
    };
  }
}
