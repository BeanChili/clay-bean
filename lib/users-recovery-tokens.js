// Account recovery tokens.
//
// A recovery token is a 32-byte random secret that only ever travels inside the
// email we send to the account's own address. Only its SHA-256 hash is written
// to users.json, next to the invites, so an administrator who reads the file
// (or a backup of it) still cannot act as the account holder.
var crypto = require("crypto");

var TOKEN_BYTES = 32;
// Keep in sync with the "expires in 30 minutes" wording in smtp.sendRecoveryEmail.
var EXPIRY_MS = 30 * 60 * 1000;
var MAX_TOKENS = 200;
// 32 random bytes encoded as base64url: 43 URL-safe characters, no padding.
var TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
var HASH_PATTERN = /^[a-f0-9]{64}$/;

function digest(token) {
  return crypto.createHash("sha256").update(String(token)).digest();
}

function entries(data) {
  if (!Array.isArray(data.recoveryTokens)) return [];
  return data.recoveryTokens.filter(function (entry) {
    return !!entry && typeof entry.userId === "string" && typeof entry.tokenHash === "string" &&
      HASH_PATTERN.test(entry.tokenHash) && Number.isFinite(entry.expiresAt);
  });
}

// Drops every outstanding token for one account from an already-loaded state,
// so a caller can revoke them in the same write as the change that caused it.
function withoutUserTokens(data, userId) {
  data.recoveryTokens = entries(data).filter(function (entry) { return entry.userId !== userId; });
  return data;
}

function attachRecoveryTokens(deps) {
  var loadUsers = deps.loadUsers;
  var saveUsers = deps.saveUsers;

  function live(list, now) {
    return list.filter(function (entry) { return entry.expiresAt > now; });
  }

  // Compares every candidate without an early exit so a near-miss cannot be
  // distinguished from a miss by timing.
  function locate(list, token) {
    var candidate = digest(token);
    var found = null;
    for (var i = 0; i < list.length; i++) {
      var stored = Buffer.from(list[i].tokenHash, "hex");
      var equal = stored.length === candidate.length && crypto.timingSafeEqual(candidate, stored);
      if (equal && !found) found = list[i];
    }
    return found;
  }

  // Issues a fresh token for one account. Any previous token for that account
  // stops working immediately, so a stolen older email is useless.
  function issueRecoveryToken(userId) {
    if (typeof userId !== "string" || !userId) return { error: "A valid account is required" };
    var now = Date.now();
    var token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    var data = loadUsers();
    var kept = live(entries(data), now).filter(function (entry) { return entry.userId !== userId; });
    if (kept.length >= MAX_TOKENS) kept = kept.slice(kept.length - (MAX_TOKENS - 1));
    kept.push({
      userId: userId,
      tokenHash: digest(token).toString("hex"),
      createdAt: now,
      expiresAt: now + EXPIRY_MS,
      used: false,
    });
    data.recoveryTokens = kept;
    saveUsers(data);
    return { ok: true, token: token, expiresAt: now + EXPIRY_MS, expiresInMinutes: Math.round(EXPIRY_MS / 60000) };
  }

  // Read-only check used to decide whether to render the redeem form.
  function peekRecoveryToken(token) {
    if (!TOKEN_PATTERN.test(String(token == null ? "" : token))) return null;
    var now = Date.now();
    var entry = locate(live(entries(loadUsers()), now), token);
    if (!entry || entry.used) return null;
    return { userId: entry.userId, expiresAt: entry.expiresAt };
  }

  // Single use: marks the token spent and persists that before the caller sets
  // a credential, so two concurrent redemptions cannot both succeed.
  function consumeRecoveryToken(token) {
    if (!TOKEN_PATTERN.test(String(token == null ? "" : token))) return null;
    var now = Date.now();
    var data = loadUsers();
    var list = entries(data);
    var entry = locate(list, token);
    if (!entry || entry.used || entry.expiresAt <= now) return null;
    entry.used = true;
    entry.usedAt = now;
    data.recoveryTokens = live(list, now);
    saveUsers(data);
    return { userId: entry.userId };
  }

  function getRecoveryTokens() {
    return entries(loadUsers());
  }

  // Outstanding links stop working, used when the account's address changes.
  function revokeRecoveryTokens(userId) {
    if (typeof userId !== "string" || !userId) return { error: "A valid account is required" };
    var data = loadUsers();
    var before = entries(data).length;
    withoutUserTokens(data, userId);
    if (data.recoveryTokens.length === before) return { ok: true, revoked: 0 };
    saveUsers(data);
    return { ok: true, revoked: before - data.recoveryTokens.length };
  }

  return {
    issueRecoveryToken: issueRecoveryToken,
    peekRecoveryToken: peekRecoveryToken,
    consumeRecoveryToken: consumeRecoveryToken,
    getRecoveryTokens: getRecoveryTokens,
    revokeRecoveryTokens: revokeRecoveryTokens,
  };
}

module.exports = {
  attachRecoveryTokens: attachRecoveryTokens,
  withoutUserTokens: withoutUserTokens,
  EXPIRY_MS: EXPIRY_MS,
};
