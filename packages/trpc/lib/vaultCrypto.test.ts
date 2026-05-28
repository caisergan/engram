import { describe, expect, test } from "vitest";

import {
  createVaultToken,
  decryptBuffer,
  decryptText,
  deriveEncryptionKey,
  encryptBuffer,
  encryptText,
  hashPin,
  verifyPin,
  verifyVaultToken,
} from "./vaultCrypto";

describe("Vault Crypto", () => {
  const testPin = "123456";
  const testSalt = "a".repeat(32);
  const testSecret = "test-signing-secret-at-least-32-chars-long!!";

  describe("deriveEncryptionKey", () => {
    test("derives a consistent key from same pin and salt", async () => {
      const key1 = await deriveEncryptionKey(testPin, testSalt);
      const key2 = await deriveEncryptionKey(testPin, testSalt);
      expect(key1).toEqual(key2);
      expect(key1.length).toBe(32);
    });

    test("derives different keys for different pins", async () => {
      const key1 = await deriveEncryptionKey("111111", testSalt);
      const key2 = await deriveEncryptionKey("222222", testSalt);
      expect(key1).not.toEqual(key2);
    });

    test("derives different keys for different salts", async () => {
      const key1 = await deriveEncryptionKey(testPin, "a".repeat(32));
      const key2 = await deriveEncryptionKey(testPin, "b".repeat(32));
      expect(key1).not.toEqual(key2);
    });
  });

  describe("encryptText / decryptText", () => {
    test("round-trips text correctly", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const plaintext = "Hello, Vault!";
      const ciphertext = encryptText(plaintext, key);
      expect(ciphertext).not.toBe(plaintext);
      const decrypted = decryptText(ciphertext, key);
      expect(decrypted).toBe(plaintext);
    });

    test("produces different ciphertext each time (random IV)", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const c1 = encryptText("same text", key);
      const c2 = encryptText("same text", key);
      expect(c1).not.toBe(c2);
    });

    test("fails to decrypt with wrong key", async () => {
      const key1 = await deriveEncryptionKey("111111", testSalt);
      const key2 = await deriveEncryptionKey("222222", testSalt);
      const ciphertext = encryptText("secret", key1);
      expect(() => decryptText(ciphertext, key2)).toThrow();
    });

    test("handles empty string", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const ciphertext = encryptText("", key);
      expect(decryptText(ciphertext, key)).toBe("");
    });

    test("handles unicode text", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const text = "Hello 🔒 Vault — encrypted! 日本語";
      const ciphertext = encryptText(text, key);
      expect(decryptText(ciphertext, key)).toBe(text);
    });
  });

  describe("encryptBuffer / decryptBuffer", () => {
    test("round-trips buffer correctly", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const original = Buffer.from("binary data here \x00\x01\x02");
      const encrypted = encryptBuffer(original, key);
      expect(encrypted).not.toEqual(original);
      const decrypted = decryptBuffer(encrypted, key);
      expect(decrypted).toEqual(original);
    });

    test("handles empty buffer", async () => {
      const key = await deriveEncryptionKey(testPin, testSalt);
      const encrypted = encryptBuffer(Buffer.alloc(0), key);
      expect(decryptBuffer(encrypted, key)).toEqual(Buffer.alloc(0));
    });
  });

  describe("hashPin / verifyPin", () => {
    test("verifies correct pin", async () => {
      const { hash, salt } = await hashPin(testPin);
      expect(hash).toBeTruthy();
      expect(salt).toBeTruthy();
      const valid = await verifyPin(testPin, hash, salt);
      expect(valid).toBe(true);
    });

    test("rejects wrong pin", async () => {
      const { hash, salt } = await hashPin(testPin);
      const valid = await verifyPin("wrong-pin", hash, salt);
      expect(valid).toBe(false);
    });
  });

  describe("createVaultToken / verifyVaultToken", () => {
    test("round-trips token data", () => {
      const key = Buffer.alloc(32, 1);
      const token = createVaultToken(
        { userId: "user-1", encryptionKey: key },
        testSecret,
        5,
      );
      const result = verifyVaultToken(token, testSecret);
      expect(result.userId).toBe("user-1");
      expect(Buffer.from(result.encryptionKey)).toEqual(key);
    });

    test("rejects tampered token", () => {
      const key = Buffer.alloc(32, 1);
      const token = createVaultToken(
        { userId: "user-1", encryptionKey: key },
        testSecret,
        5,
      );
      const tampered = token.slice(0, -1) + "X";
      expect(() => verifyVaultToken(tampered, testSecret)).toThrow();
    });

    test("rejects expired token", () => {
      const key = Buffer.alloc(32, 1);
      const token = createVaultToken(
        { userId: "user-1", encryptionKey: key },
        testSecret,
        -1,
      );
      expect(() => verifyVaultToken(token, testSecret)).toThrow();
    });
  });
});
