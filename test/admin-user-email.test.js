var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var EventEmitter = require('node:events');
var fixture = require('./helpers/account-auth-fixture');

function request(handler, method, url, data, cookie) {
  return new Promise(function (resolve) {
    var req = new EventEmitter();
    req.method = method; req.url = url;
    req.headers = { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', cookie: cookie || '' };
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
    if (method !== 'GET') { req.emit('data', JSON.stringify(data === undefined ? {} : data)); req.emit('end'); }
  });
}

function setup(t) {
  var h = fixture.isolated(t);
  fs.writeFileSync(path.join(h.root, 'users.json'), JSON.stringify({
    multiUser: true,
    users: [
      { id: 'enzo', username: 'enzo', displayName: 'Enzo', role: 'admin', email: 'enzo@example.invalid', pinHash: h.users.hashPin('012345') },
      { id: 'laucha', username: 'lautaro.musacchio', displayName: 'Laucha', role: 'admin', email: 'wrong@example.invalid', pinHash: h.users.hashPin('112233') },
      { id: 'member', username: 'Member', displayName: 'Member Person', role: 'user', email: 'member@example.invalid', pinHash: h.users.hashPin('223344') },
      { id: 'nomail', username: 'Nomail', displayName: 'No Mail', role: 'user', email: null, pinHash: h.users.hashPin('334455') },
    ],
    invites: [],
  }));
  var state = { sent: [], changed: [], configured: true, fail: false, origins: ['https://clay.example.invalid'] };
  var smtp = {
    isEmailLoginEnabled: function () { return false; },
    isSmtpConfigured: function () { return state.configured !== false; },
    sendRecoveryEmail: function (email, url, displayName) {
      state.sent.push({ email: email, url: url, displayName: displayName });
      return Promise.resolve({ messageId: 'fixture' });
    },
    sendEmailChangedEmail: function (email, displayName) {
      if (state.fail) return Promise.reject(new Error('mailbox unavailable'));
      state.changed.push({ email: email, displayName: displayName });
      return Promise.resolve({ messageId: 'fixture' });
    },
  };
  var server = h.server({ smtp: smtp, getAllowedOrigins: function () { return state.origins; } });
  var removed = [];
  var api = h.load('server-admin').attachAdmin({
    users: h.users,
    smtp: smtp,
    getMultiUserFromReq: server.getMultiUserFromReq,
    projects: new Map(),
    tlsOptions: null,
    revokeUserTokens: function (id) { removed.push(id); server.revokeUserTokens(id); },
    sendRecoveryEmail: server.sendRecoveryEmail,
  });
  return {
    h: h, state: state, smtp: smtp, server: server, api: api, removed: removed,
    enzo: server.createMultiUserSession('enzo').cookie,
    laucha: server.createMultiUserSession('laucha').cookie,
    member: server.createMultiUserSession('member').cookie,
  };
}

// --- Email changes ---

test('only an administrator can change an account email', async function (t) {
  var f = setup(t);
  assert.equal((await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'new@example.invalid' }, f.member)).code, 403);
  assert.equal((await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'new@example.invalid' })).code, 403);
  assert.equal(f.h.users.findUserById('laucha').email, 'wrong@example.invalid');
  assert.equal(f.state.changed.length, 0);
  assert.equal((await request(f.api, 'PUT', '/api/admin/users/ghost/email', { email: 'new@example.invalid' }, f.enzo)).code, 404);
});

test('a changed email is validated, unique, and notified to the previous address', async function (t) {
  var f = setup(t);
  var invalid = await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'not-an-email' }, f.enzo);
  assert.equal(invalid.code, 400);
  assert.match(invalid.body.error, /valid email address/);
  assert.equal((await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'a@' + 'x'.repeat(250) + '.com' }, f.enzo)).code, 400);

  // Another account already owns that address.
  var duplicate = await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'MEMBER@example.invalid' }, f.enzo);
  assert.equal(duplicate.code, 409);
  assert.match(duplicate.body.error, /already registered/);
  assert.equal(f.h.users.findUserById('laucha').email, 'wrong@example.invalid');
  assert.equal(f.state.changed.length, 0);

  var changed = await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: '  lautaro@example.invalid  ' }, f.enzo);
  assert.equal(changed.code, 200);
  assert.deepEqual(changed.body, { ok: true, email: 'lautaro@example.invalid', changed: true, oldEmailNotified: true });
  assert.equal(f.h.users.findUserById('laucha').email, 'lautaro@example.invalid');
  // The warning goes to the address that was just removed, with no secrets.
  assert.deepEqual(f.state.changed, [{ email: 'wrong@example.invalid', displayName: 'Laucha' }]);
  assert.doesNotMatch(changed.raw, /pin|password|token/i);
  // Unrelated accounts are untouched, and the account keeps its credential.
  assert.equal(f.h.users.findUserById('member').email, 'member@example.invalid');
  assert.equal(f.h.users.authenticateUser('lautaro.musacchio', '112233').id, 'laucha');

  // Re-saving the same address changes nothing and notifies nobody.
  var again = await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'lautaro@example.invalid' }, f.enzo);
  assert.equal(again.code, 200);
  assert.equal(again.body.changed, false);
  assert.equal(again.body.oldEmailNotified, false);
  assert.equal(f.state.changed.length, 1);
});

