const crypto = require("node:crypto");

const PBKDF2_ITERATIONS = 180_000;

function makePasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function hashPassword(password, saltHex) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), PBKDF2_ITERATIONS, 32, "sha256").toString("hex");
}

function verifyPassword(password, saltHex, expectedHash) {
  const actual = hashPassword(password, saltHex);
  return timingSafeEqualText(actual, expectedHash);
}

function newSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function timingSafeEqualText(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  makePasswordRecord,
  verifyPassword,
  newSessionToken,
  timingSafeEqualText,
};
