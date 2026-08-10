import {
  Confidence,
  EvidenceBlock,
  KeyboardPath,
  SectionHeading,
  SeverityBadge,
  Stat,
  type Severity,
} from "@/components/audit/primitives";
import type { KeyboardAccessibilityReport, ReportFinding } from "@/lib/report";
import { screenshotUrl } from "@/lib/shared/api-types";

/**
 * The finished report.
 *
 * A server component: the report is already complete, so there is nothing to
 * poll and no reason to ship this to the browser as JavaScript.
 *
 * Section order follows the report model. The limitations are rendered, not
 * hidden in a footnote — they are the difference between "we found three
 * problems" and "we found three problems in the part of the page a Tab-only
 * traversal reached".
 */
export function ReportView({
  report,
  auditId,
}: {
  report: KeyboardAccessibilityReport;
  auditId: string;
}) {
  const { overview } = report;

  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Keyboard accessibility audit
        </h1>
        <p className="text-muted-foreground font-mono text-sm break-all">
          {overview.url}
        </p>
      </header>

      {/* 1. Overview */}
      <section id="overview" className="flex flex-col gap-4">
        <SectionHeading
          title="Overview"
          description="What was audited, and how far the traversal got."
        />

        <dl className="grid grid-cols-2 gap-6 border-y py-6 sm:grid-cols-4">
          <Stat label="Steps" value={overview.stepsExecuted} />
          <Stat
            label="Discovered"
            value={overview.interactiveElementsDiscovered}
            hint="interactive controls"
          />
          <Stat
            label="Reached"
            value={overview.elementsReached}
            hint={`${overview.elementsNotReached} not reached`}
          />
          <Stat label="Duration" value={`${Math.round(overview.durationMs / 1000)}s`} />
          <Stat label="Confirmed issues" value={overview.confirmedIssueCount} />
          <Stat label="Potential issues" value={overview.potentialIssueCount} />
          <Stat label="Ended" value={humanizeReason(overview.terminationReason)} />
          <Stat
            label="Model"
            value={overview.method.model}
            hint={overview.method.multimodal ? "with screenshots" : "text only"}
          />
        </dl>

        <ul className="text-muted-foreground flex flex-col gap-2 text-xs">
          {report.limitations.map((limitation) => (
            <li key={limitation}>— {limitation}</li>
          ))}
        </ul>
      </section>

      {/* 2. Keyboard map */}
      <section id="keyboard-map" className="flex flex-col gap-4">
        <SectionHeading
          title="Keyboard map"
          description="Where focus travelled, and what it never reached."
        />

        {report.navigationMap.edges.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing was traversed.</p>
        ) : (
          <ol className="flex flex-col gap-1 font-mono text-sm">
            {report.navigationMap.edges.map((edge, index) => {
              const from = report.navigationMap.nodes.find((n) => n.id === edge.from);
              const to = report.navigationMap.nodes.find((n) => n.id === edge.to);

              return (
                <li key={`${edge.from}-${edge.to}-${index}`}>
                  <span>{from?.label ?? edge.from}</span>
                  <span aria-hidden="true" className="text-muted-foreground px-2">
                    --{edge.actionLabel}--&gt;
                  </span>
                  <span className="sr-only">then {edge.actionLabel} to</span>
                  <span>{to?.label ?? edge.to}</span>
                </li>
              );
            })}
          </ol>
        )}

        {report.navigationMap.unreachedElements.length === 0 ? null : (
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs tracking-wide uppercase">
              Never reached
            </span>
            <ul className="flex flex-wrap gap-2">
              {report.navigationMap.unreachedElements.map((element) => (
                <li
                  key={element.elementId}
                  className="rounded border px-2 py-1 font-mono text-xs"
                >
                  {element.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 3. Journey */}
      <section id="journey" className="flex flex-col gap-4">
        <SectionHeading
          title="Journey"
          description="Every keypress in order. Replay this from a fresh page load."
        />
        <p className="text-muted-foreground font-mono text-sm">
          Started from: {report.keyboardJourney.startedFrom}
        </p>
        <KeyboardPath
          steps={report.keyboardJourney.steps.map((step) => ({
            action: step.actionLabel,
            landedOn: step.landedOn,
          }))}
        />
      </section>

      {/* 4. Findings */}
      <section id="findings" className="flex flex-col gap-6">
        <SectionHeading
          title="Findings"
          description="Confirmed issues are backed by the recorded trace. Potential issues were not established."
        />

        {report.confirmedIssues.length === 0 ? (
          <p className="text-muted-foreground text-sm">No issues were confirmed.</p>
        ) : (
          <ul className="flex flex-col gap-8">
            {report.confirmedIssues.map((finding) => (
              <li key={finding.id}>
                <FindingCard finding={finding} auditId={auditId} />
              </li>
            ))}
          </ul>
        )}

        {report.potentialIssues.length === 0 ? null : (
          <div className="flex flex-col gap-3 border-t pt-6">
            <h3 className="text-sm font-medium tracking-wide uppercase">
              Potential issues
            </h3>
            <p className="text-muted-foreground text-sm">
              The agent examined these and the evidence did not establish them. They are
              not defects.
            </p>
            <ul className="flex flex-col gap-3">
              {report.potentialIssues.map((issue) => (
                <li key={issue.id} className="rounded border border-dashed p-4">
                  <p className="font-mono text-xs">{issue.type}</p>
                  <p className="mt-1 text-sm">{issue.aiExplanation}</p>
                  <div className="mt-2 flex flex-col gap-1">
                    <Confidence value={issue.confidence} />
                    {issue.notConfirmedBecause.map((why) => (
                      <span key={why} className="text-muted-foreground text-xs">
                        Not confirmed: {why}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* 5. Evidence */}
      <section id="evidence" className="flex flex-col gap-4">
        <SectionHeading
          title="Evidence"
          description={`${report.evidence.screenshotCount} screenshot(s) captured during the run.`}
        />

        {report.evidence.anyCaptureTruncated ? (
          <p className="text-muted-foreground text-xs">
            Some captures were truncated, which limits what they can establish.
          </p>
        ) : null}

        <ul className="grid gap-6 sm:grid-cols-2">
          {report.evidence.items.map((item) => (
            <li key={item.screenshotId} className="flex flex-col gap-2">
              <img
                src={screenshotUrl(auditId, item.step)}
                alt={`The page at step ${item.step}, with focus on ${item.focus}`}
                className="w-full rounded border"
                loading="lazy"
              />
              <p className="text-muted-foreground font-mono text-xs">
                Step {item.step} · {item.action ?? "no key"} · focus: {item.focus}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function FindingCard({ finding, auditId }: { finding: ReportFinding; auditId: string }) {
  const screenshot =
    finding.screenshotIds.length > 0 ? finding.reproduction.steps.to : null;

  return (
    <article className="flex flex-col gap-5 rounded border p-5">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <SeverityBadge severity={finding.severity as Severity} />
          <h3 className="text-lg font-medium">{finding.title}</h3>
        </div>
        <Confidence value={finding.confidence} />
      </header>

      {finding.affectedElement === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">
            Affected element
          </span>
          <p className="font-mono text-sm">
            {finding.affectedElement.label}
            {finding.affectedElement.role === null
              ? null
              : ` (role=${finding.affectedElement.role})`}
          </p>
          <p className="text-muted-foreground font-mono text-xs break-all">
            {finding.affectedElement.selector}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">
            Expected behaviour
          </span>
          <p className="text-sm">{finding.expected}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">
            Actual behaviour
          </span>
          <p className="text-sm">{finding.actual}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">
          Exact reproduction sequence
        </span>
        <KeyboardPath
          steps={finding.reproduction.sequence.map((action, index) => ({
            action,
            landedOn: finding.reproduction.focusPath[index],
          }))}
        />
      </div>

      {screenshot === null ? null : (
        <figure className="flex flex-col gap-2">
          <img
            src={screenshotUrl(auditId, screenshot)}
            alt={`The page at step ${screenshot}, where this issue was observed`}
            className="w-full rounded border"
            loading="lazy"
          />
          <figcaption className="text-muted-foreground text-xs">
            Screenshot evidence — step {screenshot}
          </figcaption>
        </figure>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <EvidenceBlock label="ARIA evidence" content={finding.ariaEvidence} />
        <EvidenceBlock label="DOM evidence" content={finding.domEvidence} />
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">
            Likely cause
          </span>
          <p className="text-sm">{finding.likelyCause}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">
            Suggested fix
          </span>
          <p className="text-sm">{finding.suggestedFix}</p>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs tracking-wide uppercase">
            AI explanation
          </span>
          {/* Labelled as interpretation, kept apart from the recorded facts. */}
          <p className="text-muted-foreground text-sm">{finding.aiExplanation}</p>
        </div>
      </div>
    </article>
  );
}

function humanizeReason(reason: string): string {
  return reason
    .toLowerCase()
    .split("_")
    .map((word, index) => (index === 0 ? word[0]?.toUpperCase() + word.slice(1) : word))
    .join(" ");
}
