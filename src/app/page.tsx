import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const LOOP = [
  { step: "Observe", detail: "Screenshot, focus, DOM summary, ARIA snapshot" },
  { step: "Decide", detail: "The AI picks the next action from what it just saw" },
  { step: "Guard", detail: "Deterministic allowlist check — Tab and Shift+Tab only" },
  { step: "Execute", detail: "Playwright presses exactly one approved key" },
] as const;

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-3">
        <Badge variant="secondary" className="w-fit">
          Pre-implementation
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          Keyboard Accessibility AI Analyzer
        </h1>
        <p className="text-muted-foreground text-pretty">
          An autonomous keyboard accessibility testing agent. It opens a page, presses
          keys, watches what happens, and decides what to press next — then reports
          findings you can reproduce.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>The loop</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="flex flex-col gap-4">
            {LOOP.map(({ step, detail }, index) => (
              <li key={step} className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-medium"
                >
                  {index + 1}
                </span>
                <div className="flex flex-col">
                  <span className="font-medium">{step}</span>
                  <span className="text-muted-foreground text-sm">{detail}</span>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <p className="text-muted-foreground text-sm">
        The audit engine is not built yet. This is the application shell.
      </p>
    </main>
  );
}
