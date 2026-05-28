import { z } from "zod";

export const zVaultSetupSchema = z.object({
  pin: z.string().min(4).max(64),
});

export const zVaultUnlockSchema = z.object({
  pin: z.string().min(1),
});

export const zVaultChangePinSchema = z.object({
  currentPin: z.string().min(1),
  newPin: z.string().min(4).max(64),
});

export const zVaultUpdateSettingsSchema = z.object({
  autoLockMinutes: z
    .number()
    .int()
    .refine((v) => [1, 5, 15, 30, 60].includes(v), {
      message: "Auto-lock must be 1, 5, 15, 30, or 60 minutes",
    }),
});

export const zVaultDeleteSchema = z.object({
  pin: z.string().min(1),
});

export const zMoveToVaultSchema = z.object({
  bookmarkId: z.string(),
});
