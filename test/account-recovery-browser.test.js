var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var http = require('node:http');
var path = require('node:path');
var playwright = require('playwright');
var fixture = require('./helpers/account-auth-fixture');

// Drives the real sign-in page, the real recovery endpoints and the real redeem
// page in a browser, end to end, against the production request handler.
async function boot(t) {
  var h = fixture.isolated(t);
  fs.writeFileSync(path.join(h.root, 'users.json'), JSON.stringify({
    multiUser: true,
    users: [
      { id: 'admin', username: 'Admin', displayName: 'Admin Person', role: 'admin', email: 'admin@example.invalid', pinHash: h.users.hashPin('012345') },
      { id: 'member', username: 'Member', displayName: 'Member Person', role: 'user', email: 'member@example.invalid', pinHash: h.users.hashPin('112233') },
    ],
    invites: [],
  }));
  var state = { sent: [], origins: [] };
  var auth = h.server({
    // Links point at the configured address, resolved when the fixture listens.
    getAllowedOrigins: function () { return state.origins; },
    smtp: {
      isEmailLoginEnabled: function () { return false; },
      isSmtpConfigured: function () { return true; },
      sendRecoveryEmail: function (email, url, displayName) {
        state.sent.push({ email: email, url: url, displayName: displayName });
        return Promise.resolve({ messageId: 'fixture' });
      },
    },
  });
  var app = http.createServer(function (req, res) {
    var url = req.url.split('?')[0];
    if (auth.handleRequest(req, res, url)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(auth.isRequestAuthed(req) ? '<!doctype html><h1 id="workspace">Workspace access granted</h1>' : auth.getAuthPage());
  });
  await new Promise(function (resolve) { app.listen(0, '127.0.0.1', resolve); });
  t.after(function () { return new Promise(function (resolve) { app.close(resolve); }); });
  var origin = 'http://127.0.0.1:' + app.address().port;
  state.origins = [origin];
  var browser = await playwright.chromium.launch();
  t.after(function () { return browser.close(); });
  var page = await browser.newPage();
  return { h: h, state: state, page: page, origin: origin };
}

test('a locked-out user recovers from the sign-in page and signs in with the new PIN', { timeout: 90000 }, async function (t) {
  var env = await boot(t);
  var page = env.page;
  await page.goto(env.origin + '/');
  await page.locator('#forgot').waitFor({ state: 'visible' });

  await page.locator('#forgot').click();
  await page.locator('#recover-identifier').fill('Member');
  await page.locator('#recover form button, #recover button.primary').first().click();
  await page.locator('#recovered').waitFor({ state: 'visible' });
  assert.match(await page.locator('#recovered-message').textContent(), /If that account exists/);
  // The page never reveals whether the account exists.
  assert.doesNotMatch(await page.locator('.panel').textContent(), /member@example\.invalid/);
  assert.equal(env.state.sent.length, 1);

  var link = env.state.sent[0].url;
  assert.equal(link.indexOf(env.origin + '/recover-account/'), 0);
  await page.goto(link);
  await page.locator('#secret').waitFor({ state: 'visible' });
  assert.match(await page.locator('#step-set').textContent(), /New PIN/);
  await page.locator('#secret').fill('654321');
  await page.locator('#confirmation').fill('654322');
  await page.locator('#submit').click();
  await page.locator('#error').filter({ hasText: 'PINs do not match' }).waitFor();
  await page.locator('#confirmation').fill('654321');
  await page.locator('#submit').click();
  await page.locator('#step-done').waitFor({ state: 'visible' });
  // Redeeming signs nobody in: the browser still has no session.
  assert.equal((await page.context().cookies()).some(function (entry) { return entry.name.indexOf('relay_auth_user') === 0; }), false);

  // The same link is spent.
  await page.goto(link);
  assert.match(await page.locator('body').textContent(), /invalid or has expired/);

  // The new PIN works on the ordinary sign-in page.
  await page.goto(env.origin + '/');
  await page.locator('#account').click();
  await page.locator('#username').fill('Member');
  await page.locator('#identity button.primary').click();
  await page.locator('#secret').fill('654321');
  await page.locator('#credential button.primary').click();
  await page.locator('#workspace').waitFor();
  assert.equal(env.h.users.authenticateUser('Member', '112233'), null);
});

test('the sign-in page hides recovery when email delivery is unavailable', { timeout: 60000 }, async function (t) {
  var h = fixture.isolated(t);
  fixture.seed(h, h.users.hashPin('012345'));
  var state = h.users.loadUsers();
  state.users.push({ id: 'second', username: 'Second', role: 'user', pinHash: h.users.hashPin('112233') });
  h.users.saveUsers(state);
  var auth = h.server();
  var app = http.createServer(function (req, res) {
    var url = req.url.split('?')[0];
    if (auth.handleRequest(req, res, url)) return;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(auth.getAuthPage());
  });
  await new Promise(function (resolve) { app.listen(0, '127.0.0.1', resolve); });
  t.after(function () { return new Promise(function (resolve) { app.close(resolve); }); });
  var browser = await playwright.chromium.launch();
  t.after(function () { return browser.close(); });
  var page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + app.address().port + '/');
  await page.locator('#account').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#forgot').isVisible(), false);
});
