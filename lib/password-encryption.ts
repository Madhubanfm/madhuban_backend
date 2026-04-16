import crypto from "node:crypto";

const VERSION_PREFIX = "v1";

function getEncryptionKey(): Buffer {
  const raw = process.env.PASSWORD_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("PASSWORD_ENCRYPTION_KEY is not configured.");
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error("PASSWORD_ENCRYPTION_KEY must be base64.");
  }

  if (key.length !== 32) {
    throw new Error("PASSWORD_ENCRYPTION_KEY must decode to 32 bytes (AES-256 key).");
  }

  return key;
}

export function encryptPassword(plain: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // recommended for GCM

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION_PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}

export function decryptPassword(payload: string): string {
  const [version, ivB64, tagB64, ciphertextB64] = payload.split(":");
  if (version !== VERSION_PREFIX || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Invalid encrypted password payload.");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plain.toString("utf8");
}
