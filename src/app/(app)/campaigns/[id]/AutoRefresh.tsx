"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Periodically re-runs the (force-dynamic) server component so live metrics —
 * opens/clicks land in the DB in real time, sends/replies as the engine posts
 * them — show without a manual reload. Pauses while the tab is hidden and
 * refreshes immediately on refocus.
 */
export function AutoRefresh({ intervalMs = 10000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) router.refresh();
    };
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) router.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router, intervalMs]);

  return null;
}
