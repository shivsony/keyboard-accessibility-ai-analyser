"use client";

import { useEffect, useRef } from "react";

export const dynamic = "force-static";

/**
 * A hand-rolled focus trap of the kind that ships in real dialogs.
 *
 * Tab is cancelled and focus is forced between two controls, so the rest of the
 * page is unreachable. Two findings live here at once: the cycle itself, and
 * the control it excludes.
 */
export default function CycleFixture() {
  const trap = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    first.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;

      const inside = Array.from(
        trap.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      );
      const index = inside.indexOf(document.activeElement as HTMLButtonElement);
      if (index === -1) return;

      event.preventDefault();
      const next = event.shiftKey ? index - 1 : index + 1;
      inside[(next + inside.length) % inside.length]?.focus();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main>
      <h1>Focus cycle</h1>
      <p>Tab cycles between the two controls below and never leaves them.</p>

      <div ref={trap}>
        <button type="button" ref={first}>
          Trapped one
        </button>
        <button type="button">Trapped two</button>
      </div>

      <button type="button">Outside the trap</button>
    </main>
  );
}
