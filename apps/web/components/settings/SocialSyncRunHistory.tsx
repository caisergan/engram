"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import RelativeTime from "@/components/ui/relative-time";
import { useTranslation } from "@/lib/i18n/client";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

function formatDuration(start: Date, end: Date): string {
  const secs = Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / 1000),
  );
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function SocialSyncRunHistory({
  connectionId,
}: {
  connectionId: string;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const [open, setOpen] = useState(false);

  const runsQuery = useQuery({
    ...api.socialSync.getRuns.queryOptions({ connectionId }),
    enabled: open,
  });

  const runs = runsQuery.data ?? [];

  return (
    <div className="text-sm">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto px-0 text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾ " : "▸ "}
        {t("social_sync.recent_runs")}
      </Button>

      {open && (
        <ul className="mt-1 space-y-1">
          {runs.length === 0 && (
            <li className="text-xs text-muted-foreground">
              {t("social_sync.no_runs")}
            </li>
          )}
          {runs.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span className="flex items-center gap-1">
                <span aria-hidden>
                  {r.status === "success"
                    ? "✓"
                    : r.status === "failure"
                      ? "✗"
                      : "⟳"}
                </span>
                <span className="text-muted-foreground">
                  {r.trigger === "manual"
                    ? t("social_sync.run_trigger_manual")
                    : t("social_sync.run_trigger_scheduled")}
                </span>
                <RelativeTime date={new Date(r.startedAt)} />
              </span>
              <span className="text-right text-muted-foreground">
                {r.status === "failure" && r.error
                  ? r.error
                  : t("social_sync.run_imported", { count: r.itemsImported })}
                {r.itemsFailed > 0
                  ? ` · ${t("social_sync.progress_failed_suffix", { count: r.itemsFailed })}`
                  : ""}
                {r.finishedAt
                  ? ` · ${formatDuration(new Date(r.startedAt), new Date(r.finishedAt))}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
