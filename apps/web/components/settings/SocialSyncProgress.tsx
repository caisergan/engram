"use client";

import RelativeTime from "@/components/ui/relative-time";
import { useTranslation } from "@/lib/i18n/client";

export interface ActiveRun {
  id: string;
  phase: "fetching" | "importing" | "finalizing" | null;
  pagesScanned: number;
  itemsFound: number;
  itemsImported: number;
  itemsFailed: number;
  startedAt: Date | string;
}

export function SocialSyncProgress({ run }: { run: ActiveRun | null }) {
  const { t } = useTranslation();
  if (!run) return null;

  const determinate = run.phase === "importing" && run.itemsFound > 0;
  const processedItems = Math.min(
    run.itemsFound,
    run.itemsImported + run.itemsFailed,
  );
  const pct = determinate
    ? Math.min(100, Math.round((processedItems / run.itemsFound) * 100))
    : run.phase === "finalizing"
      ? 95
      : null;

  const label =
    run.phase === "importing"
      ? t("social_sync.progress_importing", {
          imported: run.itemsImported,
          found: run.itemsFound,
        })
      : run.phase === "finalizing"
        ? t("social_sync.progress_finishing")
        : t("social_sync.progress_scanning", { page: run.pagesScanned });

  return (
    <div className="space-y-1">
      <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 break-words">
          {label}
          {run.itemsFailed > 0
            ? ` · ${t("social_sync.progress_failed_suffix", { count: run.itemsFailed })}`
            : ""}
        </span>
        <RelativeTime date={new Date(run.startedAt)} />
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full bg-primary transition-all ${
            pct === null ? "w-1/3 animate-pulse" : ""
          }`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
