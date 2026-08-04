import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const HASH_SCHEME = "scrypt";
const KEY_BYTES = 64;

function asPassword(value) {
  return String(value ?? "");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(asPassword(left));
  const rightBuffer = Buffer.from(asPassword(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function isPasswordHash(value) {
  return asPassword(value).startsWith(`${HASH_SCHEME}$`);
}

export function hashPassword(value) {
  const password = asPassword(value);
  if (!password) throw new Error("Password cannot be empty.");
  if (isPasswordHash(password)) return password;

  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, KEY_BYTES).toString("hex");
  return `${HASH_SCHEME}$${salt}$${derivedKey}`;
}

export function verifyPassword(value, storedValue) {
  const password = asPassword(value);
  const stored = asPassword(storedValue);
  if (!password || !stored) return false;

  if (!isPasswordHash(stored)) {
    return safeEqual(password, stored);
  }

  const [scheme, salt, encodedKey] = stored.split("$");
  if (scheme !== HASH_SCHEME || !salt || !encodedKey) return false;

  try {
    const expectedKey = Buffer.from(encodedKey, "hex");
    const actualKey = scryptSync(password, salt, expectedKey.length);
    return expectedKey.length === actualKey.length && timingSafeEqual(expectedKey, actualKey);
  } catch {
    return false;
  }
}

export function upgradePasswordHash(account, verifiedPassword) {
  if (!account || isPasswordHash(account.password)) return false;
  account.password = hashPassword(verifiedPassword);
  return true;
}
