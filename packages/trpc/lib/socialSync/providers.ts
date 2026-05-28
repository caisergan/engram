import type {
  SocialPlatform,
  SocialSyncProvider,
} from "@karakeep/shared/types/socialSync";

import { instagramProvider } from "./instagramProvider";
import { xProvider } from "./xProvider";
import { youtubeProvider } from "./youtubeProvider";

const providers: Record<SocialPlatform, SocialSyncProvider> = {
  instagram: instagramProvider,
  x: xProvider,
  youtube: youtubeProvider,
};

export function getProvider(platform: SocialPlatform): SocialSyncProvider {
  return providers[platform];
}
