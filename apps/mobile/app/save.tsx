import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useLocalSearchParams, useRouter } from "expo-router";
import ErrorAnimation from "@/components/sharing/ErrorAnimation";
import LoadingAnimation from "@/components/sharing/LoadingAnimation";
import SuccessAnimation from "@/components/sharing/SuccessAnimation";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import useAppSettings from "@/lib/settings";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { useTRPC } from "@karakeep/shared-react/trpc";
import { BookmarkTypes, ZBookmark } from "@karakeep/shared/types/bookmarks";

type Mode =
  | { type: "idle" }
  | { type: "success"; bookmarkId: string }
  | { type: "alreadyExists"; bookmarkId: string }
  | { type: "error" };

// Saves the bookmark passed via the `karakeep://save?url=...` (or `?text=...`)
// deep link. Mirrors the share-intent flow in sharing.tsx, but the payload comes
// from the deep-link query params instead of the OS share sheet. This powers a
// one-action capture, e.g. an iOS Back-Tap Shortcut that opens
// `karakeep://save?url=<current page url>`.
function SaveFromLink({ setMode }: { setMode: (mode: Mode) => void }) {
  const api = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { url, text } = useLocalSearchParams<{ url?: string; text?: string }>();
  const { settings, isLoading } = useAppSettings();

  const onSaved = (d: ZBookmark & { alreadyExists: boolean }) => {
    queryClient.invalidateQueries(api.bookmarks.getBookmarks.pathFilter());
    setMode({
      type: d.alreadyExists ? "alreadyExists" : "success",
      bookmarkId: d.id,
    });
  };

  const { mutate, isPending } = useMutation(
    api.bookmarks.createBookmark.mutationOptions({
      onSuccess: onSaved,
      onError: () => {
        setMode({ type: "error" });
      },
    }),
  );

  useEffect(() => {
    if (isLoading || isPending) {
      return;
    }
    // Not signed in yet: route to sign-in instead of failing the save.
    if (!settings.apiKey) {
      router.replace("signin");
      return;
    }
    // Expo Router URL-decodes query params before handing them to us.
    if (url) {
      mutate({ type: BookmarkTypes.LINK, url, source: "mobile" });
    } else if (text) {
      if (z.string().url().safeParse(text).success) {
        mutate({ type: BookmarkTypes.LINK, url: text, source: "mobile" });
      } else {
        mutate({ type: BookmarkTypes.TEXT, text, source: "mobile" });
      }
    } else {
      // No url/text payload in the deep link.
      setMode({ type: "error" });
    }
  }, [isLoading]);

  return null;
}

export default function Save() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ type: "idle" });

  const autoCloseTimeoutId = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto dismiss after saving.
  useEffect(() => {
    if (mode.type === "idle") {
      return;
    }

    autoCloseTimeoutId.current = setTimeout(
      () => {
        router.replace("dashboard");
      },
      mode.type === "error" ? 3000 : 2500,
    );

    return () => {
      if (autoCloseTimeoutId.current) {
        clearTimeout(autoCloseTimeoutId.current);
      }
    };
  }, [mode.type]);

  const handleManage = () => {
    if (mode.type === "success" || mode.type === "alreadyExists") {
      router.replace(`/dashboard/bookmarks/${mode.bookmarkId}/info`);
      if (autoCloseTimeoutId.current) {
        clearTimeout(autoCloseTimeoutId.current);
      }
    }
  };

  const handleDismiss = () => {
    if (autoCloseTimeoutId.current) {
      clearTimeout(autoCloseTimeoutId.current);
    }
    router.replace("dashboard");
  };

  return (
    <View className="flex-1 items-center justify-center bg-background">
      {/* Hidden component that handles the save logic */}
      {mode.type === "idle" && <SaveFromLink setMode={setMode} />}

      {/* Loading State */}
      {mode.type === "idle" && <LoadingAnimation />}

      {/* Success State */}
      {(mode.type === "success" || mode.type === "alreadyExists") && (
        <Animated.View
          entering={FadeIn.duration(200)}
          className="items-center gap-6"
        >
          <SuccessAnimation isAlreadyExists={mode.type === "alreadyExists"} />

          <Animated.View
            entering={FadeIn.delay(400).duration(300)}
            className="items-center gap-2"
          >
            <Text variant="title1" className="font-semibold text-foreground">
              {mode.type === "alreadyExists" ? "Already Hoarded!" : "Hoarded!"}
            </Text>
            <Text variant="body" className="text-muted-foreground">
              {mode.type === "alreadyExists"
                ? "This item was saved before"
                : "Saved to your collection"}
            </Text>
          </Animated.View>

          <Animated.View
            entering={FadeIn.delay(600).duration(300)}
            className="items-center gap-3 pt-2"
          >
            <Button onPress={handleManage} variant="primary" size="lg">
              <Text className="font-medium text-primary-foreground">
                Manage
              </Text>
            </Button>
            <Pressable
              onPress={handleDismiss}
              className="px-4 py-2 active:opacity-60"
            >
              <Text className="text-muted-foreground">Dismiss</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      )}

      {/* Error State */}
      {mode.type === "error" && (
        <Animated.View
          entering={FadeIn.duration(200)}
          className="items-center gap-6"
        >
          <ErrorAnimation />

          <Animated.View
            entering={FadeIn.delay(300).duration(300)}
            className="items-center gap-2"
          >
            <Text variant="title1" className="font-semibold text-foreground">
              Oops!
            </Text>
            <Text variant="body" className="text-muted-foreground">
              Something went wrong
            </Text>
          </Animated.View>

          <Animated.View
            entering={FadeIn.delay(500).duration(300)}
            className="items-center gap-3 pt-2"
          >
            <Pressable
              onPress={handleDismiss}
              className="px-4 py-2 active:opacity-60"
            >
              <Text className="text-muted-foreground">Dismiss</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      )}
    </View>
  );
}
