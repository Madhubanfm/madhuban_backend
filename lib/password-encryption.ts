import crypto from "node:crypto";

const VERSION_PREFIX = "v1";

function getEncryptionKey(): Buffer {
  const raw = process.env.PASSWORD_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error("PASSWORD_ENCRYPTION_KEY is not configured.");
  }

  // Accept a few common encodings to reduce configuration footguns:
  // - base64 / base64url encoding of 32 bytes (recommended)
  // - 64-char hex encoding of 32 bytes
  // - raw 32-character string (treated as UTF-8 bytes)
  //
  // Note: Buffer.from(base64) does not reliably throw on invalid input, so we
  // validate by requiring the decoded size to be 32 bytes.
  const base64Normalized = raw.replace(/-/g, "+").replace(/_/g, "/");

  const base64Decoded = Buffer.from(base64Normalized, "base64");
  if (base64Decoded.length === 32) return base64Decoded;

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const hexDecoded = Buffer.from(raw, "hex");
    if (hexDecoded.length === 32) return hexDecoded;
  }

  const utf8Decoded = Buffer.from(raw, "utf8");
  if (utf8Decoded.length === 32) return utf8Decoded;

  throw new Error(
    [
      "PASSWORD_ENCRYPTION_KEY must be a 32-byte AES-256 key.",
      "Provide one of:",
      "- base64/base64url for 32 bytes (recommended)",
      "- 64-char hex for 32 bytes",
      "- a raw 32-character string",
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
    ].join("\n")
  );
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
