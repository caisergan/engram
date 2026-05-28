"use client";

import { useVault } from "@/components/dashboard/vault/VaultProvider";
import { VaultContent } from "@/components/dashboard/vault/VaultContent";
import { VaultUnlockForm } from "@/components/dashboard/vault/VaultUnlockForm";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "@karakeep/shared-react/trpc";

export default function VaultPage() {
  const api = useTRPC();
  const { isUnlocked } = useVault();
  const isSetupQuery = useQuery(api.vault.isSetup.queryOptions());

  if (isSetupQuery.isLoading) return null;

  if (!isSetupQuery.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">
          Set up your vault in Settings to get started.
        </p>
      </div>
    );
  }

  if (!isUnlocked) {
    return <VaultUnlockForm />;
  }

  return <VaultContent />;
}
