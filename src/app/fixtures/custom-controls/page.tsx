export const metadata = { title: "Fixture: custom controls" };

/**
 * Non-native controls done the usual way: a role plus tabindex.
 *
 * These are reachable and should not be reported. Whether they can be
 * *operated* needs Enter or Space, which this tool does not press — so it must
 * not claim they cannot be.
 */
export default function CustomControlsFixture() {
  return (
    <main>
      <h1>Custom controls</h1>
      <p>Divs and spans carrying interactive roles. All three are focusable.</p>

      <div role="button" tabIndex={0}>
        Custom button
      </div>

      <div role="checkbox" tabIndex={0} aria-checked="false">
        Custom checkbox
      </div>

      <span
        role="slider"
        tabIndex={0}
        aria-valuenow={50}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Custom slider"
      >
        Custom slider
      </span>
    </main>
  );
}