test('changing the email cancels recovery links already sent to the old address', async function (t) {
  var f = setup(t);
  assert.equal((await request(f.api, 'POST', '/api/admin/users/laucha/recovery-email', {}, f.enzo)).code, 200);
  var link = f.state.sent[0].url;
  var token = link.substring(link.lastIndexOf('/') + 1);
  assert.equal(f.state.sent[0].email, 'wrong@example.invalid');
  assert.equal(f.h.users.peekRecoveryToken(token).userId, 'laucha');

  assert.equal((await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'lautaro@example.invalid' }, f.enzo)).code, 200);
  // The link mailed to the wrong address must not outlive it.
  assert.equal(f.h.users.peekRecoveryToken(token), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.h.root, 'users.json'), 'utf8')).recoveryTokens.length, 0);
  assert.equal((await request(f.server, 'POST', '/recover-account/' + token, { pin: '654321', confirmPin: '654321' })).code, 400);
  assert.equal(f.h.users.authenticateUser('lautaro.musacchio', '112233').id, 'laucha');

  // A fresh link goes to the corrected address and works.
  assert.equal((await request(f.api, 'POST', '/api/admin/users/laucha/recovery-email', {}, f.enzo)).code, 200);
  assert.equal(f.state.sent[1].email, 'lautaro@example.invalid');
  var next = f.state.sent[1].url.substring(f.state.sent[1].url.lastIndexOf('/') + 1);
  assert.equal((await request(f.server, 'POST', '/recover-account/' + next, { pin: '654321', confirmPin: '654321' })).code, 200);
  assert.equal(f.h.users.authenticateUser('lautaro.musacchio', '654321').id, 'laucha');
});

test('an email can be cleared, and clearing it disables recovery for that account', async function (t) {
  var f = setup(t);
  var cleared = await request(f.api, 'PUT', '/api/admin/users/member/email', { email: '' }, f.enzo);
  assert.equal(cleared.code, 200);
  assert.equal(cleared.body.email, null);
  assert.equal(cleared.body.changed, true);
  assert.equal(f.h.users.findUserById('member').email, null);
  assert.deepEqual(f.state.changed, [{ email: 'member@example.invalid', displayName: 'Member Person' }]);
  var refused = await request(f.api, 'POST', '/api/admin/users/member/recovery-email', {}, f.enzo);
  assert.equal(refused.code, 400);
  assert.match(refused.body.error, /no email address/);

  // An account that never had one can be given one, with nobody to notify.
  var added = await request(f.api, 'PUT', '/api/admin/users/nomail/email', { email: 'nomail@example.invalid' }, f.enzo);
  assert.equal(added.code, 200);
  assert.equal(added.body.oldEmailNotified, false);
  assert.equal(f.state.changed.length, 1);
  // The address the cleared account released can be reused.
  assert.equal((await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'member@example.invalid' }, f.enzo)).code, 200);
});

test('a failed or unavailable notification still applies the change and says so', async function (t) {
  var f = setup(t);
  f.state.fail = true;
  var failed = await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'lautaro@example.invalid' }, f.enzo);
  assert.equal(failed.code, 200);
  assert.equal(failed.body.ok, true);
  assert.equal(failed.body.oldEmailNotified, false);
  assert.equal(f.h.users.findUserById('laucha').email, 'lautaro@example.invalid');
  assert.doesNotMatch(failed.raw, /mailbox unavailable/);

  f.state.fail = false;
  f.state.configured = false;
  var noSmtp = await request(f.api, 'PUT', '/api/admin/users/laucha/email', { email: 'laucha@example.invalid' }, f.enzo);
  assert.equal(noSmtp.code, 200);
  assert.equal(noSmtp.body.oldEmailNotified, false);
  assert.equal(f.h.users.findUserById('laucha').email, 'laucha@example.invalid');
  assert.equal(f.state.changed.length, 0);
});

// --- Administrator deletion ---

test('an administrator can remove another administrator but never themselves', async function (t) {
  var f = setup(t);
  var self = await request(f.api, 'DELETE', '/api/admin/users/enzo', undefined, f.enzo);
  assert.equal(self.code, 400);
  assert.match(self.body.error, /yourself/);
  assert.ok(f.h.users.findUserById('enzo'));

  assert.equal((await request(f.api, 'DELETE', '/api/admin/users/laucha', undefined, f.member)).code, 403);
  assert.ok(f.h.users.findUserById('laucha'));

  var removed = await request(f.api, 'DELETE', '/api/admin/users/laucha', undefined, f.enzo);
  assert.equal(removed.code, 200);
  assert.equal(removed.body.ok, true);
  assert.equal(f.h.users.findUserById('laucha'), null);
  // Their sessions go with them.
  assert.deepEqual(f.removed, ['laucha']);
  assert.equal(f.server.getMultiUserFromReq({ headers: { host: 'localhost', cookie: f.laucha }, socket: { remoteAddress: '127.0.0.1' } }), null);
  assert.equal((await request(f.api, 'DELETE', '/api/admin/users/laucha', undefined, f.enzo)).code, 404);
});

test('the last administrator can never be removed', async function (t) {
  var f = setup(t);
  assert.equal((await request(f.api, 'DELETE', '/api/admin/users/laucha', undefined, f.enzo)).code, 200);
  // Enzo is now the only administrator. The endpoint refuses self-removal
  // first, so the guard is reached directly, as a last line of defence.
  var refused = f.h.users.removeUser('enzo');
  assert.match(refused.error, /last administrator/);
  assert.ok(f.h.users.findUserById('enzo'));
  assert.equal(f.h.users.getAllUsers().length, 3);
  // Ordinary accounts are still removable while one administrator remains.
  assert.equal(f.h.users.removeUser('nomail').ok, true);
  assert.equal(f.h.users.findUserById('nomail'), null);
  // A second administrator restores the ability to remove the first.
  f.h.users.updateUserPermissions('member', {});
  var state = f.h.users.loadUsers();
  state.users.find(function (entry) { return entry.id === 'member'; }).role = 'admin';
  f.h.users.saveUsers(state);
  assert.equal(f.h.users.removeUser('enzo').ok, true);
});
