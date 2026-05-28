"use client";

import InfoTooltip from "@/components/ui/info-tooltip";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import UpdatableBookmarksGrid from "@/components/dashboard/bookmarks/UpdatableBookmarksGrid";
import { useTranslation } from "@/lib/i18n/client";
import { Lock, LockOpen } from "lucide-react";

import { useVault } from "./VaultProvider";

export function VaultContent() {
  const { t } = useTranslation();
  const { lock, timeRemaining } = useVault();

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <p className="text-2xl">{t("vault.title")}</p>
          <LockOpen className="my-auto size-5" />
          <InfoTooltip size={17} className="my-auto" variant="explain">
            <p>{t("vault.move_to_vault_confirm")}</p>
          </InfoTooltip>
        </div>
        <div className="flex items-center gap-3">
          {timeRemaining !== null && (
            <span className="text-sm text-muted-foreground">
              {t("vault.auto_lock_timer", {
                time: formatTime(timeRemaining),
              })}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={lock}>
            <Lock className="mr-1 size-4" />
            {t("vault.lock")}
          </Button>
        </div>
      </div>
      <Separator />
      <UpdatableBookmarksGrid
        query={{ vaulted: true }}
        bookmarks={{ bookmarks: [], nextCursor: null }}
        showEditorCard={true}
      />
    </div>
  );
}
