/**
 * The fixture layout.
 *
 * **Contains no interactive elements, deliberately.** A shared header with a
 * "back to index" link would add a focusable control to every fixture page, and
 * every expected focus order in the manifest would be wrong. The index page
 * links to the fixtures; the fixtures link nowhere.
 */
export default function FixtureLayout({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-2xl px-6 py-12">{children}</div>;
}
