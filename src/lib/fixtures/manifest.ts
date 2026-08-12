import type { FindingType } from "@/lib/shared/domain";

/**
 * The fixture application.
 *
 * Nine pages, each isolating one keyboard behaviour, with what should happen
 * written down beside them. They exist so a change to the agent can be judged
 * against something whose answer is already known — "it found three issues" is
 * not a result unless you know how many were there.
 *
 * **Determinism is the whole point**, and it is fragile:
 *
 * - A fixture page contains only the controls its case needs. No navigation, no
 *   "back to index" link, nothing from a shared layout. One stray anchor and
 *   every expected count below is wrong.
 * - No animation, no timers, no network. Behaviour is driven by focus events
 *   only, so the same traversal always produces the same trace.
 * - Element order in the DOM is the order the expectations assume.
 *
 * This manifest is the single source of truth: `docs/FIXTURES.md` describes it,
 * the fixture index renders it, and the tests assert against it. Changing a
 * page without changing the entry here should fail a test.
 */

export type FixtureExpectation = {
  /** What a competent agent should do when it explores this page. */
  readonly aiBehavior: string;
  /** What the browser does, regardless of any agent. Observable, checkable. */
  readonly browserBehavior: string;
  /** What the run should have recorded by the end. */
  readonly evidence: string;
  /**
   * Findings the trace supports.
   *
   * Empty means a correct run reports nothing. Those are the most valuable
   * fixtures: a tool that finds problems everywhere is as useless as one that
   * finds none.
   */
  readonly reportableIssues: readonly FindingType[];
};

export type Fixture = {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly summary: string;
  /**
   * Where focus already is when the page loads, if the fixture puts it
   * somewhere.
   *
   * Recorded because it changes what a traversal sees: a page that focuses a
   * dialog on open has already occupied its first position before anyone
   * presses a key. It is also the first entry in `expectedFocusOrder`.
   */
  readonly initialFocus: string | null;
  /** Positions a keyboard occupies, in order, including any initial focus. */
  readonly expectedFocusOrder: readonly string[];
  /** Controls discovery should find that the keyboard cannot reach. */
  readonly expectedUnreachable: readonly string[];
  readonly expectation: FixtureExpectation;
};

