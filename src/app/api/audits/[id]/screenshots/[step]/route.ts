import { readFile } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { getAuditRegistry } from "@/lib/agent/audit-registry";
import { getEnv } from "@/lib/shared/env";

/**
 * GET /api/audits/:id/screenshots/:step — a step's screenshot.
 *
 * Serves a PNG from the run's evidence directory. Both path segments are
 * validated against strict patterns and the resolved path is checked to be
 * inside the evidence directory: this route takes user input and turns it into
 * a filename, which is the shape of every directory-traversal bug ever written.
 *
 * A missing file is a 404 that says nothing about the server's layout.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUDIT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STEP = /^\d{1,6}$/;

type Context = { params: Promise<{ id: string; step: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { id, step } = await context.params;

  if (!AUDIT_ID.test(id) || !STEP.test(step)) return notFound();

  // The audit must exist. Without this the route would serve any PNG under the
  // evidence directory to anyone who guessed a name.
  if (getAuditRegistry().get(id) === null) return notFound();

  const root = path.resolve(getEnv().EVIDENCE_DIR);
  const file = path.resolve(root, id, "steps", `${step.padStart(4, "0")}.png`);

  // Belt and braces behind the pattern checks: whatever the input was, the
  // resolved path has to be inside the evidence directory.
  if (!file.startsWith(`${root}${path.sep}`)) return notFound();

  try {
    const png = await readFile(file);

    return new NextResponse(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        // Evidence for a finished step never changes.
        "cache-control": "private, max-age=3600",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return notFound();
  }
}

function notFound(): NextResponse {
  return NextResponse.json(
    { error: { code: "NOT_FOUND", message: "No screenshot for that step." } },
    { status: 404 },
  );
}
