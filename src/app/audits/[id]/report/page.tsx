import Link from "next/link";
import { notFound } from "next/navigation";

import { ReportView } from "@/components/audit/report-view";
import { getAuditRegistry } from "@/lib/agent/audit-registry";

/**
 * The finished report.
 *
 * Read straight from the registry on the server rather than fetched by the
 * browser: the report is complete and static once the audit ends, so there is
 * nothing to poll.
 */
export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const record = getAuditRegistry().get(id);

  if (record === null || record.report === null) notFound();

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-12">
      <nav className="flex gap-4">
        <Link href="/" className="text-muted-foreground text-sm hover:underline">
          ← New audit
        </Link>
        <Link
          href={`/audits/${id}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          Live view
        </Link>
      </nav>

      <ReportView report={record.report} auditId={id} />
    </main>
  );
}
