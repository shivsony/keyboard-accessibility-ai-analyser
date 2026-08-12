"use client";

import { useState } from "react";

export const dynamic = "force-static";

/**
 * Controls that appear and disappear with focus.
 *
 * Driven by focus events only — no timers, no animation, no network — so the
 * same traversal always produces the same trace. A page that changed on a timer
 * would make every expectation in the manifest a coin flip.
 *
 * This is the case where an agent is most likely to report a control as
 * unreachable when it simply is not there any more.
 */
export default function DynamicFixture() {
  const [expanded, setExpanded] = useState(false);

  return (
    <main>
      <h1>Controls that appear and disappear</h1>
      <p>Focusing the first button reveals two more.</p>

      {/* Blur is handled on the group, so moving between the revealed options
          does not collapse them mid-traversal. */}
      <div
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false);
        }}
      >
        <button type="button" aria-expanded={expanded} onFocus={() => setExpanded(true)}>
          Show options
        </button>

        {expanded ? (
          <>
            <button type="button">Option A</button>
            <button type="button">Option B</button>
          </>
        ) : null}
      </div>

      <button type="button">Done</button>
    </main>
  );
}
