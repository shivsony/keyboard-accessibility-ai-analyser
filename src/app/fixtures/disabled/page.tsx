export const metadata = { title: "Fixture: disabled and hidden elements" };

/**
 * Things that are *correctly* unreachable.
 *
 * The false-positive test. Every element here is unfocusable on purpose, and an
 * agent that reports any of them has cost the reader their trust in the
 * findings that are real.
 */
export default function DisabledFixture() {
  return (
    <main>
      <h1>Disabled and hidden elements</h1>
      <p>Only one control here should be reachable, and that is correct.</p>

      <button type="button">Enabled action</button>

      <button type="button" disabled>
        Disabled action
      </button>

      <input type="hidden" name="token" value="not-a-control" />

      <div aria-hidden="true">
        <button type="button" tabIndex={-1}>
          Hidden from assistive technology
        </button>
      </div>

      <button type="button" style={{ display: "none" }}>
        Not displayed
      </button>
    </main>
  );
}
