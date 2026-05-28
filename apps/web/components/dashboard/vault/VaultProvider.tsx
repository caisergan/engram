"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { setVaultToken } from "@/lib/vaultToken";

interface VaultContextType {
  isUnlocked: boolean;
  unlock: (token: string, autoLockMinutes: number) => void;
  lock: () => void;
  timeRemaining: number | null;
}

const VaultContext = createContext<VaultContextType | null>(null);

export function useVault(): VaultContextType {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    return { isUnlocked: false, unlock: noop, lock: noop, timeRemaining: null };
  }
  return ctx;
}

function noop() {
  /* default no-op for context consumers outside provider */
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [hasToken, setHasToken] = useState(false);
  const [_expiresAt, setExpiresAt] = useState<number | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const lock = useCallback(() => {
    setVaultToken(null);
    setHasToken(false);
    setExpiresAt(null);
    setTimeRemaining(null);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const unlock = useCallback(
    (newToken: string, autoLockMinutes: number) => {
      setVaultToken(newToken);
      setHasToken(true);
      const exp = Date.now() + autoLockMinutes * 60 * 1000;
      setExpiresAt(exp);
      setTimeRemaining(autoLockMinutes * 60);

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        const remaining = Math.max(0, Math.floor((exp - Date.now()) / 1000));
        setTimeRemaining(remaining);
        if (remaining <= 0) {
          lock();
        }
      }, 1000);
    },
    [lock],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <VaultContext.Provider
      value={{
        isUnlocked: hasToken,
        unlock,
        lock,
        timeRemaining,
      }}
    >
      {children}
    </VaultContext.Provider>
  );
}
