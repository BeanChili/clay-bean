var attachStore = require('./trello-store').attachTrelloStore;
var api = require('./trello-api');
function attachTrello(ctx) {
  var storage = attachStore(ctx.CONFIG_DIR), pending = new Map();
  function owner(req) {
    if (!ctx.isRequestAuthed(req)) return null;
    if (!ctx.users.isMultiUser()) return 'default';
    var user = ctx.getMultiUserFromReq(req);
    return user && user.id;
  }
  function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
  function handleRequest(req, res, url) {
    var match = /^\/api\/trello\/connections(?:\/([a-zA-Z0-9_-]{1,64}))?$/.exec(url);
    if (url !== '/api/trello/connection' && !match) return false;
    var connectionId = match && match[1];
    if (match && !connectionId && req.method !== 'GET') { json(res, 405, { error: 'Method not allowed.' }); return true; }
    var id = owner(req);
    if (!id) { json(res, 401, { error: 'Sign in to connect Trello.' }); return true; }
    var origin = req.headers.origin;
    try { if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) throw new Error(); }
    catch (error) { json(res, 403, { error: 'Invalid request origin.' }); return true; }
    if (req.method === 'GET') {
      try { json(res, 200, match && !connectionId ? { connections: storage.list(id) } : storage.view(id, connectionId)); } catch (error) { json(res, 500, { error: 'Could not read Trello connection.' }); }
      return true;
    }
    if (req.method !== 'PUT' && req.method !== 'DELETE') { json(res, 405, { error: 'Method not allowed.' }); return true; }
    // A disconnect or newer save invalidates an older validation in flight.
    var operation = {}, pendingId = id + ':' + (connectionId || 'default'); pending.set(pendingId, operation);
    var chunks = [], size = 0;
    req.on('data', function (chunk) { size += chunk.length; if (size <= 8192) chunks.push(chunk); });
    req.on('end', async function () {
      try {
        if (size > 8192) throw new Error('Request is too large.');
        var credsValue = null, account = null, name;
        if (req.method === 'PUT') {
          var body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          name = body.name;
          if (match && (typeof name !== 'string' || !name.trim() || name.trim().length > 80)) throw new Error('Invalid connection name.');
          var existing = storage.creds(id, connectionId);
          var key = body.key, token = body.token;
          if (match && !key) key = existing && existing.key;
          if (match && !token) token = existing && existing.token;
          if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('Enter a valid Trello API key.');
          if (typeof token !== 'string' || !token.trim() || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Enter a valid Trello token.');
          credsValue = { key: key.trim(), token: token.trim() };
          var data = await (ctx.request || api.request)(credsValue, '/members/me?fields=id,username,fullName');
          if (!data || !data.id) throw new Error('Trello account is unavailable.');
          account = { id: data.id, username: data.username, name: data.fullName };
        }
        if (pending.get(pendingId) !== operation || owner(req) !== id || res.destroyed) throw new Error('Connection changed. Please try again.');
        json(res, 200, storage.save(id, credsValue, account, connectionId, name));
      } catch (error) { if (!res.destroyed) json(res, 400, { error: 'Could not update Trello connection. Check your API key and token and try again.' }); }
      finally { if (pending.get(pendingId) === operation) pending.delete(pendingId); }
    });
    req.on('error', function () { if (pending.get(pendingId) === operation) pending.delete(pendingId); });
    return true;
  }
  return { handleRequest: handleRequest, storage: storage };
}
module.exports = { attachTrello: attachTrello };
