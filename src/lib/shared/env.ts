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
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  AI_MODEL: z.string().min(1).default("claude-opus-5"),

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
