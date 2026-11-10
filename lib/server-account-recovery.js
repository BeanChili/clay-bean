// Self-service account recovery by email.
//
// Design constraints kept from a790ad33: an administrator never learns or sets
// another account's credential. The administrator can only ask Clay to email a
// recovery link to the address already on the account; the token itself lives
// only in that email, and only its hash is stored.
var passwords = require("./account-passwords");
var recoveryPage = require("./account-recovery-page");
var normalizeAllowedOrigins = require("./network-origins").normalizeAllowedOrigins;

// One answer for "no such account", "account without an email" and "mail sent",
// so the form cannot be used to discover who has an account here.
var GENERIC_REQUEST_MESSAGE =
  "If that account exists and has an email address, a recovery link is on its way. The link expires in 30 minutes.";
var GENERIC_TOKEN_ERROR =
  "This recovery link is invalid or has expired. Request a new one from the sign-in page.";

function statusError(status, message) {
  var error = new Error(message);
  error.status = status;
  return error;
}

function maskEmail(email) {
  var value = String(email || "");
  var at = value.lastIndexOf("@");
  if (at <= 0) return "•••";
  var local = value.slice(0, at);
  var domain = value.slice(at);
  if (local.length <= 2) return local.slice(0, 1) + "•••" + domain;
  return local.slice(0, 1) + "•••" + local.slice(-1) + domain;
}

