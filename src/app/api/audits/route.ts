import { NextResponse } from "next/server";
import { z } from "zod";

import { getAuditRegistry } from "@/lib/agent/audit-registry";
import { checkAIConfiguration } from "@/lib/ai";
import { UrlSchema } from "@/lib/shared/domain";

/**
 * POST /api/audits — start an audit.
 *
 * The run happens in this process and continues after the response is sent, so
 * **the MVP requires a long-running Node.js server**. There is no queue and no
 * database; see `lib/agent/audit-registry.ts` for what that costs.
 *
 * Nothing in a response here carries a credential, an environment variable, or
 * a filesystem path. Errors are coded and phrased for a human, and the
 * underlying cause is never passed through verbatim.
 */

/** Node, not Edge: the audit drives a real Chromium. */
export const runtime = "nodejs";
/** Never cached — each POST starts a new run. */
export const dynamic = "force-dynamic";

const StartAuditRequestSchema = z.object({
  url: UrlSchema,
});

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "The request body must be JSON.",
        },
      },
      { status: 400 },
    );
  }

  const parsed = StartAuditRequestSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "INVALID_URL",
          message: "Provide a URL to audit, as an absolute http:// or https:// address.",
          // Field-level detail from our own schema. Safe: it describes the
          // request that was sent, not anything about the server.
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  // Checked before starting so the caller learns about it now, rather than
  // after polling a run that was never going to work.
  const configuration = checkAIConfiguration();

  if (!configuration.configured) {
    return NextResponse.json(
      { error: { code: "AI_NOT_CONFIGURED", message: configuration.message } },
      { status: 503 },
    );
  }

  const record = getAuditRegistry().start(parsed.data.url);

  return NextResponse.json({ auditId: record.id }, { status: 202 });
}
