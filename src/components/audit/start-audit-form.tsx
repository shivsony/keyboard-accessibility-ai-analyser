"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ApiError, StartAuditResponse } from "@/lib/shared/api-types";

/**
 * Starts an audit and sends the user to its live view.
 *
 * Client-side validation is a courtesy, not a control: the server validates the
 * URL with the same rules and is the only thing that decides. Checking here
 * just saves a round trip on an obvious typo.
 */
export function StartAuditForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const checkAPIhealth = async () => {
      const response = await fetch(`/api/health`);
      const body = await response.json();
      console.log(body);
    };

    checkAPIhealth();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmed = url.trim();

    if (!/^https?:\/\/.+/i.test(trimmed)) {
      setError("Enter an absolute URL starting with http:// or https://");
      return;
    }

    setStarting(true);

    try {
      const response = await fetch("/api/audits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: trimmed }),
      });

      if (!response.ok) {
        const body = (await response.json()) as ApiError;
        setError(body.error.message);
        setStarting(false);
        return;
      }

      const { auditId } = (await response.json()) as StartAuditResponse;
      router.push(`/audits/${auditId}`);
    } catch {
      setError("Could not reach the server. Is it still running?");
      setStarting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <Label htmlFor="audit-url" className="text-sm font-medium">
        URL to analyze
      </Label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="audit-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="url"
          placeholder="https://example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={starting}
          aria-describedby={error === null ? "audit-url-hint" : "audit-url-error"}
          aria-invalid={error !== null}
          className="font-mono sm:flex-1"
        />
        <Button type="submit" disabled={starting} className="sm:w-32">
          {starting ? "Starting…" : "Analyze"}
        </Button>
      </div>

      <p id="audit-url-hint" className="text-muted-foreground text-sm">
        The audit opens this page in Chromium and explores it using only Tab and
        Shift+Tab.
      </p>

      {/* Announced, not just shown: this is an accessibility tool. */}
      <p
        id="audit-url-error"
        role="alert"
        aria-live="polite"
        className="min-h-5 text-sm text-red-400"
      >
        {error}
      </p>
    </form>
  );
}
