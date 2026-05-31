import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ConnectablePlatform } from "../utils/socialSyncPermissions";
import { readPlatformCookies } from "../utils/readPlatformCookies";
import { requestPlatformAccess } from "../utils/socialSyncPermissions";
import { useTRPC } from "../utils/trpc";
import { Button } from "./ui/button";

const PLATFORMS: { id: ConnectablePlatform; name: string }[] = [
  { id: "instagram", name: "Instagram" },
  { id: "x", name: "X" },
];

export default function SocialSyncConnect() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const connectionsQuery = useQuery(
    api.socialSync.getConnections.queryOptions(),
  );
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries(api.socialSync.getConnections.queryFilter());

  const connectMutation = useMutation(api.socialSync.connect.mutationOptions());
  const updateMutation = useMutation(
    api.socialSync.updateCookies.mutationOptions(),
  );

  const handleConnect = async (
    platform: ConnectablePlatform,
    name: string,
    existingId: string | undefined,
  ) => {
    setStatus((s) => ({ ...s, [platform]: "" }));
    setBusy(platform);
    try {
      // Permission request must be the first thing off the user gesture.
      const granted = await requestPlatformAccess(platform);
      if (!granted) {
        setStatus((s) => ({
          ...s,
          [platform]: `Permission needed to read ${name} cookies`,
        }));
        return;
      }
      const cookies = await readPlatformCookies(platform);
      if (!cookies) {
        setStatus((s) => ({
          ...s,
          [platform]: `Open and log into ${name} in this browser, then try again`,
        }));
        return;
      }
      if (existingId) {
        await updateMutation.mutateAsync({ connectionId: existingId, cookies });
      } else {
        await connectMutation.mutateAsync({ platform, cookies });
      }
      setStatus((s) => ({ ...s, [platform]: "Connected" }));
      invalidate();
    } catch (e) {
      setStatus((s) => ({
        ...s,
        [platform]: e instanceof Error ? e.message : "Failed to connect",
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">Social Sync</h3>
      {PLATFORMS.map((p) => {
        const connection = connectionsQuery.data?.find(
          (c) => c.platform === p.id,
        );
        const connected = !!connection;
        return (
          <div key={p.id} className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span>{p.name}</span>
              <Button
                disabled={busy === p.id}
                onClick={() => handleConnect(p.id, p.name, connection?.id)}
              >
                {connected ? "Reconnect" : "Connect"}
              </Button>
            </div>
            {status[p.id] && (
              <span className="text-sm text-muted-foreground">
                {status[p.id]}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
