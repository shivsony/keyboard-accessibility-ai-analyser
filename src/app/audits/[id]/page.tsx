import Link from "next/link";

import { LiveAuditView } from "@/components/audit/live-audit-view";

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-12">
      <nav>
        <Link href="/" className="text-muted-foreground text-sm hover:underline">
          ← New audit
        </Link>
      </nav>

      <LiveAuditView auditId={id} />
    </main>
  );
}
