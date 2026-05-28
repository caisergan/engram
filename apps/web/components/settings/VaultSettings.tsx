"use client";

import { useState } from "react";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useTRPC } from "@karakeep/shared-react/trpc";

function VaultSetupForm() {
  const { t } = useTranslation();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  const setupMutation = useMutation(
    api.vault.setup.mutationOptions({
      onSuccess: () => {
        toast.success(t("vault.setup_title"));
        queryClient.invalidateQueries(api.vault.isSetup.queryFilter());
        setPin("");
        setConfirmPin("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pin !== confirmPin) {
      toast.error(t("vault.pins_dont_match"));
      return;
    }
    setupMutation.mutate({ pin });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("vault.setup_description")}
      </p>
      <div className="space-y-2">
        <Label>{t("vault.setup_pin_label")}</Label>
        <Input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          minLength={4}
          maxLength={64}
        />
      </div>
      <div className="space-y-2">
        <Label>{t("vault.setup_confirm_label")}</Label>
        <Input
          type="password"
          value={confirmPin}
          onChange={(e) => setConfirmPin(e.target.value)}
        />
      </div>
      <p className="text-xs text-destructive">{t("vault.setup_warning")}</p>
      <Button
        type="submit"
        disabled={setupMutation.isPending || pin.length < 4}
      >
        {t("vault.setup_button")}
      </Button>
    </form>
  );
}

function VaultManageForm() {
  const { t } = useTranslation();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(api.vault.getSettings.queryOptions());
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePin, setDeletePin] = useState("");
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmNewPin, setConfirmNewPin] = useState("");

  const updateSettingsMutation = useMutation(
    api.vault.updateSettings.mutationOptions({
      onSuccess: () => {
        toast.success("Settings updated");
        queryClient.invalidateQueries(api.vault.getSettings.queryFilter());
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const changePinMutation = useMutation(
    api.vault.changePin.mutationOptions({
      onSuccess: () => {
        toast.success(t("vault.change_pin"));
        setChangePinOpen(false);
        setCurrentPin("");
        setNewPin("");
        setConfirmNewPin("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const deleteVaultMutation = useMutation(
    api.vault.deleteVault.mutationOptions({
      onSuccess: () => {
        toast.success(t("vault.delete_vault"));
        queryClient.invalidateQueries(api.vault.isSetup.queryFilter());
        setDeleteDialogOpen(false);
        setDeletePin("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Label>{t("vault.auto_lock_label")}</Label>
        <Select
          value={String(settingsQuery.data?.autoLockMinutes ?? 5)}
          onValueChange={(v) =>
            updateSettingsMutation.mutate({ autoLockMinutes: parseInt(v) })
          }
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[1, 5, 15, 30, 60].map((m) => (
              <SelectItem key={m} value={String(m)}>
                {m === 1
                  ? t("vault.auto_lock_minute")
                  : t("vault.auto_lock_minutes", { count: m })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Button variant="outline" onClick={() => setChangePinOpen(true)}>
          {t("vault.change_pin")}
        </Button>
      </div>

      <div>
        <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
          {t("vault.delete_vault")}
        </Button>
      </div>

      <Dialog open={changePinOpen} onOpenChange={setChangePinOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("vault.change_pin")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t("vault.change_pin_current")}</Label>
              <Input
                type="password"
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("vault.change_pin_new")}</Label>
              <Input
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
              />
            </div>
            <div>
              <Label>{t("vault.change_pin_confirm")}</Label>
              <Input
                type="password"
                value={confirmNewPin}
                onChange={(e) => setConfirmNewPin(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </DialogClose>
            <Button
              onClick={() => {
                if (newPin !== confirmNewPin) {
                  toast.error(t("vault.pins_dont_match"));
                  return;
                }
                changePinMutation.mutate({ currentPin, newPin });
              }}
              disabled={changePinMutation.isPending}
            >
              {t("vault.change_pin")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ActionConfirmingDialog
        open={deleteDialogOpen}
        setOpen={setDeleteDialogOpen}
        title={t("vault.delete_vault")}
        description={
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("vault.delete_vault_warning")}
            </p>
            <div>
              <Label>{t("vault.delete_vault_confirm")}</Label>
              <Input
                type="password"
                value={deletePin}
                onChange={(e) => setDeletePin(e.target.value)}
              />
            </div>
          </div>
        }
        actionButton={() => (
          <Button
            variant="destructive"
            onClick={() => deleteVaultMutation.mutate({ pin: deletePin })}
            disabled={deleteVaultMutation.isPending || !deletePin}
          >
            {t("vault.delete_vault")}
          </Button>
        )}
      />
    </div>
  );
}

export function VaultSettings() {
  const { t } = useTranslation();
  const api = useTRPC();
  const isSetupQuery = useQuery(api.vault.isSetup.queryOptions());

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">{t("vault.settings_title")}</h2>
      {isSetupQuery.isLoading ? null : isSetupQuery.data ? (
        <VaultManageForm />
      ) : (
        <VaultSetupForm />
      )}
    </div>
  );
}
