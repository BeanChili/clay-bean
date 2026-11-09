var FIELDS = 'id,name,shortLink,shortUrl,closed,desc';
function parseReference(value) {
  var match = typeof value === 'string' && value.match(/^https:\/\/trello\.com\/c\/([a-zA-Z0-9]{8})(?:\/[^?#\s]*)?(?:[?#][^\s]*)?$/);
  if (!match) throw new Error('Use a Trello card URL, such as https://trello.com/c/abc12345/title.');
  return { identifier: match[1], url: 'https://trello.com/c/' + match[1] };
}
function authHeader(creds) {
  return 'OAuth oauth_consumer_key="' + creds.key + '", oauth_token="' + creds.token + '"';
}
async function request(creds, path, fetcher) {
  if (!creds || !creds.key || !creds.token) throw new Error('Connect Trello in Settings → Integrations first.');
  var response = await (fetcher || fetch)('https://api.trello.com/1' + path, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: authHeader(creds) },
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Trello rate limit reached. Try again later.' : 'Trello is unavailable. Check your connection and card access.');
  var reader = response.body.getReader(), chunks = [], length = 0;
  try {
    while (true) {
      var next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > 1024 * 1024) throw new Error('Trello response is too large.');
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel(); }
  var text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch (error) { throw new Error('Could not read Trello data. Check your key and card access.'); }
}
function summary(card) {
  if (!card || typeof card.name !== 'string' || !card.id || !/^[a-zA-Z0-9]{8}$/.test(card.shortLink || '')) throw new Error('Trello card is unavailable.');
  return { provider: 'trello', kind: 'card', id: card.id, identifier: card.shortLink, url: 'https://trello.com/c/' + card.shortLink,
    title: card.name.slice(0, 200), state: card.closed ? 'closed' : 'open',
    stateName: String((card.list && card.list.name) || 'Unknown').slice(0, 80),
    board: String((card.board && card.board.name) || '').slice(0, 200), checkedAt: Date.now() };
}
async function readCard(creds, url, cursor, run) {
  var ref = parseReference(url), exec = run || request;
  var data = await exec(creds, '/cards/' + ref.identifier + '?fields=' + FIELDS + '&list=true&board=true&board_fields=name');
  var item = summary(data);
  if (item.identifier !== ref.identifier) throw new Error('Trello returned a different card.');
  var actions = await exec(creds, '/cards/' + data.id + '/actions?filter=commentCard&limit=30' + (cursor ? '&before=' + encodeURIComponent(cursor) : ''));
  var comments = (actions || []).map(function (action) {
    return { id: action.id, body: String((action.data && action.data.text) || '').slice(0, 20000), createdAt: action.date, author: (action.memberCreator && action.memberCreator.fullName) || 'Trello user' };
  });
  return Object.assign(item, { description: String(data.desc || '').slice(0, 100000), comments: comments,
    pageInfo: { hasNextPage: comments.length === 30, endCursor: comments.length ? comments[comments.length - 1].id : null } });
}
async function readReference(creds, url, run) {
  var ref = parseReference(url);
  var data = await (run || request)(creds, '/cards/' + ref.identifier + '?fields=' + FIELDS + '&list=true&board=true&board_fields=name');
  var item = summary(data);
  if (item.identifier !== ref.identifier) throw new Error('Trello returned a different card.');
  return item;
}
async function search(creds, text, run) {
  if (typeof text !== 'string' || !text.trim() || text.length > 2048) throw new Error('Enter a card URL, shortLink or title.');
  text = text.trim();
  if (/^https:\/\//.test(text)) return [await readReference(creds, text, run)];
  if (/^[a-zA-Z0-9]{8}$/.test(text)) return [await readReference(creds, 'https://trello.com/c/' + text, run)];
  if (text.length > 200) throw new Error('Keep title searches under 200 characters.');
  var data = await (run || request)(creds, '/search?query=' + encodeURIComponent(text) + '&modelTypes=cards&cards_limit=20&card_fields=' + encodeURIComponent('id,name,shortLink,closed') + '&card_list=true&card_board=true');
  return (data.cards || []).map(summary);
}
module.exports = { parseReference: parseReference, request: request, summary: summary, readCard: readCard, readReference: readReference, search: search };
