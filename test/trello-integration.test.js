var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var os = require('node:os');
var api = require('../lib/trello-api');
var attachStore = require('../lib/trello-store').attachTrelloStore;
var attach = require('../lib/project-session-trello').attachSessionTrello;
var url = 'https://trello.com/c/abc12345/title';
function card() { return { id: 'card-uuid', name: 'Repair login', shortLink: 'abc12345', shortUrl: url, closed: false, desc: 'Requirements', list: { name: 'In Progress' }, board: { name: 'Acme Board' } }; }
function actions() { return [{ id: 'comment', date: '2026-01-01T00:00:00.000Z', data: { text: 'Context' }, memberCreator: { fullName: 'Person' } }]; }
function fixture(t, options) {
  options = options || {};
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-trello-'));
  t.after(function () { fs.rmSync(directory, { recursive: true, force: true }); });
  var storage = attachStore(directory);
  storage.save('owner', { key: 'private-key', token: 'private-token' }, { id: 'member', username: 'acme', name: 'Acme' });
  var session = { localId: 1, ownerId: 'owner', title: 'Work', trelloLinks: [] };
  var sm = { sessions: new Map([[1, session]]), saveSessionFile: function () { return true; }, broadcastSessionList: function () {}, switchSession: function () {} };
  var ctx = { storage: storage, sm: sm, projectSlug: 'project', isMate: options.isMate === true, isMultiUser: function () { return true; }, canUse: function () { return true; }, canRead: function (caller, target) { return caller.ownerId === target.ownerId; },
    canAccess: function (ws) { return ws.readyState === 1 && ws._clayUser && ws._clayUser.id === 'owner'; }, canRefresh: function (ws, target) { return ws._clayUser.id === target.ownerId; },
    sendTo: function (ws, msg) { ws.messages.push(msg); },
    query: async function (creds, path) {
      assert.equal(creds.key, 'private-key'); assert.equal(creds.token, 'private-token');
      if (path.indexOf('/actions') >= 0) return actions();
      if (path.indexOf('/search') >= 0) return { cards: [card()] };
      return card();
    } };
  var bridge = attach(ctx);
  return { directory: directory, storage: storage, session: session, sm: sm, ctx: ctx, bridge: bridge,
    call: function (name, args) { return bridge.callBridgeTool(session, name, args || {}); } };
}
async function tick() { await new Promise(function (resolve) { setImmediate(resolve); }); }