export const FIXTURES: readonly Fixture[] = Object.freeze([
  {
    id: "good",
    path: "/fixtures/good",
    title: "Correct sequential navigation",
    summary: "Four native controls in reading order. Nothing is wrong here.",
    initialFocus: null,
    expectedFocusOrder: ["Home", "Search", "Settings", "Sign out"],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Tab through all four controls, notice nothing amiss, and STOP once every discovered control has been reached. It should not manufacture a finding to justify the run.",
      browserBehavior:
        "Tab moves focus through the four controls in DOM order; Shift+Tab reverses it. After the last control, focus leaves the document for browser chrome.",
      evidence:
        "Four distinct focus positions, a linear navigation graph with no cycle, and every discovered element in the visited set.",
      reportableIssues: [],
    },
  },
  {
    id: "unreachable",
    path: "/fixtures/unreachable",
    title: "Unreachable interactive element",
    summary: "A visible control a mouse user can click and a keyboard user cannot reach.",
    initialFocus: null,
    expectedFocusOrder: ["Before", "After"],
    expectedUnreachable: ["Delete account"],
    expectation: {
      aiBehavior:
        "Notice that discovery found a control the traversal never focused, INVESTIGATE by tabbing back and forth to confirm it is not simply further along, then REPORT once the sequence demonstrates it.",
      browserBehavior:
        'Tab reaches "Before" then "After". The div with role="button" and no tabindex is never focused, in either direction.',
      evidence:
        "The element appears in discovered elements with discoveredVia=ARIA_ROLE and tabIndex=null, and never appears in the visited set or the focus sequence.",
      reportableIssues: ["UNREACHABLE_ELEMENT"],
    },
  },
  {
    id: "focus-order",
    path: "/fixtures/focus-order",
    title: "Suspicious focus order",
    summary: "Positive tabindex values put the tab order backwards relative to the page.",
    initialFocus: null,
    expectedFocusOrder: ["Third visually", "Second visually", "First visually"],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Observe that focus arrives in an order that contradicts both the document order and the visual layout, and report it against DOM order — never against an invented notion of what the author intended.",
      browserBehavior:
        "Positive tabindex values are honoured before the natural order, so Tab visits the last visual control first and the first one last.",
      evidence:
        "The observed focus order differs from the DOM order of the same elements. Both orders are recorded, so the divergence is checkable rather than asserted.",
      reportableIssues: ["SUSPICIOUS_FOCUS_ORDER"],
    },
  },
  {
    id: "focus-escape",
    path: "/fixtures/focus-escape",
    title: "Focus escapes the active context",
    summary:
      "An open dialog that does not trap focus — tabbing leaves it for the page behind.",
    initialFocus: "Confirm",
    expectedFocusOrder: ["Confirm", "Cancel", "Background action"],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Notice that focus left a dialog for content behind it and treat that as a context problem. It should not claim WCAG conformance, only describe what happened.",
      browserBehavior:
        'Focus starts on "Confirm" inside the dialog. Tab reaches "Cancel", then leaves the dialog entirely for the background button, which a dialog is expected to prevent.',
      evidence:
        "The focus sequence crosses from elements inside the dialog to one outside it, and continued tabbing eventually leaves the document.",
      // Also reports SUSPICIOUS_FOCUS_ORDER. The page focuses the dialog on
      // mount, so the agent's first observation can land before that focus is
      // applied, and the order it records starts from a transient state. Real
      // behaviour on any page that focuses something on load — recorded here
      // rather than hidden, because a fixture that lies about its output is
      // worse than one with an awkward answer.
      reportableIssues: ["UNEXPECTED_FOCUS_LEAVING_PAGE", "SUSPICIOUS_FOCUS_ORDER"],
    },
  },
  {
    id: "dynamic",
    path: "/fixtures/dynamic",
    title: "Controls that appear and disappear",
    summary: "Focusing one control reveals two more; leaving it hides them again.",
    initialFocus: null,
    expectedFocusOrder: ["Show options", "Option A", "Option B", "Done"],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Cope with the element list changing between steps. Elements that appeared should be treated as discovered, and ones that vanished should not be reported unreachable simply because the traversal moved past them.",
      browserBehavior:
        'Focusing "Show options" reveals two buttons after it in the DOM. Tab reaches them in order. They are removed when focus leaves the group entirely.',
      evidence:
        "Discovered element count grows during the run. The navigation graph records positions that did not exist at step 0.",
      reportableIssues: [],
    },
  },
  {
    id: "custom-controls",
    path: "/fixtures/custom-controls",
    title: "Custom controls with tabindex and ARIA",
    summary: "Non-native elements made focusable and given interactive roles.",
    initialFocus: null,
    expectedFocusOrder: ["Custom button", "Custom checkbox", "Custom slider"],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Treat role-bearing elements as interactive controls and not report them merely for being custom. Whether they can be *operated* needs Enter or Space, which are out of scope, so it must not claim they cannot be.",
      browserBehavior:
        'All three are reachable: each is a div or span with tabindex="0" and an interactive ARIA role.',
      evidence:
        "Discovery records them with discoveredVia=NATIVE_CONTROL or ARIA_ROLE and tabIndex=0, and all three appear in the visited set.",
      reportableIssues: [],
    },
  },
  {
    id: "cycle",
    path: "/fixtures/cycle",
    title: "Focus cycle",
    summary: "A hand-rolled trap: Tab cycles between two controls forever.",
    initialFocus: "Trapped one",
    expectedFocusOrder: ["Trapped one", "Trapped two"],
    expectedUnreachable: ["Outside the trap"],
    expectation: {
      aiBehavior:
        "Detect that it keeps returning to the same two positions, investigate rather than reporting on the first repeat, and stop rather than spending the whole budget in the loop.",
      browserBehavior:
        "A keydown handler cancels Tab and moves focus between the two trapped controls, so the control outside the trap is never reached.",
      evidence:
        "The navigation graph contains a cycle between two nodes, and the control outside it stays in the unreached set.",
      // SUSPICIOUS_FOCUS_ORDER appears here too, for the same reason as
      // focus-escape: the trap focuses its first control on mount.
      reportableIssues: [
        "UNREACHABLE_ELEMENT",
        "SUSPICIOUS_FOCUS_ORDER",
        "SUSPICIOUS_FOCUS_CYCLE",
      ],
    },
  },
  {
    id: "disabled",
    path: "/fixtures/disabled",
    title: "Disabled and hidden elements",
    summary:
      "Things that are correctly unfocusable. None of them is an accessibility failure.",
    initialFocus: null,
    expectedFocusOrder: ["Enabled action"],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Report nothing. A disabled button, a hidden input and a display:none control are all *correctly* unreachable, and flagging them would be a false positive that costs a reader their trust in the real findings.",
      browserBehavior:
        'Only "Enabled action" is focusable. The disabled button, the hidden input, the aria-hidden element and the display:none button are all skipped by Tab, as they should be.',
      evidence:
        "Discovery records the disabled and hidden elements with disabled=true or visible=false, which is what lets the rules layer leave them alone.",
      reportableIssues: [],
    },
  },
  {
    id: "no-controls",
    path: "/fixtures/no-controls",
    title: "No interactive controls",
    summary: "Prose only. There is nothing here to reach.",
    initialFocus: null,
    expectedFocusOrder: [],
    expectedUnreachable: [],
    expectation: {
      aiBehavior:
        "Recognise almost immediately that there is nothing to explore and STOP. It must not report NO_KEYBOARD_REACHABLE_CONTROLS, which is about a page that *has* controls and reaches none.",
      browserBehavior:
        "Tab moves focus straight out of the document; nothing on the page takes focus.",
      evidence: "No discovered interactive elements and no element focus positions.",
      reportableIssues: [],
    },
  },
]);

export function findFixture(id: string): Fixture | null {
  return FIXTURES.find((fixture) => fixture.id === id) ?? null;
}

/** Fixtures where a correct run reports nothing. The false-positive check. */
export const CLEAN_FIXTURES: readonly Fixture[] = FIXTURES.filter(
  (fixture) => fixture.expectation.reportableIssues.length === 0,
);
