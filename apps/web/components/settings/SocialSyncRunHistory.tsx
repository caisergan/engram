"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import RelativeTime from "@/components/ui/relative-time";
import { useTranslation } from "@/lib/i18n/client";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  X,
} from "lucide-react";

import { useTRPC } from "@karakeep/shared-react/trpc";

function formatDuration(start: Date, end: Date): string {
  const secs = Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / 1000),
  );
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function RunStatusIcon({
  status,
}: {
  status: "running" | "success" | "failure";
}) {
  if (status === "success")
    return (
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-green-500/15">
        <Check className="h-3 w-3 text-green-500" aria-hidden />
      </div>
    );
  if (status === "failure")
    return (
      <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/15">
        <X className="h-3 w-3 text-red-500" aria-hidden />
      </div>
    );
  return (
    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/15">
      <Loader2 className="h-3 w-3 animate-spin text-blue-500" aria-hidden />
    </div>
  );
}

function TriggerBadge({ trigger }: { trigger: string }) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {trigger === "manual"
        ? t("social_sync.run_trigger_manual")
        : t("social_sync.run_trigger_scheduled")}
    </span>
  );
}

function RunRow({
  run,
}: {
  run: {
    id: string;
    trigger: string;
    status: "running" | "success" | "failure";
    itemsImported: number;
    itemsFailed: number;
    error: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  };
}) {
  const { t } = useTranslation();

  const hasFailures = run.itemsFailed > 0;
  const duration = run.finishedAt
    ? formatDuration(run.startedAt, run.finishedAt)
    : null;

  return (
    <li className="flex gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-muted/50">
      <div className="mt-0.5">
        <RunStatusIcon status={run.status} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <TriggerBadge trigger={run.trigger} />
          <span className="text-xs text-muted-foreground">
            <RelativeTime date={run.startedAt} />
          </span>
          {duration && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground/60">
              <Clock className="h-3 w-3" aria-hidden />
              {duration}
            </span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {run.status === "running" ? (
            <span className="text-blue-400">
              {t("social_sync.run_status_running")}
            </span>
          ) : (
            <>
              {run.itemsImported > 0 && (
                <span className="font-medium text-green-400">
                  {t("social_sync.run_imported", {
                    count: run.itemsImported,
                  })}
                </span>
              )}
              {hasFailures && (
                <span className="font-medium text-red-400">
                  {t("social_sync.progress_failed_suffix", {
                    count: run.itemsFailed,
                  })}
                </span>
              )}
              {run.status === "failure" &&
                run.itemsImported === 0 &&
                !hasFailures &&
                run.error && <span className="text-red-400">{run.error}</span>}
              {run.itemsImported === 0 && !hasFailures && !run.error && (
                <span className="text-muted-foreground">
                  {t("social_sync.run_imported", { count: 0 })}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
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
        className="h-auto min-h-8 px-0 text-muted-foreground"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown className="mr-1 h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="mr-1 h-4 w-4" aria-hidden />
        )}
        {t("social_sync.recent_runs")}
      </Button>

      {open && (
        <ul className="-mx-2 mt-1 space-y-0.5">
          {runs.length === 0 && (
            <li className="px-2 py-2 text-xs text-muted-foreground">
              {t("social_sync.no_runs")}
            </li>
          )}
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ul>
      )}
    </div>
  );
}
