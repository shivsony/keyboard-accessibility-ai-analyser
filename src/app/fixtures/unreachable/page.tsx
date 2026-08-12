export const metadata = { title: "Fixture: unreachable element" };

/**
 * The classic defect.
 *
 * A div with role="button" and a click handler is a button to a mouse user and
 * nothing at all to a keyboard user. It is visible, it is discoverable, and Tab
 * never lands on it.
 */
export default function UnreachableFixture() {
  return (
    <main>
      <h1>Unreachable element</h1>
      <p>One of the three controls below cannot be reached with the keyboard.</p>

      <button type="button">Before</button>

      {/* No tabindex. Deliberately not a <button>. */}
      <div role="button">Delete account</div>

      <button type="button">After</button>
    </main>
  );
}
