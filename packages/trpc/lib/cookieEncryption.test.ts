import { describe, expect, test, vi } from "vitest";

import { decryptCookies, encryptCookies } from "./cookieEncryption";

vi.mock("@karakeep/shared/config", async (original) => {
  const mod = (await original()) as { default: Record<string, unknown> };
  return {
    default: {
      ...mod.default,
      signingSecret: () => "test-secret-long-enough-for-key-derivation!!",
    },
  };
});

describe("Cookie Encryption", () => {
  test("round-trips cookie JSON", async () => {
    const cookies = JSON.stringify({
      sessionid: "abc123",
      csrftoken: "xyz789",
    });
    const encrypted = await encryptCookies(cookies);
    expect(encrypted).not.toBe(cookies);
    const decrypted = await decryptCookies(encrypted);
    expect(decrypted).toBe(cookies);
  });

  test("produces different ciphertext each time", async () => {
    const cookies = '{"token": "same"}';
    const a = await encryptCookies(cookies);
    const b = await encryptCookies(cookies);
    expect(a).not.toBe(b);
  });

  test("fails to decrypt tampered data", async () => {
    const encrypted = await encryptCookies('{"a":"b"}');
    const tampered = encrypted.slice(0, -2) + "XX";
    await expect(decryptCookies(tampered)).rejects.toThrow();
  });
});
