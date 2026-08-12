import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/audits/route";
import { DELETE, GET } from "@/app/api/audits/[id]/route";
import {
  getAuditRegistry,
  setAuditRunnerForTesting,
  type AuditRunner,
} from "@/lib/agent/audit-registry";
import { resetEnvCache } from "@/lib/shared/env";

/**
 * The audit API, driven through its route handlers.
 *
 * The runner is replaced, so no Chromium launches and no provider is called.
 * What is under test is the API's own behaviour: validation, status reporting,
 * error handling, and — the part worth the most attention — what it refuses to
 * put in a response.
 */

const KEY = "sk-test-not-a-real-key";

/** A runner that finishes immediately with a minimal report. */
const completingRunner: AuditRunner = async ({ auditId, progress }) => {
  progress.onStep(3);

  return {
    outcome: "completed",
    report: {
      auditId,
      generatedAt: "2026-08-10T12:00:00.000Z",
      reportVersion: "1.0.0",
      overview: {
        url: "https://example.test/app",
        startedAt: "2026-08-10T12:00:00.000Z",
        completedAt: "2026-08-10T12:00:30.000Z",
        durationMs: 30_000,
        stepsExecuted: 3,
        interactiveElementsDiscovered: 4,
        elementsReached: 3,
        elementsNotReached: 1,
        confirmedIssueCount: 0,
        potentialIssueCount: 0,
        terminationReason: "AGENT_STOPPED",
        method: {
          provider: "mock",
          model: "mock",
          multimodal: true,
          promptVersion: "1.0.0",
        },
      },
      navigationMap: { nodes: [], edges: [], cycles: [], unreachedElements: [] },
      keyboardJourney: { startedFrom: "the document body", steps: [], sequence: [] },
      confirmedIssues: [],
      potentialIssues: [],
      evidence: { items: [], screenshotCount: 0, anyCaptureTruncated: false },
      aiAnalysis: {
        decisionsMade: 3,
        sweptSteps: 0,
        investigationsOpened: 0,
        investigationsConfirmed: 0,
        investigationsAbandoned: 0,
        reasoningTrail: [],
      },
      suggestedFixes: [],
      limitations: ["This report makes no claim about WCAG conformance."],
    },
  };
};

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/audits", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/audits/${id}`), {
    params: Promise.resolve({ id }),
  });
}

