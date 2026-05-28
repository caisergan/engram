"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { toast } from "sonner";

import { useTRPC } from "@karakeep/shared-react/trpc";

import { useVault } from "./VaultProvider";

export function VaultUnlockForm() {
  const { t } = useTranslation();
  const api = useTRPC();
  const { unlock } = useVault();
  const [pin, setPin] = useState("");

  const settingsQuery = useQuery(api.vault.getSettings.queryOptions());

  const unlockMutation = useMutation(
    api.vault.unlock.mutationOptions({
      onSuccess: async (data) => {
        const autoLockMinutes = settingsQuery.data?.autoLockMinutes ?? 5;
        unlock(data.token, autoLockMinutes);
        setPin("");
      },
      onError: () => {
        toast.error(t("vault.incorrect_pin"));
        setPin("");
      },
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    unlockMutation.mutate({ pin });
  };

  return (
    <div className="flex h-full items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-sm flex-col items-center gap-6"
      >
        <Lock className="size-12 text-muted-foreground" />
        <p className="text-lg text-muted-foreground">{t("vault.locked")}</p>
        <Input
          type="password"
          placeholder={t("vault.pin_placeholder")}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="text-center text-lg tracking-widest"
          autoFocus
        />
        <Button
          type="submit"
          disabled={unlockMutation.isPending || !pin.trim()}
          className="w-full"
        >
          {t("vault.unlock")}
        </Button>
      </form>
    </div>
  );
}
