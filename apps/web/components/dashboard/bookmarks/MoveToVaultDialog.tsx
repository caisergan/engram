"use client";

import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { Button } from "@/components/ui/button";
import { useVault } from "@/components/dashboard/vault/VaultProvider";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTRPC } from "@karakeep/shared-react/trpc";

export function MoveToVaultDialog({
  bookmarkId,
  open,
  onOpenChange,
}: {
  bookmarkId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { isUnlocked } = useVault();
  const api = useTRPC();
  const queryClient = useQueryClient();

  const moveToVaultMutation = useMutation(
    api.bookmarks.moveToVault.mutationOptions({
      onSuccess: () => {
        toast.success(t("vault.move_to_vault"));
        queryClient.invalidateQueries(api.bookmarks.getBookmarks.pathFilter());
        onOpenChange(false);
      },
      onError: (err) => {
        toast.error(err.message);
      },
    }),
  );

  if (!isUnlocked) {
    return (
      <ActionConfirmingDialog
        open={open}
        setOpen={onOpenChange}
        title={t("vault.move_to_vault")}
        description={<p>{t("vault.move_to_vault_unlock_first")}</p>}
        actionButton={(setOpen) => (
          <Button variant="secondary" onClick={() => setOpen(false)}>
            OK
          </Button>
        )}
      />
    );
  }

  return (
    <ActionConfirmingDialog
      open={open}
      setOpen={onOpenChange}
      title={t("vault.move_to_vault")}
      description={<p>{t("vault.move_to_vault_confirm")}</p>}
      actionButton={(_setOpen) => (
        <Button
          variant="destructive"
          onClick={() => moveToVaultMutation.mutate({ bookmarkId })}
          disabled={moveToVaultMutation.isPending}
        >
          {t("vault.move_to_vault")}
        </Button>
      )}
    />
  );
}
