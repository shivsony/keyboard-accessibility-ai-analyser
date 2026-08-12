import "server-only";

import OpenAI from "openai";

import { safeParseAgentDecision, type AgentDecision } from "@/lib/shared/domain";

import { buildUserPrompt, DECISION_JSON_SCHEMA } from "./prompt";
import { ADJUDICATION_PROMPT, SYSTEM_PROMPT } from "./system-prompt";
import { safeErrorMessage } from "./redact";
import {
  AIProviderError,
  NOT_CONFIGURED_MESSAGE,
  type AgentAnalysisInput,
  type AIProvider,
  type AnalyzeOptions,
} from "./types";

/**
 * The OpenAI provider.
 *
 * **The only file in the application permitted to import the OpenAI SDK.**
 * ESLint enforces that: everything else depends on the `AIProvider` interface,
 * so a second provider is a new file rather than a refactor.
 *
 * The API key lives in this module's memory and in the SDK client. It is never
 * logged, never returned, and never placed in an error message — see
 * `redact.ts` for the backstop.
 */

/**
 * The slice of the SDK actually used.
 *
 * Declared structurally so tests can supply a fake without importing the SDK,
 * and so a breaking change upstream surfaces here as a type error rather than
 * at run time in the middle of an audit.
 */
export type OpenAIChatClient = {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: unknown[];
          response_format?: unknown;
          max_completion_tokens?: number;
        },
        options?: { signal?: AbortSignal },
      ): Promise<{
        choices: { message: { content: string | null } }[];
      }>;
    };
  };
};

/**
 * Whether the model is sent the screenshot.
 *
 * - `required` — every step submits the current screenshot. A screenshot that
 *   is missing, malformed, or rejected fails the step. The agent either sees
 *   the page or says it could not.
 * - `text-only` — a deliberate choice for a model without vision. The run
 *   records `multimodal: false`, so nobody reads its findings as if the agent
 *   had been looking at the page.
 *
 * There is no third mode that drops the image and carries on, because that is
 * the one that produces a report which looks multimodal and is not.
 */
export type ImageMode = "required" | "text-only";

export type OpenAIProviderOptions = {
  readonly apiKey: string;
  readonly model: string;
  /** Bounded retries when the response does not parse into a valid decision. */
  readonly maxRetries?: number;
  /** Defaults to `required`. */
  readonly imageMode?: ImageMode;
  /**
   * Image fidelity. Defaults to `low` — 85 tokens per screenshot instead of
   * roughly 1,105 for a tiled 1280x800 viewport.
   */
  readonly imageDetail?: "low" | "high" | "auto";
  /** Injected in tests. Never set in production. */
  readonly client?: OpenAIChatClient;
};

const DEFAULT_MAX_RETRIES = 2;
const MAX_COMPLETION_TOKENS = 1024;

/**
 * Ceiling on the encoded image.
 *
 * Base64 inflates by about a third, and providers reject oversized payloads
 * with errors that are easy to misread as something else. Catching it here
 * produces a message that names the real problem.
 */
const MAX_SCREENSHOT_BYTES = 15 * 1024 * 1024;

/** PNG magic number. A truncated capture is caught before it costs a request. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;

/**
 * Whether a provider error is about the image we attached.
 *
 * Matched on wording because the SDK does not distinguish these structurally.
 * Deliberately narrow: a false positive costs one wasted retry, while a false
 * negative merely reports the failure under a more general code. Neither
 * outcome drops the screenshot, which is the thing that must not happen.
 */
