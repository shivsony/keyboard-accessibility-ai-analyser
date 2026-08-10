import {
  actionFor,
  AgentDecisionSchema,
  isKeyboardAction,
  type ActionGuardVerdict,
  type AgentDecision,
} from "@/lib/shared/domain";

/**
 * The action guard.
 *
 * Deterministic, non-AI, and the security boundary of the loop. It sits between
 * the model's decision and the browser, and decides whether a keypress is
 * allowed to happen at all (SECURITY.md §2).
 *
 * There is no bypass flag, no debug mode, and no configuration that disables it.
 * A caller that wants to press a key goes through here.
 */

/**
 * Validates a decision that arrived from anywhere.
 *
 * The provider already parses its own responses, but `AIProvider` is an
 * interface: a second implementation, a stub, or a bug could return something
 * that never met the schema. Re-validating here costs microseconds and removes
 * the need to trust every present and future provider.
 */
export function validateDecision(
  input: unknown,
): { valid: true; decision: AgentDecision } | { valid: false; problem: string } {
  const result = AgentDecisionSchema.safeParse(input);

  if (!result.success) {
    return {
      valid: false,
      problem: result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join(", "),
    };
  }

  return { valid: true, decision: result.data };
}

/**
 * Rules the decision to a verdict.
 *
 * Approval requires exact membership in the frozen allowlist — string equality,
 * not a prefix test, not a case-insensitive match over a wider space. A verdict
 * is returned rather than thrown because a rejection is evidence: a model
 * repeatedly asking for a key it cannot have is a signal, and an exception
 * would turn it into a stack trace instead of a row in the run record.
 */
export function guardDecision(decision: AgentDecision): ActionGuardVerdict {
  const action = actionFor(decision);

  // REPORT and STOP move nothing. There is no action to approve and none to
  // reject — a distinct outcome, so the record does not read as a refusal.
  if (action === null) return { outcome: "NO_ACTION" };

  if (!isKeyboardAction(action)) {
    return {
      outcome: "REJECTED",
      requested: typeof action === "string" ? action : JSON.stringify(action),
      reason: "ACTION_NOT_ALLOWLISTED",
    };
  }

  return { outcome: "APPROVED", action };
}

/** The verdict for a decision that never parsed. */
export function rejectMalformed(problem: string): ActionGuardVerdict {
  return {
    outcome: "REJECTED",
    requested: problem,
    reason: "MALFORMED_DECISION",
  };
}