function attachAccountRecovery(ctx) {
  var users = ctx.users;

  function smtpReady() {
    return !!(ctx.smtp && typeof ctx.smtp.isSmtpConfigured === "function" && ctx.smtp.isSmtpConfigured());
  }
  function normalize(value) {
    try { return normalizeAllowedOrigins([value])[0] || null; } catch (error) { return null; }
  }
  // The address a recovery link may point at, from configuration only. An
  // unauthenticated caller must never be able to steer the link with a Host
  // header: the emailed token would land on the attacker's server.
  function trustedOrigin() {
    var settings = users.loadUsers().accountTransport;
    var configured = settings && settings.origin && normalize(settings.origin);
    if (configured) return configured;
    var allowed = ctx.getAllowedOrigins ? ctx.getAllowedOrigins() : null;
    var list = Array.isArray(allowed) ? allowed : [];
    for (var i = 0; i < list.length; i++) {
      var origin = normalize(list[i]);
      if (origin) return origin;
    }
    return null;
  }
  // Self-service recovery needs accounts to recover, a way to reach them, and a
  // configured address to send them to.
  function available() {
    return !!(users.isMultiUser() && !users.getSoloNoPinUser() && smtpReady() && trustedOrigin());
  }
  function passwordMode() {
    return !!(ctx.policy && ctx.policy.enabled());
  }

  // Issues a token and mails it. Resolves with nothing useful on purpose: no
  // caller may see the token. The origin is decided by the caller, never by the
  // request that triggered it.
  function deliver(user, origin) {
    if (!origin) return Promise.reject(statusError(400, "Clay does not know its own public address. Set the account address in Access & security, or an allowed origin in network settings, before sending recovery links."));
    var issued;
    // A storage failure must surface as a plain retry message, never as a raw
    // filesystem error echoed back to a caller.
    try { issued = users.issueRecoveryToken(user.id); } catch (error) { issued = null; }
    if (!issued || !issued.ok) return Promise.reject(statusError(503, "Could not start account recovery. Please retry."));
    return Promise.resolve(ctx.smtp.sendRecoveryEmail(
      user.email, origin + "/recover-account/" + issued.token, user.displayName || user.username
    )).then(function () { return { ok: true }; });
  }

  // Used by the admin Users page. Rejects with a user-facing reason; never with
  // anything derived from the token.
  function sendForUser(user, req) {
    if (!users.isMultiUser()) return Promise.reject(statusError(404, "Not found"));
    if (!smtpReady()) {
      return Promise.reject(statusError(400, "SMTP is not configured, so Clay cannot send a recovery email. Configure SMTP in Email settings first."));
    }
    if (!user) return Promise.reject(statusError(404, "User not found"));
    if (!user.email) {
      return Promise.reject(statusError(400, "This account has no email address on file, so it cannot receive a recovery link."));
    }
    // An administrator is already authenticated, so their own request origin is
    // an acceptable fallback — but only the normalized one, which honors the
    // configured trusted proxies instead of a raw Host header.
    var origin = trustedOrigin() || (ctx.transport ? ctx.transport.info(req).origin : "") || null;
    return deliver(user, origin).then(function () {
      return { ok: true, email: maskEmail(user.email) };
    }, function (error) {
      if (error && (error.status === 503 || error.status === 400)) throw error;
      throw statusError(502, "Clay could not send the recovery email. Check the SMTP settings and try again.");
    });
  }

  function requestRecovery(req, res) {
    if (!available()) {
      ctx.http.reply(res, 400, { error: "Account recovery by email is not available on this server." });
      return;
    }
    ctx.http.read(req, res, function (data) {
      var identifier = typeof data.identifier === "string" ? data.identifier.trim() : "";
      // A shape complaint is independent of whether any account matches.
      if (!identifier || identifier.length > 200) throw new Error("Enter your username or email address.");
      ctx.http.throttle(req, "recover:" + identifier.toLowerCase().slice(0, 100));
      // Answer before doing any account work so the reply is identical in
      // content and in timing whether or not the account exists.
      ctx.http.reply(res, 200, { ok: true, message: GENERIC_REQUEST_MESSAGE });
      try {
        var user = users.findUserByUsername(identifier) || users.findUserByEmail(identifier);
        if (!user || !user.email) return;
        // Configured origin only: this endpoint is unauthenticated.
        deliver(user, trustedOrigin()).catch(function (error) {
          console.error("[account-recovery] Could not deliver a recovery email: " + ((error && error.message) || "unknown error"));
        });
      } catch (error) {
        console.error("[account-recovery] Recovery request failed: " + ((error && error.message) || "unknown error"));
      }
    });
  }

  // Storage failures answer with a retry message instead of a raw disk error.
  function persist(action) {
    try { return action(); } catch (error) {
      throw statusError(503, "Could not save your new credential. Request a new recovery link.");
    }
  }

  function redeem(req, res, token) {
    ctx.http.read(req, res, async function (data) {
      // Bounded work per address: the password path runs scrypt.
      ctx.http.throttle(req);
      var peeked = users.peekRecoveryToken(token);
      var user = peeked && users.findUserById(peeked.userId);
      if (!user) throw new Error(GENERIC_TOKEN_ERROR);
      var consumed;
      if (passwordMode()) {
        if (data.password !== data.confirmPassword) throw new Error("Passwords do not match.");
        // Same validation and hashing as the account password flow.
        var hash = await passwords.hash(data.password);
        consumed = persist(function () { return users.consumeRecoveryToken(token); });
        if (!consumed) throw new Error(GENERIC_TOKEN_ERROR);
        var state = users.loadUsers();
        var current = state.users.find(function (entry) { return entry.id === consumed.userId; });
        if (!current) throw new Error(GENERIC_TOKEN_ERROR);
        current.passwordHash = hash;
        current.pinHash = null;
        current.mustChangePin = false;
        persist(function () { users.saveUsers(state); });
      } else {
        if (typeof data.pin !== "string" || !/^\d{6}$/.test(data.pin)) throw new Error("PIN must be exactly 6 digits.");
        if (data.pin !== data.confirmPin) throw new Error("PINs do not match.");
        consumed = persist(function () { return users.consumeRecoveryToken(token); });
        if (!consumed) throw new Error(GENERIC_TOKEN_ERROR);
        // updateUserPin hashes the PIN and clears mustChangePin.
        var updated = persist(function () { return users.updateUserPin(consumed.userId, data.pin); });
        if (!updated || updated.error) throw statusError(503, "Could not save your new credential. Request a new recovery link.");
      }
      // Recovery proves control of the mailbox, not of the old credential: every
      // existing session and token for the account is dropped, and the browser
      // is sent to the sign-in page instead of being signed in here.
      try {
        ctx.revokeSessions(consumed.userId);
      } catch (error) {
        // The credential already changed; say so rather than implying a failure.
        throw statusError(503, "Your new credential was saved, but existing sessions could not be signed out. Sign in and review your active sessions.");
      }
      ctx.http.reply(res, 200, { ok: true, signIn: "/" });
    });
  }

  function handleRequest(req, res, url) {
    if (url === "/auth/recover-account") {
      if (req.method !== "POST") {
        ctx.http.reply(res, 405, { error: "Method not allowed." });
        return true;
      }
      requestRecovery(req, res);
      return true;
    }
    var route = /^\/recover-account\/([^/?#]+)$/.exec(url);
    if (!route) return false;
    if (!users.isMultiUser()) {
      res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      res.end("Not found");
      return true;
    }
    var token = route[1];
    if (req.method === "GET") {
      var peeked = users.peekRecoveryToken(token);
      var valid = !!(peeked && users.findUserById(peeked.userId));
      res.writeHead(valid ? 200 : 400, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        // Tighter than the application default: this page needs nothing but its
        // own inline form, and the token in its URL must not leak outward.
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(valid ? recoveryPage.render({ password: passwordMode() }) : recoveryPage.renderInvalid(GENERIC_TOKEN_ERROR));
      return true;
    }
    if (req.method === "POST") {
      redeem(req, res, token);
      return true;
    }
    ctx.http.reply(res, 405, { error: "Method not allowed." });
    return true;
  }

  return {
    handleRequest: handleRequest,
    available: available,
    sendForUser: sendForUser,
    maskEmail: maskEmail,
  };
}

module.exports = { attachAccountRecovery: attachAccountRecovery, maskEmail: maskEmail };
