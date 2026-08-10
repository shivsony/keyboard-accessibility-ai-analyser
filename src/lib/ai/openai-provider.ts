import "server-only";

import OpenAI from "openai";

import { safeParseAgentDecision, type AgentDecision } from "@/lib/shared/domain";

import { buildUserPrompt, DECISION_JSON_SCHEMA } from "./prompt";
import { SYSTEM_PROMPT } from "./system-prompt";
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

export type OpenAIProviderOptions = {
  readonly apiKey: string;
  readonly model: string;
  /** Bounded retries when the response does not parse into a valid decision. */
  readonly maxRetries?: number;
  /** Send the screenshot. Off for models without vision. */
  readonly sendScreenshot?: boolean;
  /** Injected in tests. Never set in production. */
  readonly client?: OpenAIChatClient;
};

const DEFAULT_MAX_RETRIES = 2;
const MAX_COMPLETION_TOKENS = 1024;

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  readonly model: string;

  #client: OpenAIChatClient;
  #maxRetries: number;
  #sendScreenshot: boolean;

  constructor(options: OpenAIProviderOptions) {
    // Belt and braces: the factory checks configuration first, but a provider
    // constructed directly must not reach the network with an empty key and
    // fail with something obscure from the SDK.
    if (options.apiKey.trim() === "") {
      throw new AIProviderError("NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE);
    }

    this.model = options.model;
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#sendScreenshot = options.sendScreenshot ?? true;
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

  async #request(messages: unknown[], options: AnalyzeOptions): Promise<string> {
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

      // Scrubbed, not passed through: SDK errors routinely echo request
      // headers, and this message ends up in logs and bug reports.
      throw new AIProviderError(
        "REQUEST_FAILED",
        `The OpenAI request failed: ${safeErrorMessage(error)}`,
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
    const text = buildUserPrompt(input);

    const content: unknown[] = [{ type: "text", text }];

    if (this.#sendScreenshot && input.screenshot !== null) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${Buffer.from(input.screenshot).toString("base64")}`,
        },
      });
    }

    return [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content },
    ];
  }
}