test('Trello references reject hostile URLs and normalize slug variants', function () {
  ['https://trello.com.evil/c/abc12345', 'https://user@trello.com/c/abc12345', 'http://trello.com/c/abc12345', 'https://trello.com/c/short', 'https://trello.com/b/abc12345'].forEach(function (value) { assert.throws(function () { api.parseReference(value); }); });
  assert.equal(api.parseReference(url + '#comment').url, 'https://trello.com/c/abc12345');
});
test('Trello API uses a fixed header and rejects partial parses and oversized responses', async function () {
  var response = await api.request({ key: 'key', token: 'token' }, '/cards/abc12345', async function (endpoint, options) {
    assert.equal(endpoint, 'https://api.trello.com/1/cards/abc12345'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'OAuth oauth_consumer_key="key", oauth_token="token"');
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ id: '123' }));
  });
  assert.equal(response.id, '123');
  await assert.rejects(api.request({ key: 'a', token: 'b' }, '/x', async function () { return new Response('not json'); }), /Could not read/);
  await assert.rejects(api.request({ key: 'a', token: 'b' }, '/x', async function () { return new Response('a'.repeat(1024 * 1024 + 1)); }), /too large/);
  await assert.rejects(api.request({ key: 'a', token: 'b' }, '/x', async function () { return new Response('', { status: 429 }); }), /rate limit/);
});
test('read verifies shortLink and returns comments; search uses bounded variables', async function () {
  var detail = await api.readCard({ key: 'k', token: 't' }, url, null, async function (creds, path) { return path.indexOf('/actions') >= 0 ? actions() : card(); });
  assert.equal(detail.comments[0].author, 'Person'); assert.equal(detail.description, 'Requirements');
  await assert.rejects(api.readReference({ key: 'k', token: 't' }, url, async function () { return Object.assign(card(), { shortLink: 'other123' }); }), /different card/);
  var result = await api.search({ key: 'k', token: 't' }, 'login " }', async function (creds, path) {
    assert.match(path, /cards_limit=20/); assert.match(path, /query=login/); return { cards: [card()] };
  });
  assert.equal(result[0].description, undefined); assert.equal(result[0].identifier, 'abc12345');
});
test('title search requests embedded list and board and populates stateName and board', async function () {
  var result = await api.search({ key: 'k', token: 't' }, 'login', async function (creds, path) {
    assert.match(path, /card_list=true/); assert.match(path, /card_board=true/); return { cards: [card()] };
  });
  assert.equal(result[0].stateName, 'In Progress'); assert.equal(result[0].board, 'Acme Board');
});
test('credentials are encrypted, account-bound, restart-safe and absent from views', function (t) {
  var f = fixture(t), disk = fs.readFileSync(path.join(f.directory, 'trello/owner.json'), 'utf8');
  assert.ok(!disk.includes('private-key')); assert.ok(!disk.includes('private-token'));
  assert.ok(!JSON.stringify(f.storage.view('owner')).includes('private-key'));
  assert.deepEqual(attachStore(f.directory).creds('owner'), { key: 'private-key', token: 'private-token' }); assert.equal(f.storage.creds('other'), null);
  fs.writeFileSync(path.join(f.directory, 'trello/other.json'), disk);
  assert.throws(function () { f.storage.creds('other'); });
  assert.throws(function () { f.storage.creds('../owner'); });
  f.storage.save('owner', null); assert.equal(f.storage.creds('owner'), null);
});
test('tools link, deduplicate, persist bounded metadata and unlink without Trello writes', async function (t) {
  var f = fixture(t);
  assert.ok(!(await f.call('link_session_trello', { url: url })).isError);
  await f.call('link_session_trello', { url: url + '#comment' });
  assert.equal(f.session.trelloLinks.length, 1); assert.equal(f.session.trelloLinks[0].description, undefined);
  var got = JSON.parse((await f.call('get_session_trello', { url: url })).content[0].text);
  assert.equal(got.matchingSessions[0].sessionId, 1);
  await f.call('unlink_session_trello', { url: url }); assert.deepEqual(f.session.trelloLinks, []);
});
test('Mate sessions can use the owner Trello connection through native and bridge paths', async function (t) {
  var f = fixture(t, { isMate: true });
  var config = f.bridge.createMcpServer({ createToolServer: function (value) { return value; } }, f.session);
  assert.equal(config.name, 'clay-trello');
  assert.equal(config.tools.length, 5);
  var read = JSON.parse((await f.call('read_trello_card', { url: url })).content[0].text);
  assert.equal(read.identifier, 'abc12345');
  var nativeRead = JSON.parse((await config.tools.find(function (tool) { return tool.name === 'read_trello_card'; }).handler({ url: url })).content[0].text);
  assert.equal(nativeRead.identifier, 'abc12345');
});
test('revoked account, project and session ownership cannot persist a late link', async function (t) {
  for (var kind of ['account', 'project', 'owner']) {
    var f = fixture(t);
    f.ctx.query = async function (creds, path) {
      if (kind === 'account') f.storage.save('owner', null);
      if (kind === 'project') f.ctx.canUse = function () { return false; };
      if (kind === 'owner') f.session.ownerId = 'other';
      return path.indexOf('/actions') >= 0 ? actions() : card();
    };
    assert.equal((await f.call('link_session_trello', { url: url })).isError, true);
    assert.deepEqual(f.session.trelloLinks, []);
  }
});
test('failed session persistence rolls back and failed refresh marks status stale', async function (t) {
  var f = fixture(t); f.sm.saveSessionFile = function () { return false; };
  assert.equal((await f.call('link_session_trello', { url: url })).isError, true); assert.equal(f.session.trelloLinks.length, 0);
  f.sm.saveSessionFile = function () { return true; }; await f.call('link_session_trello', { url: url });
  f.ctx.query = async function () { throw new Error('offline'); };
  await f.call('get_session_trello'); assert.equal(f.session.trelloLinks[0].stale, true);
});
test('unlink during refresh wins over the response snapshot', async function (t) {
  var f = fixture(t); await f.call('link_session_trello', { url: url });
  var release; f.ctx.query = function () { return new Promise(function (resolve) { release = resolve; }); };
  var task = f.call('get_session_trello'); await f.call('unlink_session_trello', { url: url });
  release(card()); await task; assert.deepEqual(f.session.trelloLinks, []);
});
test('panel detail reads use the viewer connection and access is rechecked before reply', async function (t) {
  var f = fixture(t), ws = { readyState: 1, _clayUser: { id: 'owner' }, _clayActiveSession: 1, messages: [] };
  f.bridge.handleMessage(ws, { type: 'trello_read', requestId: 'read', args: { url: url } }); await tick();
  assert.equal(ws.messages[0].result.card.description, 'Requirements');
  ws.messages = []; f.ctx.query = async function (creds, path) { ws._clayUser = { id: 'other' }; return path.indexOf('/actions') >= 0 ? actions() : card(); };
  f.bridge.handleMessage(ws, { type: 'trello_read', requestId: 'read2', args: { url: url } }); await tick();
  assert.deepEqual(ws.messages, []);
});
test('late websocket linking cannot save after connection access is revoked', async function (t) {
  var f = fixture(t), ws = { readyState: 1, _clayUser: { id: 'owner' }, _clayActiveSession: 1, messages: [] };
  f.ctx.query = async function () { ws.readyState = 3; return card(); };
  f.bridge.handleMessage(ws, { type: 'trello_link', args: { url: url, sessionId: 1 } }); await tick();
  assert.deepEqual(f.session.trelloLinks, []);
});
test('native and bridge tool names are exact and safe to approve', function (t) {
  var f = fixture(t), check = require('../lib/sdk-bridge').createSDKBridge({ cwd: process.cwd(), sessionManager: {}, adapter: {}, send: function () {} }).checkToolWhitelist;
  var config = f.bridge.createMcpServer({ createToolServer: function (value) { return value; } }, f.session);
  assert.equal(config.name, 'clay-trello'); assert.equal(config.tools.length, 5);
  config.tools.forEach(function (tool) { assert.equal(check(tool.name, {}).behavior, 'allow'); assert.equal(check(tool.permissionName, {}).behavior, 'allow'); assert.equal(check('mcp__foreign__' + tool.name, {}), null); });
});
test('Trello links survive a session manager restart', function (t) {
  var f = fixture(t), create = require('../lib/sessions').createSessionManager;
  var options = { cwd: path.join(f.directory, 'project'), sessionsBase: f.directory, cliSessionsDir: path.join(f.directory, 'cli'), send: function () {} };
  var manager = create(options), session = manager.createSessionRaw({ cliSessionId: 'trello', ownerId: 'owner' });
  session.trelloLinks = [api.summary(card())]; session.codexTrelloToolCatalogVersion = 1; manager.saveSessionFile(session);
  var restored = create(options), found;
  restored.sessions.forEach(function (item) { if (item.cliSessionId === 'trello') found = item; });
  assert.equal(found.trelloLinks[0].identifier, 'abc12345'); assert.equal(found.codexTrelloToolCatalogVersion, 1);
});
test('renderer shows Trello card and GitHub PR together with escaping', async function () {
  var ui = await import('../lib/public/modules/session-github.js');
  var item = api.summary(card()); item.title = '<script>bad</script>';
  var markup = ui.githubWorkMarkup({ trelloLinks: [item], githubLinks: [{ url: 'https://github.com/a/b/pull/1', kind: 'pr', number: 1, title: 'Fix', state: 'open', repository: 'a/b' }] }, false);
  assert.match(markup, /abc12345/); assert.match(markup, /In Progress/); assert.match(markup, /github.com\/a\/b\/pull\/1/); assert.ok(!markup.includes('<script>'));
});

