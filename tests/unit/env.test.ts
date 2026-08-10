import { describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/shared/env";

const MINIMAL = { ANTHROPIC_API_KEY: "test-key-placeholder" };

describe("parseEnv", () => {
  it("applies documented defaults when only the key is present", () => {
    const env = parseEnv(MINIMAL);

    expect(env.AI_MODEL).toBe("claude-opus-5");
    expect(env.AGENT_MAX_STEPS).toBe(150);
    expect(env.BROWSER_HEADLESS).toBe(true);
    expect(env.EVIDENCE_DIR).toBe("./runs");
  });

  it("coerces numeric and boolean-ish values from strings", () => {
    const env = parseEnv({
      ...MINIMAL,
      AGENT_MAX_STEPS: "42",
      BROWSER_HEADLESS: "false",
      BROWSER_VIEWPORT_WIDTH: "1440",
    });

    expect(env.AGENT_MAX_STEPS).toBe(42);
    expect(env.BROWSER_HEADLESS).toBe(false);
    expect(env.BROWSER_VIEWPORT_WIDTH).toBe(1440);
  });

  it("rejects a missing API key", () => {
    expect(() => parseEnv({})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("rejects a step budget that would let a run go unbounded", () => {
    expect(() => parseEnv({ ...MINIMAL, AGENT_MAX_STEPS: "0" })).toThrow();
    expect(() => parseEnv({ ...MINIMAL, AGENT_MAX_STEPS: "100000" })).toThrow();
  });

  it("never includes an environment value in the error message", () => {
    const secret = "sk-ant-do-not-leak-me";

    // A bad numeric field forces a throw while a real key is present.
    const attempt = () =>
      parseEnv({ ANTHROPIC_API_KEY: secret, AGENT_MAX_STEPS: "not-a-number" });

    expect(attempt).toThrow();
    try {
      attempt();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
