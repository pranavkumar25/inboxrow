"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function CampaignActions({
  campaignId,
  status,
}: {
  campaignId: string;
  status: string;
}) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function setStatus(next: "ACTIVE" | "PAUSED") {
    setBusy(true);
    try {
      await fetch(`/api/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (status === "ACTIVE") {
    return (
      <button
        onClick={() => setStatus("PAUSED")}
        disabled={busy}
        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
      >
        {busy ? "…" : "Pause sending"}
      </button>
    );
  }
  if (status === "PAUSED") {
    return (
      <button
        onClick={() => setStatus("ACTIVE")}
        disabled={busy}
        className="rounded-lg border border-green-300 bg-green-50 px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-100 disabled:opacity-50"
      >
        {busy ? "…" : "Resume sending"}
      </button>
    );
  }
  return null;
}
