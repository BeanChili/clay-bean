var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var fs = require('node:fs');
var path = require('node:path');
var EventEmitter = require('node:events');
var fixture = require('./helpers/account-auth-fixture');

function request(handler, method, url, data, cookie, headers) {
  return new Promise(function (resolve) {
    var req = new EventEmitter();
    req.method = method; req.url = url;
    req.headers = Object.assign({ host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', cookie: cookie || '' }, headers || {});
    req.socket = { remoteAddress: '127.0.0.1' };
    var result = {};
    var res = {
      writeHead: function (code, headers) { result.code = code; result.headers = headers || {}; },
      end: function (body) {
        result.raw = body === undefined ? '' : String(body);
        try { result.body = JSON.parse(result.raw); } catch (error) { result.body = null; }
        resolve(result);
      },
    };
    assert.equal(handler.handleRequest(req, res, url), true);
    if (method !== 'GET') { req.emit('data', JSON.stringify(data || {})); req.emit('end'); }
  });
}

function smtpStub(state) {
  return {
    isEmailLoginEnabled: function () { return false; },
    isSmtpConfigured: function () { return state.configured !== false; },
    sendRecoveryEmail: function (email, url, displayName) {
      if (state.fail) return Promise.reject(new Error('relay refused'));
      state.sent.push({ email: email, url: url, displayName: displayName });
      return Promise.resolve({ messageId: 'fixture' });
    },
  };
}

function setup(t) {
  var h = fixture.isolated(t);
  fs.writeFileSync(path.join(h.root, 'users.json'), JSON.stringify({
    multiUser: true,
    users: [
      { id: 'admin', username: 'Admin', displayName: 'Admin Person', role: 'admin', email: 'admin@example.invalid', pinHash: h.users.hashPin('012345') },
      { id: 'member', username: 'Member', displayName: 'Member Person', role: 'user', email: 'member@example.invalid', pinHash: h.users.hashPin('112233'), mustChangePin: true },
      { id: 'nomail', username: 'Nomail', displayName: 'No Mail', role: 'user', email: null, pinHash: h.users.hashPin('223344') },
    ],
    invites: [],
  }));
  // Recovery links may only point at a configured address, never at the Host
  // header of whoever asked for them.
  var state = { sent: [], configured: true, fail: false, origins: ['https://clay.example.invalid'] };
  var smtp = smtpStub(state);
  var options = { smtp: smtp, getAllowedOrigins: function () { return state.origins; } };
  var server = h.server(options);
  return {
    h: h, state: state, smtp: smtp, server: server, options: options,
    restart: function () { return h.server(options); },
    usersFile: path.join(h.root, 'users.json'),
  };
}

function tokenFrom(entry) {
  return entry.url.substring(entry.url.lastIndexOf('/') + 1);
}

function authed(server, cookie) {
  return server.isRequestAuthed({ headers: { host: 'localhost', cookie: cookie }, socket: { remoteAddress: '127.0.0.1' } });
}

test('a recovery request answers identically for unknown, email-less and real accounts', async function (t) {
  var f = setup(t);
  var unknown = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'ghost' });
  var withoutEmail = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'Nomail' });
  var byUsername = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  var byEmail = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'MEMBER@example.invalid' });
  [unknown, withoutEmail, byUsername, byEmail].forEach(function (result) {
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, unknown.body);
    assert.equal(result.headers['Set-Cookie'], undefined);
  });
  assert.match(unknown.body.message, /If that account exists/);
  // Only the real account with an address is mailed, and only its own address.
  assert.deepEqual(f.state.sent.map(function (entry) { return entry.email; }), ['member@example.invalid', 'member@example.invalid']);
  assert.equal(f.state.sent[0].displayName, 'Member Person');
  assert.match(f.state.sent[0].url, /^https:\/\/clay\.example\.invalid\/recover-account\/[A-Za-z0-9_-]{43}$/);
  // No account name, address or token may appear in the generic answer.
  assert.doesNotMatch(JSON.stringify(unknown.body), /member|Member|token/i);
  assert.equal(JSON.stringify(byUsername.body).includes(tokenFrom(f.state.sent[0])), false);
});

test('a recovery request is unavailable without SMTP and rate limited per address and account', async function (t) {
  var f = setup(t);
  f.state.configured = false;
  var off = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  assert.equal(off.code, 400);
  assert.match(off.body.error, /not available/);
  assert.equal(f.state.sent.length, 0);
  f.state.configured = true;
  assert.equal((await request(f.server, 'POST', '/auth/recover-account', { identifier: '' })).code, 400);
  // The shared sign-in throttle caps repeats for one identifier at ten.
  for (var i = 0; i < 10; i++) await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  var limited = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'Member' });
  assert.equal(limited.code, 429);
  assert.match(limited.body.error, /Too many attempts/);
  assert.equal(f.state.sent.length, 10);
});

