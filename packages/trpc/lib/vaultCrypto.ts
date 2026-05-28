import crypto from "crypto";

const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

export async function deriveEncryptionKey(
  pin: string,
  salt: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      pin,
      salt,
      PBKDF2_ITERATIONS,
      KEY_LENGTH,
      "sha256",
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

export function encryptText(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptText(ciphertext: string, key: Buffer): string {
  const data = Buffer.from(ciphertext, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function encryptBuffer(plainBuffer: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

export function decryptBuffer(encryptedBuffer: Buffer, key: Buffer): Buffer {
  const iv = encryptedBuffer.subarray(0, IV_LENGTH);
  const authTag = encryptedBuffer.subarray(
    IV_LENGTH,
    IV_LENGTH + AUTH_TAG_LENGTH,
  );
  const encrypted = encryptedBuffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

export async function hashPin(
  pin: string,
): Promise<{ hash: string; salt: string }> {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await new Promise<string>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, 64, "sha512", (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
  return { hash, salt };
}

export async function verifyPin(
  pin: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const hash = await new Promise<string>((resolve, reject) => {
    crypto.pbkdf2(pin, salt, PBKDF2_ITERATIONS, 64, "sha512", (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(storedHash, "hex"),
  );
}

export function generateSalt(): string {
  return crypto.randomBytes(32).toString("hex");
}

interface VaultTokenPayload {
  userId: string;
  encryptionKey: Buffer;
}

export function createVaultToken(
  payload: VaultTokenPayload,
  secret: string,
  autoLockMinutes: number,
): string {
  const data = {
    uid: payload.userId,
    key: payload.encryptionKey.toString("base64"),
    exp: Date.now() + autoLockMinutes * 60 * 1000,
  };
  const payloadStr = Buffer.from(JSON.stringify(data)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadStr)
    .digest("base64url");
  return `${payloadStr}.${signature}`;
}

export function verifyVaultToken(
  token: string,
  secret: string,
): { userId: string; encryptionKey: Buffer } {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) throw new Error("Invalid vault token format");

  const payloadStr = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadStr)
    .digest("base64url");

  if (
    !crypto.timingSafeEqual(
      Buffer.from(signature, "base64url"),
      Buffer.from(expectedSig, "base64url"),
    )
  ) {
    throw new Error("Invalid vault token signature");
  }

  const data = JSON.parse(Buffer.from(payloadStr, "base64url").toString());
  if (typeof data.exp !== "number" || data.exp < Date.now()) {
    throw new Error("Vault token expired");
  }

  return {
    userId: data.uid,
    encryptionKey: Buffer.from(data.key, "base64"),
  };
}
