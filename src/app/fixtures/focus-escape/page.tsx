"use client";

import { useEffect, useRef } from "react";

export const dynamic = "force-static";

/**
 * A dialog that does not trap focus.
 *
 * The dialog is open on load and focus starts inside it. Tabbing past the last
 * control leaves the dialog for the page behind — which is exactly what a modal
 * is supposed to prevent, and what a keyboard user experiences as losing their
 * place.
 *
 * Rendered with plain elements rather than <dialog>, because a native modal
 * dialog traps focus for you and there would be nothing to find.
 */
export default function FocusEscapeFixture() {
  const first = useRef<HTMLButtonElement>(null);

  // Focus starts inside the dialog, as a real modal would arrange. Without
  // this the traversal would begin outside it and the escape would not be
  // observable in one pass.
  useEffect(() => {
    first.current?.focus();
  }, []);

  return (
    <main>
      <h1>Focus escapes the active context</h1>

      <div role="dialog" aria-modal="true" aria-label="Confirm deletion">
        <p>Delete this project? This cannot be undone.</p>
        <button type="button" ref={first}>
          Confirm
        </button>
        <button type="button">Cancel</button>
      </div>

      <p>Content behind the dialog, which a keyboard user should not reach yet:</p>
      <button type="button">Background action</button>
    </main>
  );
}
