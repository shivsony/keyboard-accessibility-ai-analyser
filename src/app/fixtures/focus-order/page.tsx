export const metadata = { title: "Fixture: suspicious focus order" };

/**
 * Positive tabindex, which reorders the tab sequence away from the page.
 *
 * The most common real cause of a scrambled focus order, and the one where an
 * agent is most tempted to assert an intended order the page never declared.
 * The only defensible comparison is against DOM order.
 */
export default function FocusOrderFixture() {
  return (
    <main>
      <h1>Suspicious focus order</h1>
      <p>These are laid out top to bottom but tab bottom to top.</p>

      <button type="button" tabIndex={3}>
        First visually
      </button>
      <button type="button" tabIndex={2}>
        Second visually
      </button>
      <button type="button" tabIndex={1}>
        Third visually
      </button>
    </main>
  );
}
