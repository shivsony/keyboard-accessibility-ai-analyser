import { describe, expect, it } from "vitest";

import { REDACTED, redactSecrets, safeErrorMessage } from "@/lib/ai";

/**
 * The backstop, not the plan.
 *
 * The key is never deliberately placed in a message. This exists because
 * "never deliberately" is not a guarantee — SDK errors echo request details,
 * and those messages end up in logs and pasted bug reports.
 */

describe("redactSecrets", () => {
  it.each([
    "sk-abcdefghijklmnop",
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghijklmnop",
  ])("removes the key %s", (key) => {
    const scrubbed = redactSecrets(`Request failed with key ${key} attached`);

    expect(scrubbed).not.toContain(key);
    expect(scrubbed).toContain(REDACTED);
  });

  it("removes a bearer token from an echoed header", () => {
    const scrubbed = redactSecrets(
      "401 Unauthorized: {'Authorization': 'Bearer abc123def456ghi789'}",
    );

    expect(scrubbed).not.toContain("abc123def456ghi789");
  });

  it("removes a key from a serialized body while keeping the label", () => {
    const scrubbed = redactSecrets('{"api_key": "abcdefghijklmnop", "model": "gpt-4o"}');

    expect(scrubbed).not.toContain("abcdefghijklmnop");
    expect(scrubbed).toContain("api_key");
    // Non-secret context survives, so the message is still diagnosable.
    expect(scrubbed).toContain("gpt-4o");
  });

  it("removes every occurrence, not just the first", () => {
    const scrubbed = redactSecrets(
      "sk-aaaaaaaaaaaaaaaa failed, retried with sk-bbbbbbbbbbbbbbbb",
    );

    expect(scrubbed).not.toContain("sk-aaaa");
    expect(scrubbed).not.toContain("sk-bbbb");
  });

  it("leaves innocent text alone", () => {
    const message = "Navigation to https://example.test/app timed out after 30000ms";

    expect(redactSecrets(message)).toBe(message);
  });
});

describe("safeErrorMessage", () => {
  it("scrubs an Error's message", () => {
    const error = new Error("Bad key sk-abcdefghijklmnop rejected");

    expect(safeErrorMessage(error)).not.toContain("sk-abcdefghijklmnop");
  });

  it("handles values that are not Errors", () => {
    expect(safeErrorMessage("sk-abcdefghijklmnop")).not.toContain("sk-abcd");
    expect(safeErrorMessage({ weird: true })).toBe("Unknown error");
    expect(safeErrorMessage(null)).toBe("Unknown error");
  });

  // A stack frame from an HTTP client can carry the whole request.
  it("never returns a stack", () => {
    const error = new Error("boom");

    expect(safeErrorMessage(error)).toBe("boom");
    expect(safeErrorMessage(error)).not.toContain("at ");
  });
});
