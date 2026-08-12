export const metadata = { title: "Fixture: correct sequential navigation" };

/**
 * The control case.
 *
 * Four native controls in reading order. A run against this page that reports
 * anything has produced a false positive, which is the failure mode that costs
 * a tool its credibility fastest.
 */
export default function GoodFixture() {
  return (
    <main>
      <h1>Correct sequential navigation</h1>
      <p>Four controls, in the order they appear.</p>

      <nav>
        <a href="#main-content">Home</a>
      </nav>

      <label htmlFor="search">Search</label>
      <input id="search" type="search" name="search" />

      <button type="button">Settings</button>
      <button type="button">Sign out</button>

      <p id="main-content">Nothing else on this page takes focus.</p>
    </main>
  );
}