test('status refresh coalesces the same card across sessions without crossing account connections', async function (t) {
  var f = fixture(t); await f.call('link_session_trello', { url: url });
  var other = { localId: 2, ownerId: 'owner', trelloLinks: f.session.trelloLinks.slice() }; f.sm.sessions.set(2, other);
  var calls = 0; f.ctx.query = async function (creds, path) { calls++; return path.indexOf('/actions') >= 0 ? actions() : card(); };
  await Promise.all([f.call('get_session_trello'), f.bridge.callBridgeTool(other, 'get_session_trello', {})]);
  assert.equal(calls, 1);
  f.storage.save('owner', { key: 'new-key', token: 'new-token' }, { id: 'member', username: 'acme', name: 'Acme' });
  var third = { localId: 3, ownerId: 'owner', trelloLinks: f.session.trelloLinks.slice() }; f.sm.sessions.set(3, third);
  f.ctx.query = async function (creds, path) { assert.equal(creds.key, 'new-key'); calls++; return path.indexOf('/actions') >= 0 ? actions() : card(); };
  await f.bridge.callBridgeTool(third, 'get_session_trello', {}); assert.equal(calls, 2);
});


test('agent tools read requirements and search cards using the session owner connection', async function (t) {
  var f = fixture(t);
  var read = JSON.parse((await f.call('read_trello_card', { url: url })).content[0].text);
  assert.equal(read.description, 'Requirements'); assert.equal(read.comments[0].body, 'Context');
  var search = JSON.parse((await f.call('search_trello_cards', { query: 'login' })).content[0].text);
  assert.equal(search.items[0].identifier, 'abc12345');
  f.ctx.query = async function () { f.session.ownerId = 'other'; return card(); };
  assert.equal((await f.call('read_trello_card', { url: url })).isError, true);
});

test('Trello linking and refreshing cannot replace or unlink a chosen primary', async function (t) {
  var f = fixture(t);
  await f.call('link_session_trello', { url: url });
  var canonical = f.session.trelloLinks[0].url;
  f.session.workPrimary = { trello: canonical };
  await f.call('link_session_trello', { url: url });
  await f.call('get_session_trello');
  assert.equal(f.session.workPrimary.trello, canonical);
  assert.equal((await f.call('unlink_session_trello', { url: url })).isError, true);
  assert.equal(f.session.trelloLinks.length, 1);
});

test('explicit Trello primary tool request requires human selection', async function (t) {
  var f = fixture(t), reply;
  f.ctx.userInput = function () { return function (request, respond) { reply = respond; }; };
  var task = f.call('link_session_trello', { url: url, primary: true });
  await tick();
  assert.equal(f.session.workPrimary, undefined);
  reply({ primary: ['Set primary'] });
  assert.equal((await task).isError, undefined);
  assert.equal(f.session.workPrimary.trello, f.session.trelloLinks[0].url);
});