test('a self-service link always uses the configured address, never the request Host', async function (t) {
  var f = setup(t);
  // An unauthenticated caller tries to steer the emailed link at their server.
  var spoofed = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' }, '', {
    host: 'evil.example', origin: 'http://evil.example', 'x-forwarded-host': 'evil.example',
  });
  assert.equal(spoofed.code, 200);
  assert.equal(f.state.sent.length, 1);
  assert.match(f.state.sent[0].url, /^https:\/\/clay\.example\.invalid\/recover-account\//);
  assert.equal(f.state.sent[0].url.includes('evil.example'), false);

  // The account address configured in Access & security wins over the list.
  var stored = f.h.users.loadUsers();
  stored.accountTransport = { origin: 'https://accounts.example.invalid', trustedProxies: [] };
  f.h.users.saveUsers(stored);
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'Nomail' });
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'MEMBER@example.invalid' }, '', { host: 'evil.example' });
  assert.match(f.state.sent[1].url, /^https:\/\/accounts\.example\.invalid\/recover-account\//);
});

test('self-service recovery is unavailable until a public address is configured', async function (t) {
  var f = setup(t);
  f.state.origins = [];
  assert.match(f.server.getAuthPage(), /data-recovery="false"/);
  var blocked = await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  assert.equal(blocked.code, 400);
  assert.match(blocked.body.error, /not available/);
  assert.equal(f.state.sent.length, 0);
  // Unusable configuration entries do not count as an address either.
  f.state.origins = ['not-an-origin', 'https://clay.example.invalid/with/path'];
  assert.equal((await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' })).code, 400);
  assert.equal(f.state.sent.length, 0);
  f.state.origins = ['not-an-origin', 'https://clay.example.invalid'];
  assert.match(f.server.getAuthPage(), /data-recovery="true"/);
  assert.equal((await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' })).code, 200);
  assert.match(f.state.sent[0].url, /^https:\/\/clay\.example\.invalid\/recover-account\//);
});

test('only the token hash is stored, a newer token replaces the old one, and tokens expire', async function (t) {
  var f = setup(t);
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  var first = tokenFrom(f.state.sent[0]);
  var stored = JSON.parse(fs.readFileSync(f.usersFile, 'utf8'));
  assert.equal(stored.recoveryTokens.length, 1);
  assert.equal(stored.recoveryTokens[0].userId, 'member');
  assert.equal(stored.recoveryTokens[0].used, false);
  assert.equal(stored.recoveryTokens[0].tokenHash, crypto.createHash('sha256').update(first).digest('hex'));
  assert.equal(fs.readFileSync(f.usersFile, 'utf8').includes(first), false, 'the raw token never reaches disk');
  assert.equal(f.h.users.peekRecoveryToken(first).userId, 'member');

  // A new request invalidates the previous link for that account.
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  var second = tokenFrom(f.state.sent[1]);
  assert.notEqual(second, first);
  assert.equal(f.h.users.peekRecoveryToken(first), null);
  assert.equal(f.h.users.peekRecoveryToken(second).userId, 'member');
  assert.equal(JSON.parse(fs.readFileSync(f.usersFile, 'utf8')).recoveryTokens.length, 1);
  assert.equal((await request(f.server, 'GET', '/recover-account/' + first)).code, 400);
  assert.equal((await request(f.server, 'GET', '/recover-account/' + second)).code, 200);

  // Thirty minutes later the surviving token is gone too.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(30 * 60 * 1000 + 1);
  assert.equal(f.h.users.peekRecoveryToken(second), null);
  var expired = await request(f.server, 'GET', '/recover-account/' + second);
  assert.equal(expired.code, 400);
  assert.match(expired.raw, /invalid or has expired/);
  assert.equal((await request(f.server, 'POST', '/recover-account/' + second, { pin: '654321', confirmPin: '654321' })).code, 400);
  assert.equal(f.h.users.authenticateUser('Member', '112233').id, 'member');
});

test('redeeming in PIN mode sets the new PIN once, clears mustChangePin and revokes sessions', async function (t) {
  var f = setup(t);
  var session = f.server.createMultiUserSession('member').cookie;
  var other = f.server.createMultiUserSession('member').cookie;
  assert.equal(authed(f.server, session), true);
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  var token = tokenFrom(f.state.sent[0]);

  var page = await request(f.server, 'GET', '/recover-account/' + token);
  assert.equal(page.code, 200);
  assert.match(page.raw, /New PIN/);
  assert.doesNotMatch(page.raw, /New password/);

  assert.equal((await request(f.server, 'POST', '/recover-account/' + token, { pin: '12345', confirmPin: '12345' })).code, 400);
  assert.equal((await request(f.server, 'POST', '/recover-account/' + token, { pin: '654321', confirmPin: '654322' })).code, 400);
  var done = await request(f.server, 'POST', '/recover-account/' + token, { pin: '654321', confirmPin: '654321' });
  assert.equal(done.code, 200);
  assert.equal(done.body.ok, true);
  // Recovery never signs the browser in; it points at the sign-in page.
  assert.equal(done.headers['Set-Cookie'], undefined);
  assert.equal(done.body.signIn, '/');

  assert.equal(f.h.users.authenticateUser('Member', '112233'), null);
  assert.equal(f.h.users.authenticateUser('Member', '654321').id, 'member');
  assert.equal(f.h.users.findUserById('member').mustChangePin, false);
  assert.equal(authed(f.server, session), false);
  assert.equal(authed(f.server, other), false);
  assert.equal(authed(f.restart(), session), false, 'revocation survives a restart');

  // Single use: the same link cannot set another credential.
  var replay = await request(f.server, 'POST', '/recover-account/' + token, { pin: '000111', confirmPin: '000111' });
  assert.equal(replay.code, 400);
  assert.match(replay.body.error, /invalid or has expired/);
  assert.equal(f.h.users.authenticateUser('Member', '000111'), null);
  assert.equal(f.h.users.authenticateUser('Member', '654321').id, 'member');
  assert.equal(JSON.parse(fs.readFileSync(f.usersFile, 'utf8')).recoveryTokens[0].used, true);
  // The admin's untouched account keeps its own credential.
  assert.equal(f.h.users.authenticateUser('Admin', '012345').id, 'admin');
});

test('redeeming under the account password policy sets a password with the same rules', async function (t) {
  var f = setup(t);
  var adminCookie = f.server.createMultiUserSession('admin').cookie;
  assert.equal((await request(f.server, 'PUT', '/api/account-auth-policy', { method: 'password' }, adminCookie)).code, 200);
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member@example.invalid' });
  var token = tokenFrom(f.state.sent[0]);

  var page = await request(f.server, 'GET', '/recover-account/' + token);
  assert.equal(page.code, 200);
  assert.match(page.raw, /New password/);
  assert.doesNotMatch(page.raw, /New PIN/);

  var short = await request(f.server, 'POST', '/recover-account/' + token, { password: 'short', confirmPassword: 'short' });
  assert.equal(short.code, 400);
  assert.match(short.body.error, /15–128 characters/);
  var mismatch = await request(f.server, 'POST', '/recover-account/' + token, { password: 'a long enough passphrase', confirmPassword: 'another long passphrase' });
  assert.equal(mismatch.code, 400);
  assert.equal(f.h.users.findUserById('member').passwordHash, undefined);

  var phrase = 'a recovered fixture passphrase';
  var done = await request(f.server, 'POST', '/recover-account/' + token, { password: phrase, confirmPassword: phrase });
  assert.equal(done.code, 200);
  assert.equal(done.headers['Set-Cookie'], undefined);
  var recovered = f.h.users.findUserById('member');
  assert.match(recovered.passwordHash, /^password-scrypt-v1:/);
  assert.equal(recovered.pinHash, null);
  assert.equal(recovered.mustChangePin, false);
  assert.equal((await request(f.restart(), 'POST', '/auth/login', { username: 'Member', password: phrase })).code, 200);
  assert.equal((await request(f.server, 'POST', '/auth/login', { username: 'Member', password: 'not the recovered phrase' })).code, 400);
  assert.equal((await request(f.server, 'POST', '/recover-account/' + token, { password: phrase, confirmPassword: phrase })).code, 400);
});

test('a storage failure reports a retry instead of leaking disk errors or spending the link', async function (t) {
  var f = setup(t);
  await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' });
  var token = tokenFrom(f.state.sent[0]);
  f.h.state.failUsers = true;
  var failed = await request(f.server, 'POST', '/recover-account/' + token, { pin: '654321', confirmPin: '654321' });
  assert.equal(failed.code, 503);
  assert.match(failed.body.error, /Request a new recovery link/);
  assert.doesNotMatch(failed.raw, /users unavailable|ENOENT|\/tmp\//);
  f.h.state.failUsers = false;
  assert.equal(f.h.users.authenticateUser('Member', '112233').id, 'member');
  // The interrupted attempt did not spend the link.
  assert.equal((await request(f.server, 'POST', '/recover-account/' + token, { pin: '654321', confirmPin: '654321' })).code, 200);
  assert.equal(f.h.users.authenticateUser('Member', '654321').id, 'member');
});

function adminApi(f) {
  return f.h.load('server-admin').attachAdmin({
    users: f.h.users,
    smtp: f.smtp,
    getMultiUserFromReq: f.server.getMultiUserFromReq,
    projects: new Map(),
    tlsOptions: null,
    portNum: 2633,
    revokeUserTokens: f.server.revokeUserTokens,
    sendRecoveryEmail: f.server.sendRecoveryEmail,
  });
}

test('the admin recovery link prefers the configured address and otherwise uses the request origin', async function (t) {
  var f = setup(t);
  var api = adminApi(f);
  var adminCookie = f.server.createMultiUserSession('admin').cookie;

  assert.equal((await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie)).code, 200);
  assert.match(f.state.sent[0].url, /^https:\/\/clay\.example\.invalid\/recover-account\//);

  // Without a configured address an authenticated administrator may seed it
  // from their own session, through the normalized transport origin.
  f.state.origins = [];
  var fallback = await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie);
  assert.equal(fallback.code, 200);
  assert.match(f.state.sent[1].url, /^http:\/\/localhost\/recover-account\//);
  // Self-service stays closed while only the admin path can resolve an address.
  assert.equal((await request(f.server, 'POST', '/auth/recover-account', { identifier: 'member' })).code, 400);
  assert.equal(f.state.sent.length, 2);

  // An unusable Host leaves the administrator with a clear explanation.
  var unusable = await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie, { host: '' });
  assert.equal(unusable.code, 400);
  assert.match(unusable.body.error, /public address/);
  assert.equal(f.state.sent.length, 2);
});

test('the admin recovery endpoint mails the account and never exposes the token', async function (t) {
  var f = setup(t);
  var api = adminApi(f);
  var adminCookie = f.server.createMultiUserSession('admin').cookie;
  var memberCookie = f.server.createMultiUserSession('member').cookie;

  assert.equal((await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, memberCookie)).code, 403);
  assert.equal((await request(api, 'POST', '/api/admin/users/member/recovery-email', {})).code, 403);
  assert.equal(f.state.sent.length, 0);

  var sent = await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie);
  assert.equal(sent.code, 200);
  assert.equal(sent.body.ok, true);
  assert.equal(sent.body.email, 'm•••r@example.invalid');
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.sent[0].email, 'member@example.invalid');
  // The administrator is told who was mailed, never how to act as them.
  assert.equal(sent.raw.includes(tokenFrom(f.state.sent[0])), false);
  assert.doesNotMatch(sent.raw, /token|pin|password/i);

  var noEmail = await request(api, 'POST', '/api/admin/users/nomail/recovery-email', {}, adminCookie);
  assert.equal(noEmail.code, 400);
  assert.match(noEmail.body.error, /no email address/);
  assert.equal((await request(api, 'POST', '/api/admin/users/ghost/recovery-email', {}, adminCookie)).code, 404);

  f.state.configured = false;
  var withoutSmtp = await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie);
  assert.equal(withoutSmtp.code, 400);
  assert.match(withoutSmtp.body.error, /SMTP is not configured/);
  f.state.configured = true;
  f.state.fail = true;
  var failed = await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie);
  assert.equal(failed.code, 502);
  assert.match(failed.body.error, /could not send the recovery email/i);
  assert.doesNotMatch(failed.body.error, /relay refused/);

  // The link the administrator triggered is an ordinary single-use token.
  f.state.fail = false;
  await request(api, 'POST', '/api/admin/users/member/recovery-email', {}, adminCookie);
  var token = tokenFrom(f.state.sent[f.state.sent.length - 1]);
  assert.equal((await request(f.server, 'POST', '/recover-account/' + token, { pin: '654321', confirmPin: '654321' })).code, 200);
  assert.equal(f.h.users.authenticateUser('Member', '654321').id, 'member');
});

test('admins still cannot reset another account PIN through the legacy endpoint', async function (t) {
  var f = setup(t);
  var api = adminApi(f);
  var adminCookie = f.server.createMultiUserSession('admin').cookie;
  var denied = await request(api, 'POST', '/api/admin/users/member/reset-pin', {}, adminCookie);
  assert.equal(denied.code, 403);
  assert.match(denied.body.error, /cannot impersonate/);
  assert.equal(denied.body.tempPin, undefined);
  assert.equal(f.h.users.authenticateUser('Member', '112233').id, 'member');
  // Resetting your own account is unchanged.
  var self = await request(api, 'POST', '/api/admin/users/admin/reset-pin', {}, adminCookie);
  assert.equal(self.code, 200);
  assert.match(self.body.tempPin, /^\d{6}$/);
  assert.equal(f.h.users.findUserById('admin').mustChangePin, true);
});

test('the sign-in page offers recovery only when it can actually deliver mail', function (t) {
  var f = setup(t);
  assert.match(f.server.getAuthPage(), /data-recovery="true"/);
  assert.match(f.server.getAuthPage(), /Forgot your PIN or password\?/);
  f.state.configured = false;
  assert.match(f.server.getAuthPage(), /data-recovery="false"/);
});
