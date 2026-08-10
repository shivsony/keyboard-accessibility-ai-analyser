import { StartAuditForm } from "@/components/audit/start-audit-form";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Keyboard Accessibility AI Analyzer
        </h1>
        <p className="text-muted-foreground text-lg text-pretty">
          Let an AI keyboard user explore your web app and find accessibility problems.
        </p>
      </header>

      <StartAuditForm />

      {/* Stated before the user starts: this launches a browser and spends their
          own API budget. Finding that out afterwards is a bad surprise. */}
      <aside className="border-muted-foreground/30 bg-muted/30 rounded border border-dashed p-4">
        <p className="text-sm">
          This tool runs browser automation and requires your configured AI provider.
        </p>
      </aside>

      <section className="flex flex-col gap-3 border-t pt-8">
        <h2 className="text-sm font-medium tracking-wide uppercase">How it works</h2>
        <ol className="text-muted-foreground flex flex-col gap-2 text-sm">
          <li>
            <span className="text-foreground font-mono">1.</span> Chromium opens your page
            in a fresh, isolated profile.
          </li>
          <li>
            <span className="text-foreground font-mono">2.</span> The agent observes
            focus, the accessibility tree and the DOM, then chooses Tab or Shift+Tab.
          </li>
          <li>
            <span className="text-foreground font-mono">3.</span> Findings are confirmed
            against the recorded trace before they are reported.
          </li>
        </ol>
        <p className="text-muted-foreground text-xs">
          No score, and no WCAG conformance claim — the report records observed keyboard
          behaviour and says what it cannot establish.
        </p>
      </section>
    </main>
  );
}