function del(id: string): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/audits/${id}`), {
    params: Promise.resolve({ id }),
  });
}

/** Polls until the audit leaves a non-terminal state. */
async function settle(id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = (await (await get(id)).json()) as Record<string, unknown>;
    if (body.status !== "queued" && body.status !== "running") return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("audit did not settle");
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", KEY);
  resetEnvCache();
  setAuditRunnerForTesting(completingRunner);
});

afterEach(() => {
  getAuditRegistry().clear();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("POST /api/audits", () => {
  it("accepts a URL and returns an audit id", async () => {
    const response = await post({ url: "https://example.test/app" });
    const body = (await response.json()) as { auditId: string };

    expect(response.status).toBe(202);
    expect(body.auditId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns immediately rather than waiting for the audit", async () => {
    const slow: AuditRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return { outcome: "cancelled" };
    };
    setAuditRunnerForTesting(slow);

    const started = Date.now();
    const response = await post({ url: "https://example.test/app" });

    expect(response.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  describe("invalid input", () => {
    it.each([
      "not-a-url",
      "example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://example.test",
      "",
    ])("rejects %s", async (url) => {
      const response = await post({ url });
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("INVALID_URL");
    });

    it("rejects a missing url", async () => {
      expect((await post({})).status).toBe(400);
    });

    it("rejects a body that is not JSON", async () => {
      const response = await post("this is not json");
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(400);
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("rejects a url that is not a string", async () => {
      expect((await post({ url: 42 })).status).toBe(400);
    });

    it("does not start an audit for an invalid request", async () => {
      await post({ url: "not-a-url" });

      expect(getAuditRegistry().list()).toHaveLength(0);
    });
  });

  // Better to learn now than after polling a run that was never going to work.
  it("refuses to start when the AI is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    resetEnvCache();

    const response = await post({ url: "https://example.test/app" });
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("AI_NOT_CONFIGURED");
    expect(body.error.message).toBe("AI provider is not configured. Set OPENAI_API_KEY.");
  });
});

describe("GET /api/audits/:id", () => {
  it("reports progress while the audit runs", async () => {
    const held: { resolve: () => void } = { resolve: () => undefined };
    const blocked = new Promise<void>((resolve) => {
      held.resolve = resolve;
    });

    setAuditRunnerForTesting(async ({ progress }) => {
      progress.onStep(4);
      await blocked;
      return { outcome: "cancelled" };
    });

    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    // Give the run a tick to start and report its first step.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const body = (await (await get(auditId)).json()) as Record<string, unknown>;

    expect(body.status).toBe("running");
    expect(body.step).toBe(4);
    expect(body.result).toBeNull();

    held.resolve();
  });

  it("returns the report once the audit completes", async () => {
    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    const body = await settle(auditId);
    const result = body.result as { overview: { stepsExecuted: number } } | null;

    expect(body.status).toBe("completed");
    expect(body.step).toBe(3);
    expect(result?.overview.stepsExecuted).toBe(3);
    expect(body.error).toBeNull();
  });

  it("returns 404 for an unknown id", async () => {
    const response = await get("00000000-0000-0000-0000-000000000000");
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns 404 for an id that is not a uuid at all", async () => {
    expect((await get("../../etc/passwd")).status).toBe(404);
  });
});

describe("failure handling", () => {
  it.each([
    ["BROWSER_FAILURE", "The browser could not complete the audit."],
    ["AI_FAILURE", "The AI provider could not be reached."],
    ["TIMEOUT", "The audit ran out of time."],
    ["INTERNAL", "The audit failed unexpectedly."],
  ])("reports a %s as a failed audit", async (code, message) => {
    setAuditRunnerForTesting(async () => ({
      outcome: "failed",
      error: { code: code as never, message },
    }));

    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    const body = await settle(auditId);

    expect(body.status).toBe("failed");
    expect(body.error).toEqual({ code, message });
    expect(body.result).toBeNull();
  });

  // A record stuck on "running" forever is worse than a vague error.
  it("still reaches a terminal state when the runner throws", async () => {
    setAuditRunnerForTesting(async () => {
      throw new Error("/Users/someone/secret-path exploded with sk-abcdefghijklmno");
    });

    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    const body = await settle(auditId);
    const error = body.error as { code: string; message: string };

    expect(body.status).toBe("failed");
    expect(error.code).toBe("INTERNAL");
    // The thrown message is not passed through: it carried a path and a key.
    expect(error.message).not.toContain("secret-path");
    expect(error.message).not.toContain("sk-");
  });
});

describe("cancellation", () => {
  it("cancels a running audit", async () => {
    let observedAbort = false;

    setAuditRunnerForTesting(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        });
      });
      return { outcome: "cancelled" };
    });

    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    await new Promise((resolve) => setTimeout(resolve, 20));

    const response = await del(auditId);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("cancelled");
    expect(observedAbort).toBe(true);
  });

  it("stays cancelled even if the run reports a result afterwards", async () => {
    setAuditRunnerForTesting(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
      });
      // A run that finishes its work just as the cancel arrives.
      return { outcome: "completed", report: null as never };
    });

    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    await new Promise((resolve) => setTimeout(resolve, 20));
    await del(auditId);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await settle(auditId)).status).toBe("cancelled");
  });

  // A client that cancels just as the audit completes has done nothing wrong.
  it("is a no-op on an audit that already finished", async () => {
    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    await settle(auditId);
    const body = (await (await del(auditId)).json()) as Record<string, unknown>;

    expect(body.status).toBe("completed");
  });

  it("returns 404 when cancelling an unknown audit", async () => {
    expect((await del("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

describe("what the API refuses to return", () => {
  const forbidden = [KEY, "sk-", "OPENAI_API_KEY", "ANTHROPIC", "process.env"];

  it("never returns a credential from a successful audit", async () => {
    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    const serialized = JSON.stringify(await settle(auditId));

    for (const secret of forbidden) {
      expect(serialized).not.toContain(secret);
    }
  });

  // A configuration error is the response most likely to reach for the value
  // it is complaining about.
  it("names the missing variable without revealing a value", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    resetEnvCache();

    const serialized = JSON.stringify(
      await (await post({ url: "https://example.test/app" })).json(),
    );

    expect(serialized).toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("sk-");
  });

  it("never returns a server filesystem path", async () => {
    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    const serialized = JSON.stringify(await settle(auditId));

    // Absolute paths, home directories, and the evidence directory setting.
    expect(serialized).not.toMatch(/"\/(Users|home|var|tmp|root)\//);
    expect(serialized).not.toContain(process.cwd());
  });

  it("returns only the documented fields", async () => {
    const { auditId } = (await (
      await post({ url: "https://example.test/app" })
    ).json()) as {
      auditId: string;
    };

    expect(Object.keys(await settle(auditId)).sort()).toEqual([
      "completedAt",
      "createdAt",
      "error",
      "id",
      "live",
      "result",
      "startedAt",
      "status",
      "step",
      "url",
    ]);
  });

  it("says nothing about why an id is unknown", async () => {
    const body = (await (await get("nope")).json()) as { error: { message: string } };

    // Distinguishing "never existed" from "lost on restart" would describe the
    // server's lifecycle to anyone who asked.
    expect(body.error.message).toBe("No audit with that id.");
  });
});
