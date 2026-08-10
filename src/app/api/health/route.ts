import { NextResponse } from "next/server";

/**
 * Liveness probe.
 *
 * Deliberately reports nothing about configuration — no key presence, no model
 * name, no environment detail. A health endpoint is unauthenticated, and
 * "is a key configured" is information a probe does not need.
 */
export function GET() {
  return NextResponse.json({ status: "ok" } as const);
}
