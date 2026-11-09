var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var EventEmitter = require('node:events');
var attach = require('../lib/server-trello').attachTrello;
function world(t) {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-trello-server-'));
  t.after(function () { fs.rmSync(root, { recursive: true, force: true }); });
  var ctx = { CONFIG_DIR: root, isRequestAuthed: function (req) { return !!req.actor; }, users: { isMultiUser: function () { return true; } },
    getMultiUserFromReq: function (req) { return req.actor; }, request: async function () { return { id: 'member', username: 'acme', fullName: 'Acme' }; } };
  var api = attach(ctx);
  function request(method, data, actor, headers, url) {
    var req = new EventEmitter(); req.method = method; req.actor = actor === undefined ? { id: 'owner' } : actor; req.headers = Object.assign({ host: 'clay.test' }, headers);
    var resolve; var done = new Promise(function (callback) { resolve = callback; });
    var res = { writeHead: function (status) { this.status = status; }, end: function (text) { resolve({ status: this.status, data: JSON.parse(text) }); } };
    api.handleRequest(req, res, url || '/api/trello/connection');
    if (data) req.emit('data', Buffer.from(JSON.stringify(data)));
    req.emit('end'); return { done: done, req: req };
  }
  return { ctx: ctx, api: api, request: request };
}
test('connection routes require authentication and same origin, and never return credentials', async function (t) {
  var w = world(t);
  assert.equal((await w.request('GET', null, null).done).status, 401);
  assert.equal((await w.request('PUT', { key: 'secret', token: 'token-value' }, undefined, { origin: 'https://evil.test' }).done).status, 403);
  var saved = await w.request('PUT', { key: 'secret', token: 'token-value' }).done; assert.equal(saved.data.connected, true); assert.ok(!JSON.stringify(saved).includes('secret')); assert.ok(!JSON.stringify(saved).includes('token-value'));
  assert.equal((await w.request('GET', null, { id: 'other' }).done).data.connected, false);
  await w.request('DELETE').done; assert.equal(w.api.storage.creds('owner'), null);
});
test('disconnect wins over a stale connection validation', async function (t) {
  var w = world(t), release;
  w.ctx.request = function () { return new Promise(function (resolve) { release = resolve; }); };
  var save = w.request('PUT', { key: 'secret', token: 'token-value' });
  await w.request('DELETE').done;
  release({ id: 'member', username: 'acme', fullName: 'Acme' });
  assert.equal((await save.done).status, 400); assert.equal(w.api.storage.creds('owner'), null);
});
test('account changes during key validation cannot save a connection', async function (t) {
  var w = world(t), release;
  w.ctx.request = function () { return new Promise(function (resolve) { release = resolve; }); };
  var save = w.request('PUT', { key: 'secret', token: 'token-value' }); save.req.actor = { id: 'other' };
  release({ id: 'member', username: 'acme', fullName: 'Acme' });
  assert.equal((await save.done).status, 400); assert.equal(w.api.storage.creds('owner'), null);
});
test('missing key or token is rejected', async function (t) {
  var w = world(t);
  assert.equal((await w.request('PUT', { key: 'secret' }).done).status, 400);
  assert.equal((await w.request('PUT', { token: 'token-value' }).done).status, 400);
});

test('named connections persist independently and preserve the legacy connection', async function (t) {
  var w = world(t);
  await w.request('PUT', {key:'legacy-secret',token:'legacy-token'}).done;
  async function request(method, data, id, actor) {
    return w.request(method, data, actor, undefined, '/api/trello/connections' + (id ? '/' + id : '')).done;
  }
  assert.equal((await request('PUT', {name:'Work',key:'work-secret',token:'work-token'}, 'work')).status,200);
  assert.equal((await request('PUT', {name:'Personal',key:'personal-secret',token:'personal-token'}, 'personal')).status,200);
  var result = await request('GET');
  assert.deepEqual(result.data.connections.map(function (entry) { return entry.name; }), ['Existing connection','Work','Personal']);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.deepEqual((await request('GET',null,null,{id:'other'})).data.connections,[]);
  assert.deepEqual(w.api.storage.creds('owner'), { key: 'legacy-secret', token: 'legacy-token' });
  assert.deepEqual(w.api.storage.creds('owner','work'), { key: 'work-secret', token: 'work-token' });
  assert.equal((await request('PUT',{name:'Client',key:'',token:''},'work')).status,200);
  assert.deepEqual(w.api.storage.creds('owner','work'),{ key: 'work-secret', token: 'work-token' });
  var restarted = require('../lib/trello-store').attachTrelloStore(w.ctx.CONFIG_DIR);
  assert.equal(restarted.list('owner')[1].name,'Client');
  assert.deepEqual(restarted.creds('owner','personal'),{ key: 'personal-secret', token: 'personal-token' });
  w.ctx.request = async function () { throw new Error('Unavailable'); };
  assert.equal((await request('PUT',{name:'Changed',key:'bad-key',token:'bad-token'},'work')).status,400);
  assert.deepEqual(w.api.storage.creds('owner','work'),{ key: 'work-secret', token: 'work-token' });
  await request('DELETE',null,'work');
  assert.equal(w.api.storage.creds('owner','work'),null);
  assert.deepEqual(w.api.storage.creds('owner','personal'),{ key: 'personal-secret', token: 'personal-token' });
  await w.request('DELETE').done;
  assert.equal(w.api.storage.list('owner').length,1);
});
test('named connection validation cannot undo a disconnect or cross accounts', async function (t) {
  var w=world(t), release;
  w.ctx.request=function(){return new Promise(function(resolve){release=resolve;});};
  var save=w.request('PUT',{name:'Work',key:'secret',token:'token-value'},undefined,undefined,'/api/trello/connections/work');
  await w.request('DELETE',null,undefined,undefined,'/api/trello/connections/work').done;
  release({id:'member',username:'acme',fullName:'Work'});
  assert.equal((await save.done).status,400);
  assert.equal(w.api.storage.creds('owner','work'),null);
});
