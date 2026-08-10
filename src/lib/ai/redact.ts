/**
 * Scrubbing secrets out of anything that might be logged.
 *
 * Provider SDKs put request details into error messages, and those messages end
 * up in logs, run directories, and pasted bug reports. This is the last line of
 * defence rather than the only one — the key is never deliberately placed in a
 * message — but "never deliberately" is not a guarantee worth relying on
 * (SECURITY.md §4).
 */

const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI keys, including project- and org-scoped forms.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Anthropic and other vendor-prefixed keys.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens from echoed Authorization headers.
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  // Anything self-declaring as a key in a serialized header or body.
  /("?(?:api[_-]?key|authorization|x-api-key)"?\s*[:=]\s*"?)([^",\s}]{8,})/gi,
];

export const REDACTED = "[redacted]";

/** Replaces anything that looks like a credential. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (scrubbed, pattern) =>
      // The capture group, where a pattern has one, is the harmless label
      // ("api_key": ) that should survive; everything matched after it goes.
      scrubbed.replace(pattern, (_match, prefix: string | undefined) =>
        prefix === undefined ? REDACTED : `${prefix}${REDACTED}`,
      ),
    text,
  );
}

/**
 * A safe message for an unknown thrown value.
 *
 * Never returns the original error's own string unscrubbed, and never the
 * stack — a stack from an HTTP client can carry the request in a frame.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  if (typeof error === "string") return redactSecrets(error);
  return "Unknown error";
}
