import type { Metadata } from "next";
import { SocialSyncSettings } from "@/components/settings/SocialSyncSettings";
import { useTranslation } from "@/lib/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return {
    title: `${t("settings.sync.social_sync")} | Karakeep`,
  };
}

export default async function SyncSettingsPage() {
  // oxlint-disable-next-line rules-of-hooks
  const { t } = await useTranslation();
  return (
    <div className="flex flex-col gap-4 p-4">
      <h1 className="text-2xl font-bold">{t("social_sync.title")}</h1>
      <p className="text-muted-foreground">{t("social_sync.description")}</p>
      <SocialSyncSettings />
    </div>
  );
}
