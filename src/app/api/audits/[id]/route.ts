import { NextResponse } from "next/server";

import { getAuditRegistry, type AuditRecord } from "@/lib/agent/audit-registry";

/**
 * GET /api/audits/:id — poll an audit.
 * DELETE /api/audits/:id — cancel one.
 *
 * The response carries the record and, once finished, the report. It never
 * carries an API key, an environment variable, or a server filesystem path —
 * the shape is built field by field rather than by serializing an internal
 * object, so a field added upstream cannot leak by default.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const record = getAuditRegistry().get(id);

  if (record === null) return notFound();

  return NextResponse.json(toResponse(record));
}

export async function DELETE(_request: Request, context: Context): Promise<NextResponse> {
  const { id } = await context.params;
  const record = getAuditRegistry().cancel(id);

  if (record === null) return notFound();

  return NextResponse.json(toResponse(record));
}

function notFound(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "NOT_FOUND",
        // Deliberately says nothing about why. Audits are held in memory, so a
        // restart makes every id unknown; distinguishing "never existed" from
        // "was lost" would tell a caller about the server's lifecycle.
        message: "No audit with that id.",
      },
    },
    { status: 404 },
  );
}

/**
 * The public shape of an audit.
 *
 * Built explicitly. `result` is the generated report, which is already free of
 * absolute paths — screenshot references are relative to the run directory —
 * and carries its own limitations, so it can be handed to a client whole.
 */
function toResponse(record: AuditRecord): {
  id: string;
  status: AuditRecord["status"];
  step: number;
  url: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  live: AuditRecord["live"];
  result: AuditRecord["report"];
  error: AuditRecord["error"];
} {
  return {
    id: record.id,
    status: record.status,
    step: record.step,
    url: record.url,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    live: record.live,
    result: record.report,
    error: record.error,
  };
}
