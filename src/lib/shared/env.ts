import "server-only";

import { z } from "zod";

/**
 * Server-side environment configuration.
 *
 * `server-only` makes importing this from a client component a build error.
 * That is deliberate: this module is the single place the AI API key is read,
 * and the key must never reach the browser. See SECURITY.md.
 *
 * Nothing here is prefixed NEXT_PUBLIC_, and nothing here may be.
 */

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  /**
   * Which provider to use.
   *
   * An enum so an unsupported value fails here with a clear message rather than
   * deeper in the run, when a browser is already open.
   */
  AI_PROVIDER: z.enum(["openai", "groq"]).default("openai"),

  /**
   * Whether the model is sent the screenshot.
   *
   * Defaults per provider — vision on OpenAI, text-only on Groq, whose free
   * models are text-only. Set it explicitly to override, and note that
   * `required` against a model without vision fails every step rather than
   * silently dropping the image.
   */
  AI_IMAGE_MODE: z.enum(["required", "text-only"]).optional(),

  /**
   * Deliberately optional here.
   *
   * A missing key is a configuration problem the AI layer reports in its own
   * words ("AI provider is not configured. Set OPENAI_API_KEY."), and that
   * message is more use than a generic schema error. Making it required would
   * also mean the browser layer could not be exercised without a key.
   */
  OPENAI_API_KEY: z
    .string()
    .optional()
    // A blank value is treated as absent. `OPENAI_API_KEY=` in a half-filled
    // .env.local is the most common way to have no key, and it should produce
    // the AI layer's guidance message rather than a schema error about string
    // length.
    .transform((value) =>
      value === undefined || value.trim() === "" ? undefined : value,
    ),
  OPENAI_MODEL: z.string().min(1).default("gpt-4o"),

  /**
   * Groq. Optional for the same reason as the OpenAI key.
   *
   * Groq exposes an OpenAI-compatible endpoint, so it is driven by the same
   * provider with a different base URL rather than a second SDK.
   */
  GROQ_API_KEY: z
    .string()
    .optional()
    .transform((value) =>
      value === undefined || value.trim() === "" ? undefined : value,
    ),
  GROQ_MODEL: z.string().min(1).default("openai/gpt-oss-120b"),
  GROQ_BASE_URL: z.string().min(1).default("https://api.groq.com/openai/v1"),

  AGENT_MAX_STEPS: z.coerce.number().int().positive().max(1000).default(150),
  AGENT_SETTLE_MS: z.coerce.number().int().nonnegative().max(10_000).default(250),

  BROWSER_HEADLESS: booleanish.default(true),
  BROWSER_VIEWPORT_WIDTH: z.coerce.number().int().positive().default(1280),
  BROWSER_VIEWPORT_HEIGHT: z.coerce.number().int().positive().default(800),

  EVIDENCE_DIR: z.string().min(1).default("./runs"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses the environment, or throws with a message that names the missing
 * variables — and never echoes their values.
 */
export function parseEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");

    // Note: issue messages only, never `source` values. An error string can end
    // up in a log or a bug report.
    throw new Error(
      `Invalid environment configuration:\n${problems}\n\nSee .env.example and docs/ENVIRONMENT.md.`,
    );
  }

  return result.data;
}

let cached: Env | undefined;

/** Lazily parsed, so importing this module never crashes a build. */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test seam. */
export function resetEnvCache(): void {
  cached = undefined;
}
