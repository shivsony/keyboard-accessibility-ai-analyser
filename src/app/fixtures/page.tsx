import Link from "next/link";

import { FIXTURES } from "@/lib/fixtures/manifest";

export const metadata = {
  title: "Fixtures — Keyboard Accessibility AI Analyzer",
};

/**
 * The fixture index.
 *
 * This page *may* contain links, because it is never itself audited. The
 * fixtures it links to contain nothing but the controls their case needs.
 */
export default function FixturesIndex() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Test fixtures</h1>
        <p className="text-muted-foreground text-sm">
          Nine pages, each isolating one keyboard behaviour, with the expected outcome
          written down. Audit one to check the analyzer against a known answer.
        </p>
      </header>

      <ul className="flex flex-col gap-4">
        {FIXTURES.map((fixture) => (
          <li key={fixture.id} className="flex flex-col gap-2 rounded border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <Link href={fixture.path} className="font-medium hover:underline">
                {fixture.title}
              </Link>
              <code className="text-muted-foreground text-xs">{fixture.path}</code>
            </div>

            <p className="text-muted-foreground text-sm">{fixture.summary}</p>

            <p className="font-mono text-xs">
              {fixture.expectation.reportableIssues.length === 0 ? (
                <span className="text-emerald-400">Expects no findings</span>
              ) : (
                <span className="text-orange-300">
                  Expects: {fixture.expectation.reportableIssues.join(", ")}
                </span>
              )}
            </p>
          </li>
        ))}
      </ul>

      <p className="text-muted-foreground text-xs">
        Full expectations — AI behaviour, browser behaviour, evidence, reportable issues —
        are in <code>docs/FIXTURES.md</code>.
      </p>
    </main>
  );
}
