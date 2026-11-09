var test = require('node:test');
var assert = require('node:assert/strict');
var start = require('../lib/project-trello-launch').attachTrelloLaunch;
function world() {
  var calls = 0, created = 0, saved = 0, sessions = new Map(), events = [];
  var ws = { readyState: 1, _clayUser: { id: 'owner' } };
  var ctx = { osUsers: true, getLinuxUserForSession: function () { return 'owner-os'; }, ensureProjectAccessForSession: function () { return 'owner-os'; },
    getProjectAccess: function () { return { visibility: 'public' }; }, resolveDefaultAi: async function () { return { ready: true, vendor: 'claude', model: 'model' }; }, onProcessingChanged: function () {},
    sm: { sessions: sessions, installedVendors: ['claude'], createSessionRaw: function (options) { var session = Object.assign({ localId: ++created, history: [] }, options); sessions.set(session.localId, session); return session; },
      saveSessionFile: function () { saved++; return true; }, deleteSession: function (id) { sessions.delete(id); }, switchSession: function () {}, sendAndRecord: function (session, event) { events.push(event); }, sendToSession: function () {}, broadcastSessionList: function () {} },
    getSdk: function () { return { startQuery: async function (session, prompt) { calls++; assert.match(prompt, /Do not commit/); assert.match(prompt, /Requirements/); session.queryInstance = {}; } }; } };
  var card = { id: 'id', identifier: 'abc12345', url: 'https://trello.com/c/abc12345', title: 'Fix', board: 'Acme Board', description: 'Requirements', comments: [], pageInfo: { hasNextPage: false } };
  return { ctx: ctx, card: card, ws: ws, launch: start(ctx), sessions: sessions, calls: function () { return calls; }, created: function () { return created; }, events: events };
}
test('starting Trello work coalesces requests, preserves context and reopens the existing session', async function () {
  var w = world();
  var results = await Promise.all([w.launch(w.ws, w.card, function () {}), w.launch(w.ws, w.card, function () {})]);
  assert.equal(w.calls(), 1); assert.equal(w.created(), 1); assert.equal(results[0].sessionId, results[1].sessionId);
  var session = w.sessions.get(1); assert.equal(session.trelloLinks[0].description, undefined); assert.equal(session.ownerId, 'owner');
  assert.equal(session.sessionVisibility, 'private');
  assert.equal(session.title, 'Acme Board · Fix');
  var existing = await w.launch(w.ws, w.card, function () {}); assert.equal(existing.existing, true); assert.equal(w.calls(), 1);
});
test('revoked access after runtime selection prevents session creation', async function () {
  var w = world(), allowed = true;
  w.ctx.resolveDefaultAi = async function () { allowed = false; return { ready: true, vendor: 'claude' }; };
  await assert.rejects(w.launch(w.ws, w.card, function () { if (!allowed) throw new Error('revoked'); }), /revoked/);
  assert.equal(w.created(), 0);
});
test('OS identity changes and persistence failures do not dispatch', async function () {
  var w = world(); w.ctx.ensureProjectAccessForSession = function () { return 'other'; };
  await assert.rejects(w.launch(w.ws, w.card, function () {}), /identity/); assert.equal(w.calls(), 0); assert.equal(w.sessions.size, 0);
  w = world(); w.ctx.sm.saveSessionFile = function () { return false; };
  await assert.rejects(w.launch(w.ws, w.card, function () {}), /save/); assert.equal(w.calls(), 0); assert.equal(w.sessions.size, 0);
});
test('runtime failure retains the linked conversation with an actionable error', async function () {
  var w = world(); w.ctx.getSdk = function () { return { startQuery: async function () { throw new Error('runtime unavailable'); } }; };
  await assert.rejects(w.launch(w.ws, w.card, function () {}), function (error) { return error.sessionId === 1; });
  assert.equal(w.sessions.get(1).isProcessing, false); assert.equal(w.events.at(-1).type, 'error');
});
test('falls back to the shortLink when the board name is unavailable', async function () {
  var w = world(); w.card.board = '';
  var result = await w.launch(w.ws, w.card, function () {});
  assert.equal(w.sessions.get(result.sessionId).title, 'abc12345 · Fix');
});
