import serverConfig from "@karakeep/shared/config";

import { decryptText, deriveEncryptionKey, encryptText } from "./vaultCrypto";

const FIXED_SALT = "engram-social-sync-cookie-encryption";

let cachedKey: Buffer | null = null;

async function getEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  cachedKey = await deriveEncryptionKey(
    serverConfig.signingSecret(),
    FIXED_SALT,
  );
  return cachedKey;
}

export async function encryptCookies(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  return encryptText(plaintext, key);
}

export async function decryptCookies(ciphertext: string): Promise<string> {
  const key = await getEncryptionKey();
  return decryptText(ciphertext, key);
}
