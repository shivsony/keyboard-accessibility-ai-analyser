import "server-only";

import { randomUUID } from "node:crypto";

import type { KeyboardAccessibilityReport } from "@/lib/report";
import { auditId as toAuditId, type AuditId, type Url } from "@/lib/shared/domain";

/**
 * The in-memory audit registry.
 *
 * **This is an MVP shortcut, and it has consequences worth stating plainly:**
 *
 * - Audits live in the memory of one Node process. Restart it and every record
 *   is gone; run two instances behind a load balancer and a client polling for
 *   its audit will get a 404 half the time.
 * - The run happens in the request handler's process, not a queue. The audit
 *   keeps executing after the POST responds, so **the MVP requires a
 *   long-running Node.js server** — `next start` on a machine you control, or a
 *   container that stays up. It will not work on a serverless platform that
 *   freezes or recycles the process once a response is sent.
 * - There is no persistence and no database, deliberately. Reports are written
 *   to the filesystem; the registry only tracks runs in flight.
 *
 * Replacing this with a real queue and a store is the obvious next step, and
 * the interface here is small enough to make that a contained change.
 */

export type AuditStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * A failure, as the API is allowed to describe it.
 *
 * Coded rather than free-form because the message crosses a network boundary:
 * a caller branches on the code, and the message is written for a human without
 * ever quoting an internal path, an environment variable, or a provider error
 * that might echo a request header.
 */
export type AuditFailure = {
  readonly code:
    "BROWSER_FAILURE" | "AI_FAILURE" | "AI_NOT_CONFIGURED" | "TIMEOUT" | "INTERNAL";
  readonly message: string;
};

export type AuditRecord = {
  readonly id: AuditId;
  readonly url: Url;
  readonly status: AuditStatus;
  /** Steps completed so far. Lets a client show progress while it polls. */
  readonly step: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly report: KeyboardAccessibilityReport | null;
  readonly error: AuditFailure | null;
};

/** What a runner reports back as it goes. */
export type AuditProgress = {
  onStep(step: number): void;
};

export type AuditRunner = (input: {
  readonly auditId: AuditId;
  readonly url: Url;
  readonly signal: AbortSignal;
  readonly progress: AuditProgress;
}) => Promise<
  | { readonly outcome: "completed"; readonly report: KeyboardAccessibilityReport }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "failed"; readonly error: AuditFailure }
>;

type Entry = {
  record: AuditRecord;
  controller: AbortController;
};

export class AuditRegistry {
  #entries = new Map<string, Entry>();
  #runner: AuditRunner;

  constructor(runner: AuditRunner) {
    this.#runner = runner;
  }

  /**
   * Starts an audit and returns immediately.
   *
   * The run is deliberately not awaited: the caller gets an id to poll. The
   * promise is kept only so a rejection cannot become an unhandled rejection
   * that takes the process down mid-audit.
   */
  start(url: Url): AuditRecord {
    const id = toAuditId(randomUUID());
    const controller = new AbortController();

    const record: AuditRecord = {
      id,
      url,
      status: "queued",
      step: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      report: null,
      error: null,
    };

    this.#entries.set(id, { record, controller });
    void this.#run(id, url, controller.signal);

    return record;
  }

  get(id: string): AuditRecord | null {
    return this.#entries.get(id)?.record ?? null;
  }

  /**
   * Asks a running audit to stop.
   *
   * Returns the record, or null if there is no such audit. Cancelling a run
   * that has already finished is a no-op rather than an error — a client that
   * cancels just as the audit completes has done nothing wrong.
   */
  cancel(id: string): AuditRecord | null {
    const entry = this.#entries.get(id);
    if (entry === undefined) return null;

    if (entry.record.status === "queued" || entry.record.status === "running") {
      entry.controller.abort();
      this.#update(id, { status: "cancelled", completedAt: new Date().toISOString() });
    }

    return this.#entries.get(id)?.record ?? null;
  }

  /** Every record, newest first. For a local dashboard. */
  list(): readonly AuditRecord[] {
    return [...this.#entries.values()]
      .map((entry) => entry.record)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Test seam, and a way to clear memory in a long-lived dev server. */
  clear(): void {
    for (const entry of this.#entries.values()) entry.controller.abort();
    this.#entries.clear();
  }

  async #run(id: AuditId, url: Url, signal: AbortSignal): Promise<void> {
    this.#update(id, { status: "running", startedAt: new Date().toISOString() });

    try {
      const result = await this.#runner({
        auditId: id,
        url,
        signal,
        progress: { onStep: (step) => this.#update(id, { step }) },
      });

      // A cancellation that arrived while the run was finishing must not be
      // overwritten by its result.
      if (this.get(id)?.status === "cancelled") return;

      if (result.outcome === "completed") {
        this.#update(id, {
          status: "completed",
          report: result.report,
          completedAt: new Date().toISOString(),
        });
      } else if (result.outcome === "cancelled") {
        this.#update(id, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
      } else {
        this.#update(id, {
          status: "failed",
          error: result.error,
          completedAt: new Date().toISOString(),
        });
      }
    } catch {
      // The runner is supposed to return failures rather than throw. If one
      // escapes, the audit still has to reach a terminal state — a record stuck
      // on "running" forever is worse than a vague error.
      //
      // The thrown value is deliberately not inspected: an unexpected error
      // from an unknown layer is exactly the kind that carries a stack, a path,
      // or an echoed request, and none of that may cross the API boundary.
      this.#update(id, {
        status: "failed",
        error: { code: "INTERNAL", message: "The audit failed unexpectedly." },
        completedAt: new Date().toISOString(),
      });
    }
  }

  #update(id: string, patch: Partial<AuditRecord>): void {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;

    entry.record = { ...entry.record, ...patch };
  }
}

/**
 * One registry per process, surviving hot reloads.
 *
 * Next's dev server re-evaluates modules on change; without this, an audit
 * started before an edit would become unreachable while still running.
 */
const REGISTRY_KEY = Symbol.for("kaa.audit-registry");

type RegistryGlobal = typeof globalThis & {
  [REGISTRY_KEY]?: AuditRegistry;
};

export function getAuditRegistry(): AuditRegistry {
  const scope = globalThis as RegistryGlobal;

  scope[REGISTRY_KEY] ??= new AuditRegistry(defaultRunner);
  return scope[REGISTRY_KEY];
}

/**
 * Replaces the runner. **Test seam.**
 *
 * Lets the API be exercised without launching Chromium or calling a provider.
 * Never called in application code.
 */
export function setAuditRunnerForTesting(runner: AuditRunner): void {
  const scope = globalThis as RegistryGlobal;
  scope[REGISTRY_KEY] = new AuditRegistry(runner);
}

/** Loaded lazily so importing the registry does not pull in Playwright. */
const defaultRunner: AuditRunner = async (input) => {
  const { runAudit } = await import("./audit-runner");
  return runAudit(input);
};
