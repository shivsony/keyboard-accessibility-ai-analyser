import { cn } from "@/lib/utils";

/**
 * Small building blocks shared by the audit and report views.
 *
 * A developer tool, not a dashboard: dense, monospaced where the content is
 * literal, and free of decoration that would imply more certainty than the data
 * carries. There is deliberately no score, no gauge, and no traffic light.
 */

const SEVERITY_STYLES = {
  CRITICAL: "bg-red-950/60 text-red-200 border-red-900",
  HIGH: "bg-orange-950/60 text-orange-200 border-orange-900",
  MEDIUM: "bg-amber-950/60 text-amber-200 border-amber-900",
  LOW: "bg-slate-800/60 text-slate-300 border-slate-700",
} as const;

export type Severity = keyof typeof SEVERITY_STYLES;

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-2 py-0.5 font-mono text-xs font-semibold tracking-wide",
        SEVERITY_STYLES[severity],
      )}
    >
      {severity}
    </span>
  );
}

/**
 * Confidence, as the model reported it.
 *
 * Shown as a plain percentage with no bar or colour: it is the model's own
 * estimate, and dressing it up as a measurement would lend it an authority it
 * has not earned.
 */
export function Confidence({ value }: { value: number }) {
  return (
    <span className="text-muted-foreground font-mono text-xs">
      Confidence: {Math.round(value * 100)}%
    </span>
  );
}

/** A labelled value in a dense stats row. */
export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd className="font-mono text-lg tabular-nums">{value}</dd>
      {hint === undefined ? null : (
        <span className="text-muted-foreground text-xs">{hint}</span>
      )}
    </div>
  );
}

/**
 * A keyboard journey, as numbered steps.
 *
 * Rendered as "Tab → Logo" because that is what somebody reproducing the issue
 * will type. The arrow is decorative, so it is hidden from assistive technology
 * — this being an accessibility tool, its own output should not need auditing.
 */
export function KeyboardPath({
  steps,
  numbered = true,
}: {
  steps: readonly { action: string; landedOn?: string | undefined }[];
  numbered?: boolean;
}) {
  if (steps.length === 0) {
    return <p className="text-muted-foreground text-sm">No keys pressed yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-1 font-mono text-sm">
      {steps.map((step, index) => (
        <li key={`${step.action}-${index}`} className="flex items-baseline gap-2">
          {numbered ? (
            <span className="text-muted-foreground w-6 shrink-0 text-right tabular-nums">
              {index + 1}.
            </span>
          ) : null}
          <span className="text-foreground">{step.action}</span>
          {step.landedOn === undefined ? null : (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
              <span className="text-muted-foreground">{step.landedOn}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** A block of captured page content. Untrusted text, rendered inert. */
export function EvidenceBlock({ label, content }: { label: string; content: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs tracking-wide uppercase">
        {label}
      </span>
      <pre className="bg-muted/40 max-h-64 overflow-auto rounded border p-3 font-mono text-xs whitespace-pre-wrap">
        {content === "" ? "(not captured)" : content}
      </pre>
    </div>
  );
}

/** Section heading used across both views. */
export function SectionHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description === undefined ? null : (
        <p className="text-muted-foreground text-sm">{description}</p>
      )}
    </div>
  );
}
