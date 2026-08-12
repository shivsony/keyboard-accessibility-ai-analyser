export const metadata = { title: "Fixture: no interactive controls" };

/**
 * Nothing to reach.
 *
 * NO_KEYBOARD_REACHABLE_CONTROLS is about a page that *has* controls and
 * reaches none of them. This page has none, which is a different situation and
 * not a defect.
 */
export default function NoControlsFixture() {
  return (
    <main>
      <h1>No interactive controls</h1>
      <p>
        This page is prose. There is no button, no link, no field, and nothing carrying a
        tabindex.
      </p>
      <p>A keyboard user has nothing to reach, and nothing is wrong.</p>
    </main>
  );
}
