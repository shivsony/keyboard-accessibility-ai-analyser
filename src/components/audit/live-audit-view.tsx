"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  Confidence,
  KeyboardPath,
  SectionHeading,
  SeverityBadge,
  Stat,
  type Severity,
} from "@/components/audit/primitives";
import { Button, buttonVariants } from "@/components/ui/button";
import { screenshotUrl, type AuditResponse } from "@/lib/shared/api-types";

/**
 * The live view of a running audit.
 *
 * Polls rather than streams: the MVP has no queue and no socket, and a two-second
 * poll against an in-process registry is honest about that. When the run ends,
 * polling stops — a page that keeps hammering a finished audit is a bug people
 * only notice on their bill.
 *
 * What it deliberately does not show: the model's working. A one-line rationale
 * per decision is what a developer tool should surface; a narrated train of
 * thought is noise, and presenting it as explanation would claim more about the
 * model's internals than anyone can verify.
 */

const POLL_INTERVAL_MS = 2_000;

const STATUS_LABELS: Record<AuditResponse["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function isFinished(status: AuditResponse["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function LiveAuditView({ auditId }: { auditId: string }) {
  const [audit, setAudit] = useState<AuditResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`/api/audits/${auditId}`, { cache: "no-store" });

        if (!response.ok) {
          if (!cancelled) setLoadError("This audit is no longer available.");
          return;
        }

        const body = (await response.json()) as AuditResponse;
        if (cancelled) return;

        setAudit(body);
        setLoadError(null);

        if (!isFinished(body.status)) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (!cancelled) setLoadError("Could not reach the server.");
      }
    }

    void poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [auditId]);

  async function cancel() {
    await fetch(`/api/audits/${auditId}`, { method: "DELETE" });
  }

  if (loadError !== null) {
    return (
      <p role="alert" className="text-sm text-red-400">
        {loadError}
      </p>
    );
  }

  if (audit === null) {
    return (
      <p className="text-muted-foreground text-sm" aria-live="polite">
        Loading audit…
      </p>
    );
  }

  const live = audit.live;
  const running = !isFinished(audit.status);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs tracking-wide uppercase">
              Auditing
            </span>
            <p className="font-mono text-sm break-all">{audit.url}</p>
          </div>

          <div className="flex items-center gap-3">
            <StatusPill status={audit.status} />
            {running ? (
              <Button variant="outline" onClick={() => void cancel()}>
                Cancel
              </Button>
            ) : null}
            {audit.status === "completed" ? (
              // A link, not a button rendering a link: this is navigation, and
              // an anchor is what a keyboard and a screen reader expect.
              <Link
                href={`/audits/${auditId}/report`}
                className={buttonVariants({ variant: "default" })}
              >
                View report
              </Link>
            ) : null}
          </div>
        </div>

        {audit.error === null ? null : (
          <p
            role="alert"
            className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-200"
          >
            <span className="font-mono text-xs">{audit.error.code}</span> —{" "}
            {audit.error.message}
          </p>
        )}
      </header>

      {/* Announced as it changes, so the run is followable without watching. */}
      <section aria-label="Progress" aria-live="polite">
        <dl className="grid grid-cols-2 gap-6 border-y py-6 sm:grid-cols-4">
          <Stat label="Step" value={audit.step} />
          <Stat label="Discovered" value={live?.discoveredCount ?? 0} hint="controls" />
          <Stat label="Reached" value={live?.visitedCount ?? 0} hint="by keyboard" />
          <Stat
            label="Mode"
            value={live?.mode === "INVESTIGATING" ? "Investigating" : "Exploring"}
          />
        </dl>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <SectionHeading title="Current focus" />
          <p className="font-mono text-sm">{live?.currentFocus ?? "—"}</p>

          <span className="text-muted-foreground mt-4 text-xs tracking-wide uppercase">
            Last keyboard action
          </span>
          <p className="font-mono text-sm">{live?.lastAction ?? "—"}</p>
        </div>

        <div className="flex flex-col gap-2">
          <SectionHeading title="Current decision" />
          <p className="font-mono text-sm">{live?.decision ?? "—"}</p>
          {live?.rationale == null ? null : (
            <>
              {/* One line, not a transcript. */}
              <p className="text-muted-foreground text-sm">{live.rationale}</p>
              {live.confidence === null ? null : <Confidence value={live.confidence} />}
            </>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionHeading
          title="Exploration path"
          description="Where focus has travelled so far."
        />
        {live == null || live.path.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing traversed yet.</p>
        ) : (
          <p className="font-mono text-sm leading-7 break-words">
            {live.path.map((label, index) => (
              <span key={`${label}-${index}`}>
                {index > 0 ? (
                  <span aria-hidden="true" className="text-muted-foreground px-2">
                    →
                  </span>
                ) : null}
                {label}
              </span>
            ))}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading
          title="Confirmed issues"
          description="Raised only when the recorded trace supports them."
        />

        {live == null || live.findings.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {running ? "None confirmed yet." : "No issues were confirmed."}
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {live.findings.map((finding) => (
              <li key={finding.id} className="flex flex-col gap-3 rounded border p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <SeverityBadge severity={finding.severity as Severity} />
                  <span className="font-medium">{finding.title}</span>
                </div>

                <Confidence value={finding.confidence} />

                <div className="flex flex-col gap-2">
                  <span className="text-muted-foreground text-xs tracking-wide uppercase">
                    Path
                  </span>
                  <KeyboardPath
                    numbered={false}
                    steps={finding.path.map((action) => ({ action }))}
                  />
                </div>

                {finding.screenshotStep === null ? null : (
                  <figure className="flex flex-col gap-2">
                    <img
                      src={screenshotUrl(auditId, finding.screenshotStep)}
                      alt={`The page at step ${finding.screenshotStep}, where this issue was observed`}
                      className="max-w-full rounded border"
                      loading="lazy"
                    />
                    <figcaption className="text-muted-foreground text-xs">
                      Screenshot evidence — step {finding.screenshotStep}
                    </figcaption>
                  </figure>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatusPill({ status }: { status: AuditResponse["status"] }) {
  const styles: Record<AuditResponse["status"], string> = {
    queued: "border-slate-700 text-slate-300",
    running: "border-sky-800 text-sky-300",
    completed: "border-emerald-800 text-emerald-300",
    failed: "border-red-900 text-red-300",
    cancelled: "border-slate-700 text-slate-400",
  };

  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-1 font-mono text-xs ${styles[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