function looksImageRelated(message: string): boolean {
  return /\b(image|screenshot|vision|multimodal|image_url|unsupported[_ ]image|invalid[_ ]image|download.*image)\b/i.test(
    message,
  );
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  readonly model: string;

  readonly multimodal: boolean;

  #client: OpenAIChatClient;
  #maxRetries: number;
  #imageMode: ImageMode;
  #imageDetail: "low" | "high" | "auto";

  constructor(options: OpenAIProviderOptions) {
    // Belt and braces: the factory checks configuration first, but a provider
    // constructed directly must not reach the network with an empty key and
    // fail with something obscure from the SDK.
    if (options.apiKey.trim() === "") {
      throw new AIProviderError("NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
    }

    this.model = options.model;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#imageMode = options.imageMode ?? "required";
    this.#imageDetail = options.imageDetail ?? "low";
    this.multimodal = this.#imageMode === "required";
    // The cast is the price of not leaking SDK types across this boundary.
    // `OpenAIChatClient` is the contract this file depends on; the SDK's own
    // signatures are richer (overloads for streaming, exact message unions) and
    // do not structurally satisfy a narrowed version of themselves.
    this.#client =
      options.client ??
      (new OpenAI({ apiKey: options.apiKey }) as unknown as OpenAIChatClient);
  }

  async analyzeObservation(
    input: AgentAnalysisInput,
    options: AnalyzeOptions = {},
  ): Promise<AgentDecision> {
    // Built once, before any request. A screenshot problem is a configuration
    // or capture problem, and finding out about it after three retries would
    // waste the budget and bury the cause.
    const messages = this.#buildMessages(input);
    const problems: string[] = [];

    // Retries are bounded and only for unparseable output. A model that cannot
    // produce a valid decision after a few attempts is not going to on the
    // fourth, and the run ends rather than guessing an action.
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (options.signal?.aborted === true) {
        throw new AIProviderError("CANCELLED", "The audit was cancelled");
      }

      const content = await this.#request(messages, options);
      const parsed = this.#parse(content);

      if (parsed.ok) return parsed.decision;
      problems.push(parsed.problem);
    }

    throw new AIProviderError(
      "INVALID_RESPONSE",
      `The model did not return a valid decision after ${this.#maxRetries + 1} attempts: ${problems.join("; ")}`,
    );
  }

  async #request(
    messages: unknown[],
    options: AnalyzeOptions,
    retriedImage = false,
  ): Promise<string> {
    try {
      const response = await this.#client.chat.completions.create(
        {
          model: this.model,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "agent_decision",
              strict: true,
              schema: DECISION_JSON_SCHEMA,
            },
          },
          max_completion_tokens: MAX_COMPLETION_TOKENS,
        },
        options.signal === undefined ? undefined : { signal: options.signal },
      );

      return response.choices[0]?.message.content ?? "";
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new AIProviderError("CANCELLED", "The audit was cancelled", {
          cause: error,
        });
      }

      const message = safeErrorMessage(error);

      // An image-related rejection gets exactly one retry, and only when the
      // provider's own wording suggests a transient handling problem rather
      // than a permanent one. The retry sends the *same* image: retrying
      // without it would be the silent downgrade this class refuses to make.
      if (looksImageRelated(message)) {
        if (!retriedImage) {
          return this.#request(messages, options, true);
        }

        throw new AIProviderError(
          "IMAGE_SUBMISSION_FAILED",
          `The screenshot could not be submitted to the model, and the retry failed too: ${message}. The step is not multimodal, so it has been failed rather than retried without the image.`,
        );
      }

      // Scrubbed, not passed through: SDK errors routinely echo request
      // headers, and this message ends up in logs and bug reports.
      throw new AIProviderError(
        "REQUEST_FAILED",
        `The OpenAI request failed: ${message}`,
      );
    }
  }

  /**
   * Validates the response against the domain schema.
   *
   * The structured-output mode shapes the reply; this decides whether it is
   * acceptable. Model output is untrusted input, and the flat JSON schema
   * cannot express the rules that matter — that STOP carries no action, or
   * that a REPORT must name an issue.
   */
  #parse(
    content: string,
  ): { ok: true; decision: AgentDecision } | { ok: false; problem: string } {
    if (content.trim() === "") return { ok: false, problem: "empty response" };

    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      return { ok: false, problem: "response was not valid JSON" };
    }

    const result = safeParseAgentDecision(json);
    if (!result.success) {
      return {
        ok: false,
        problem: result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join(", "),
      };
    }

    return { ok: true, decision: result.data };
  }

  #buildMessages(input: AgentAnalysisInput): unknown[] {
    const content: unknown[] = [{ type: "text", text: buildUserPrompt(input) }];

    if (this.#imageMode === "required") {
      content.push({
        type: "image_url",
        // Encoded here and sent from Node. The image never passes through the
        // browser, and neither does the key that authorises the request.
        image_url: {
          url: this.#encodeScreenshot(input.screenshot),
          // Without this the API defaults to `auto`, which tiles a 1280x800
          // screenshot into ~1,105 tokens. `low` is a flat 85.
          detail: this.#imageDetail,
        },
      });
    }

    // A decision point means the traversal was swept by code and the model is
    // being asked one narrow question. The full exploration method — how to
    // choose keys, when to stop, how to spend a budget — is not its problem.
    const system = input.decisionPoint == null ? SYSTEM_PROMPT : ADJUDICATION_PROMPT;

    return [
      { role: "system", content: system },
      { role: "user", content },
    ];
  }

  /**
   * Turns the screenshot into a data URL, or fails loudly.
   *
   * Every failure here throws. Dropping the image and continuing would leave a
   * run that reports as multimodal while the agent was reasoning from text — the
   * findings would look the same and mean less.
   */
  #encodeScreenshot(screenshot: Uint8Array | null): string {
    if (screenshot === null) {
      throw new AIProviderError(
        "IMAGE_SUBMISSION_FAILED",
        "No screenshot was supplied for this step, and the provider is configured to require one. Capture one, or configure imageMode: 'text-only' deliberately.",
      );
    }

    if (screenshot.byteLength === 0) {
      throw new AIProviderError(
        "IMAGE_SUBMISSION_FAILED",
        "The screenshot for this step was empty",
      );
    }

    if (!PNG_SIGNATURE.every((byte, index) => screenshot[index] === byte)) {
      throw new AIProviderError(
        "IMAGE_SUBMISSION_FAILED",
        "The screenshot for this step is not a PNG; the capture is probably truncated",
      );
    }

    if (screenshot.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new AIProviderError(
        "IMAGE_SUBMISSION_FAILED",
        `The screenshot for this step is ${Math.round(screenshot.byteLength / 1024)}KB, over the ${Math.round(MAX_SCREENSHOT_BYTES / 1024)}KB limit. Reduce the viewport or the device scale factor.`,
      );
    }

    return `data:image/png;base64,${Buffer.from(screenshot).toString("base64")}`;
  }
}
