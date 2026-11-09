import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { escapeHtml } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { refreshIcons } from './icons.js';
import { trelloIconMarkup } from './session-github.js';
import { handlesWorkbenchKey, claimRightWorkbench, registerRightWorkbench, releaseRightWorkbench } from './right-workbench.js';

function esc(value) { return escapeHtml(String(value || '')).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function panel() { return document.getElementById('trello-panel'); }
function content() { return panel().querySelector('.trello-content'); }
function notice(text) { panel().querySelector('[role="status"]').textContent = text; }
function updateExternalLink(card) {
  var link = panel() && panel().querySelector('[data-trello-external]');
  if (!link) return;
  var heading = panel().querySelector('[data-trello-window-title]');
  var identifier = panel().querySelector('[data-trello-window-id]');
  heading.textContent = card ? card.title || 'Trello card' : 'Trello';
  heading.title = heading.textContent;
  identifier.textContent = card ? card.identifier || '' : '';
  var url = card && card.url;
  var valid = /^https:\/\/trello\.com\/c\/[a-zA-Z0-9]{8}$/.test(url || '');
  link.hidden = !valid;
  if (valid) link.setAttribute('href', url); else link.removeAttribute('href');
}
function request(action, args) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) { notice('Reconnect to use Trello.'); return; }
  if (action === 'trello_read' && !args.cursor) {
    store.set({ trelloCard: null, trelloMatches: [] }); content().textContent = '';
    updateExternalLink(null);
  }
  var id = crypto.randomUUID();
  store.set({ trelloRequest: { id: id, action: action, args: args, project: store.get('currentSlug'), socket: ws } });
  notice('Loading…');
  ws.send(JSON.stringify({ type: action, args: args, requestId: id }));
  return id;
}
var SAFE_CLASS = /^(hljs[a-z0-9-]*|language-[a-z0-9+#-]+|task-list-item|contains-task-list)$/;
function keepSafeClasses(node) {
  if (!node.getAttribute || !node.hasAttribute('class')) return;
  var kept = node.getAttribute('class').split(/\s+/).filter(function (name) { return SAFE_CLASS.test(name); });
  if (kept.length) node.setAttribute('class', kept.join(' ')); else node.removeAttribute('class');
}
function prose(text) {
  var element = document.createElement('template');
  element.innerHTML = renderMarkdown(text || '');
  // Private Trello attachments need authenticated delivery; keep them as links for now.
  element.content.querySelectorAll('img').forEach(function (image) {
    var link = document.createElement('a');
    link.textContent = image.alt || 'View attachment in Trello';
    link.href = (store.get('trelloCard') || {}).url || 'https://trello.com'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    image.replaceWith(link);
  });
  // Task-list checkboxes are inputs (forbidden below); keep their state as text.
  element.content.querySelectorAll('input[type="checkbox"]').forEach(function (box) { box.replaceWith(document.createTextNode(box.checked ? '☑ ' : '☐ ')); });
  // Typography needs only code-highlight and task-list classes; ids and inline styles stay stripped.
  DOMPurify.addHook('afterSanitizeAttributes', keepSafeClasses);
  try {
    return '<div class="md-content">' + DOMPurify.sanitize(element.innerHTML, { ALLOW_DATA_ATTR: false, FORBID_TAGS: ['form', 'button', 'input', 'select', 'textarea', 'iframe', 'video', 'audio', 'style'], FORBID_ATTR: ['id', 'style'] }) + '</div>';
  } finally { DOMPurify.removeHook('afterSanitizeAttributes'); }
}
function chronologicalComments(comments) {
  return (comments || []).slice().sort(function (a, b) {
    var first = Date.parse(a.createdAt), second = Date.parse(b.createdAt);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return 0;
    return first - second;
  });
}
function commentMarkup(comment) {
  var date = new Date(comment.createdAt);
  var timestamp = Number.isFinite(date.getTime()) ? '<time datetime="' + esc(date.toISOString()) + '" title="' + esc(date.toLocaleString()) + '">' + esc(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })) + '</time>' : '';
  return '<article class="issue-comment trello-comment"><header class="issue-comment-meta"><strong>' + esc(comment.author) + '</strong>' + timestamp + '</header><div class="issue-doc-body">' + prose(comment.body) + '</div></article>';
}
function renderCard() {
  var card = store.get('trelloCard'), sessions = store.get('trelloMatches') || [];
  if (!card) return;
  updateExternalLink(card);
  var active = (store.get('githubWorkSessions') || []).find(function (item) { return item.id === store.get('activeSessionId'); });
  var linked = !!(active && (active.trelloLinks || []).some(function (item) { return item.url === card.url; }));
  var prs = active && linked ? (active.githubLinks || []).filter(function (item) { return item.kind === 'pr' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(item.url); }) : [];
  content().innerHTML = '<article class="issue-detail"><div class="trello-card-meta"><span class="trello-card-id" aria-label="Card identifier">' + esc(card.identifier) + '</span>' + (card.stateName ? '<span class="trello-card-status" aria-label="Status">' + esc(card.stateName) + '</span>' : '') + (card.board ? '<span class="trello-card-board" aria-label="Board">' + esc(card.board) + '</span>' : '') + '</div><h2 class="issue-doc-title">' + esc(card.title) + '</h2>' +
    '<section class="trello-conversations"><h3>Linked conversations</h3><div class="workbench-related-links trello-session-pills">' +
    sessions.map(function (item) { return '<button type="button" class="workbench-related-link trello-session-pill" data-trello-session="' + esc(item.sessionId) + '"><i data-lucide="message-square"></i><span>' + esc(item.title || 'Open conversation') + '</span></button>'; }).join('') +
    '<button type="button" class="workbench-related-link trello-session-pill trello-action-chip" data-trello-link' + (!store.get('activeSessionId') ? ' disabled' : '') + '><i data-lucide="' + (linked ? 'unlink' : 'plus') + '"></i><span>' + (linked ? 'Unlink this conversation' : 'Link this conversation') + '</span></button>' +
    (!sessions.length ? '<button type="button" class="workbench-related-link trello-session-pill trello-action-chip" data-trello-start><i data-lucide="plus"></i><span>Start work</span></button>' : '') +
    '</div><p class="trello-sharing-hint">Linked card titles and status are visible to conversation viewers.</p></section>' +
    (prs.length ? '<section><h3>GitHub pull requests</h3>' + prs.map(function (pr) { return '<a target="_blank" rel="noopener noreferrer" href="' + esc(pr.url) + '">PR #' + esc(pr.number) + ' · ' + esc(pr.title) + '</a>'; }).join('<br>') + '</section>' : '') +
    '<div class="issue-doc-body">' + prose(card.description) + '</div><section class="issue-discussion"><h3>Comments</h3>' +
    (card.comments.length ? chronologicalComments(card.comments).map(commentMarkup).join('') : '<p>No comments yet.</p>') +
    (card.pageInfo && card.pageInfo.hasNextPage ? '<button type="button" data-trello-more>More comments</button>' : '') + '</section></article>';
  refreshIcons(content());
}
function showEmpty() {
  updateExternalLink(null);
  store.set({ trelloCard: null, trelloRequest: null, trelloMatches: [] });
  content().innerHTML = '<div class="trello-empty"><strong>No card selected</strong><p>Open a linked Trello card from a conversation badge, or ask the Driver to find and link one. Manage your connection in Settings → Integrations.</p></div>';
  notice('');
}
export function closeTrello() {
  updateExternalLink(null);
  if (panel()) panel().classList.add('hidden');
  store.set({ trelloOpen: false, trelloRequest: null, trelloCard: null, trelloMatches: [] });
  releaseRightWorkbench('trello');
}
export function openTrello(url) {
  initTrelloPanel();
  if (!panel() || store.get('isMate')) return;
  claimRightWorkbench('trello');
  panel().classList.remove('hidden'); store.set({ trelloOpen: true });
  updateExternalLink(null);
  if (url) { content().textContent = ''; request('trello_read', { url: url }); }
  else showEmpty();
}
export function handleTrelloResult(msg) {
  var pending = store.get('trelloRequest');
  if (!pending || !store.get('trelloOpen') || pending.id !== msg.requestId || pending.project !== store.get('currentSlug') || msg.projectSlug !== pending.project || pending.socket !== getWs()) return;
  store.set({ trelloRequest: null });
  panel().querySelectorAll('button').forEach(function (button) { button.disabled = false; });
  if (msg.error) { notice(msg.error); return; }
  notice('');
  var result = msg.result || {};
  if (msg.action === 'trello_read') {
    var card = result.card, old = store.get('trelloCard');
    if (pending.args.cursor && old && old.url === card.url) card.comments = old.comments.concat(card.comments).filter(function (item, index, all) { return all.findIndex(function (other) { return item.id === other.id; }) === index; });
    store.set({ trelloCard: card, trelloMatches: result.matchingSessions }); renderCard();
  } else if (msg.action === 'trello_link' || msg.action === 'trello_unlink') request('trello_read', { url: pending.args.url });
  else if (msg.action === 'trello_start_work' || msg.action === 'trello_open_work') { request('trello_read', { url: pending.args.url }); }
}
export function initTrelloPanel() {
  var host = document.getElementById('main-panels');
  if (!host || panel()) return;
  var el = document.createElement('section'); el.id = 'trello-panel'; el.className = 'hidden'; el.setAttribute('aria-label', 'Trello cards');
  el.innerHTML = '<header class="trello-topbar"><div class="trello-title">' + trelloIconMarkup() + '<a class="trello-header-card" data-trello-external hidden target="_blank" rel="noopener noreferrer" aria-label="Open card in Trello" title="Open in Trello"><span data-trello-window-id></span><i data-lucide="external-link"></i></a><span class="trello-window-title" data-trello-window-title>Trello</span></div><div class="trello-window-actions"><button type="button" class="trello-icon-btn" data-trello-close aria-label="Close Trello" title="Close Trello"><i data-lucide="x"></i></button></div></header><p class="trello-notice" role="status"></p><div class="trello-content"></div>';
  host.appendChild(el); registerRightWorkbench('trello', closeTrello); refreshIcons(el);
  el.addEventListener('click', function (event) {
    var button = event.target.closest('button'); if (!button) return;
    var card = store.get('trelloCard');
    if (button.hasAttribute('data-trello-close')) closeTrello();
    else if (card && button.hasAttribute('data-trello-link')) {
      var active = (store.get('githubWorkSessions') || []).find(function (item) { return item.id === store.get('activeSessionId'); });
      var linked = active && (active.trelloLinks || []).some(function (item) { return item.url === card.url; });
      button.disabled = true; request(linked ? 'trello_unlink' : 'trello_link', { url: card.url, sessionId: store.get('activeSessionId') });
    } else if (card && button.dataset.trelloSession) { button.disabled = true; request('trello_open_work', { url: card.url, sessionId: Number(button.dataset.trelloSession) }); }
    else if (card && button.hasAttribute('data-trello-start')) { button.disabled = true; request('trello_start_work', { url: card.url }); }
    else if (card && button.hasAttribute('data-trello-more')) { button.disabled = true; request('trello_read', { url: card.url, cursor: card.pageInfo.endCursor }); }
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && store.get('trelloOpen') && handlesWorkbenchKey('trello', event)) closeTrello(); });
  store.subscribe(function (state, previous) {
    if (state.currentSlug !== previous.currentSlug || state.myUserId !== previous.myUserId || state.dmMode !== previous.dmMode || (previous.connected && !state.connected)) closeTrello();
    else if (state.trelloOpen && (state.githubWorkSessions !== previous.githubWorkSessions || state.activeSessionId !== previous.activeSessionId) && state.trelloCard) renderCard();
  });
}
