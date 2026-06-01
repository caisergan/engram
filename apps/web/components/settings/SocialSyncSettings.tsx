"use client";

import { useState } from "react";
import ActionConfirmingDialog from "@/components/ui/action-confirming-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import RelativeTime from "@/components/ui/relative-time";
import { SocialSyncProgress } from "@/components/settings/SocialSyncProgress";
import { SocialSyncRunHistory } from "@/components/settings/SocialSyncRunHistory";
import { useTranslation } from "@/lib/i18n/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import type { SocialPlatform } from "@karakeep/shared/types/socialSync";
import { useTRPC } from "@karakeep/shared-react/trpc";

const PLATFORMS: { id: SocialPlatform; name: string }[] = [
  { id: "instagram", name: "Instagram" },
  { id: "x", name: "X (Twitter)" },
  { id: "youtube", name: "YouTube" },
];

const INTERVALS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "24 hours" },
];

function PlatformCard({
  platform,
}: {
  platform: { id: SocialPlatform; name: string };
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery({
    ...api.socialSync.getConnections.queryOptions(),
    refetchInterval: (query) =>
      query.state.data?.some((c) => c.activeRun) ? 2000 : false,
  });
  const connection = connectionsQuery.data?.find(
    (c) => c.platform === platform.id,
  );

  const [connectOpen, setConnectOpen] = useState(false);
  const [cookies, setCookies] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [updateCookiesOpen, setUpdateCookiesOpen] = useState(false);
  const [updateCookiesValue, setUpdateCookiesValue] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries(api.socialSync.getConnections.queryFilter());

  const connectMutation = useMutation(
    api.socialSync.connect.mutationOptions({
      onSuccess: () => {
        toast.success(
          t("social_sync.connected_success", { platform: platform.name }),
        );
        invalidate();
        setConnectOpen(false);
        setCookies("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const disconnectMutation = useMutation(
    api.socialSync.disconnect.mutationOptions({
      onSuccess: () => {
        toast.success(
          t("social_sync.disconnected_success", {
            platform: platform.name,
          }),
        );
        invalidate();
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const updateCookiesMutation = useMutation(
    api.socialSync.updateCookies.mutationOptions({
      onSuccess: () => {
        toast.success(
          t("social_sync.connected_success", { platform: platform.name }),
        );
        invalidate();
        setUpdateCookiesOpen(false);
        setUpdateCookiesValue("");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const setEnabledMutation = useMutation(
    api.socialSync.setEnabled.mutationOptions({
      onSuccess: invalidate,
      onError: (err) => toast.error(err.message),
    }),
  );

  const updateSettingsMutation = useMutation(
    api.socialSync.updateSettings.mutationOptions({
      onSuccess: invalidate,
      onError: (err) => toast.error(err.message),
    }),
  );

  const syncNowMutation = useMutation(
    api.socialSync.syncNow.mutationOptions({
      onSuccess: () => {
        toast.success(
          t("social_sync.sync_triggered", { platform: platform.name }),
        );
        invalidate();
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const statusBadge = !connection ? (
    <Badge variant="secondary">{t("social_sync.not_connected")}</Badge>
  ) : connection.activeRun ? (
    <Badge variant="default">{t("social_sync.run_status_running")}</Badge>
  ) : connection.lastSyncStatus === "failure" ? (
    <Badge variant="destructive">{t("social_sync.auth_expired")}</Badge>
  ) : connection.lastSyncStatus === "pending" ? (
    <Badge variant="secondary">{t("social_sync.queued")}</Badge>
  ) : (
    <Badge variant="default">{t("social_sync.connected")}</Badge>
  );

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-lg">{platform.name}</CardTitle>
          {statusBadge}
        </CardHeader>
        <CardContent className="space-y-4">
          {!connection ? (
            <Button onClick={() => setConnectOpen(true)}>
              {t("social_sync.connect")}
            </Button>
          ) : (
            <>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>
                  {t("social_sync.total_synced", {
                    count: connection.totalSynced,
                  })}
                </span>
                {connection.lastSyncedAt && (
                  <span>
                    {t("social_sync.last_synced")}
                    <RelativeTime date={connection.lastSyncedAt} />
                  </span>
                )}
              </div>

              <SocialSyncProgress run={connection.activeRun ?? null} />

              {!connection.backfillComplete &&
                connection.enabled &&
                connection.lastSyncStatus !== "failure" && (
                  <p className="text-xs text-muted-foreground">
                    {t("social_sync.backfilling")}
                  </p>
                )}

              {connection.lastSyncError && (
                <p className="text-sm text-destructive">
                  {connection.lastSyncError}
                </p>
              )}

              <div className="flex items-center justify-between">
                <Label>{t("social_sync.sync_interval")}</Label>
                <Select
                  value={String(connection.syncIntervalMinutes)}
                  onValueChange={(v) =>
                    updateSettingsMutation.mutate({
                      connectionId: connection.id,
                      syncIntervalMinutes: parseInt(v),
                    })
                  }
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVALS.map((i) => (
                      <SelectItem key={i.value} value={String(i.value)}>
                        {i.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <Label>{t("social_sync.auto_tag")}</Label>
                <Input
                  className="w-40"
                  value={connection.autoTagName}
                  onChange={(e) =>
                    updateSettingsMutation.mutate({
                      connectionId: connection.id,
                      autoTagName: e.target.value,
                    })
                  }
                />
              </div>

              <div className="flex items-center justify-between">
                <Label>Enabled</Label>
                <Switch
                  checked={connection.enabled}
                  onCheckedChange={(checked) =>
                    setEnabledMutation.mutate({
                      connectionId: connection.id,
                      enabled: checked,
                    })
                  }
                />
              </div>

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!connection.enabled || syncNowMutation.isPending}
                  onClick={() =>
                    syncNowMutation.mutate({
                      connectionId: connection.id,
                    })
                  }
                >
                  {t("social_sync.sync_now")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setUpdateCookiesOpen(true)}
                >
                  {t("social_sync.update_cookies")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setDisconnectOpen(true)}
                >
                  {t("social_sync.disconnect")}
                </Button>
              </div>

              <SocialSyncRunHistory connectionId={connection.id} />
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("social_sync.connect_title", {
                platform: platform.name,
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("social_sync.connect_instructions_main", {
                platform: platform.name,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("social_sync.connect_instructions_alt")}
            </p>
            <Textarea
              placeholder={t("social_sync.cookies_placeholder")}
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              rows={5}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </DialogClose>
            <Button
              onClick={() =>
                connectMutation.mutate({
                  platform: platform.id,
                  cookies,
                })
              }
              disabled={connectMutation.isPending || !cookies.trim()}
            >
              {t("social_sync.connect")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={updateCookiesOpen} onOpenChange={setUpdateCookiesOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("social_sync.update_cookies")}</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder={t("social_sync.cookies_placeholder")}
            value={updateCookiesValue}
            onChange={(e) => setUpdateCookiesValue(e.target.value)}
            rows={5}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t("actions.cancel")}</Button>
            </DialogClose>
            <Button
              onClick={() =>
                connection &&
                updateCookiesMutation.mutate({
                  connectionId: connection.id,
                  cookies: updateCookiesValue,
                })
              }
              disabled={
                updateCookiesMutation.isPending || !updateCookiesValue.trim()
              }
            >
              {t("social_sync.update_cookies")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {connection && (
        <ActionConfirmingDialog
          open={disconnectOpen}
          setOpen={setDisconnectOpen}
          title={t("social_sync.disconnect")}
          description={
            <p className="text-sm text-muted-foreground">
              {t("social_sync.disconnect_confirm")}
            </p>
          }
          actionButton={(_setOpen) => (
            <Button
              variant="destructive"
              onClick={() =>
                disconnectMutation.mutate({
                  connectionId: connection.id,
                })
              }
              disabled={disconnectMutation.isPending}
            >
              {t("social_sync.disconnect")}
            </Button>
          )}
        />
      )}
    </>
  );
}

export function SocialSyncSettings() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {PLATFORMS.map((p) => (
        <PlatformCard key={p.id} platform={p} />
      ))}
    </div>
  );
}
