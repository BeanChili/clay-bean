import { store } from './store.js';

export function clearTrelloKeyInput() {
  var key = document.getElementById('us-trello-key');
  var token = document.getElementById('us-trello-token');
  if (key) key.value = '';
  if (token) token.value = '';
}
function setTrelloStatus(text, state) {
  var status = document.getElementById('us-trello-status');
  if (!status) return;
  status.textContent = text;
  if (state) status.dataset.state = state; else delete status.dataset.state;
}
export async function loadTrelloConnection() {
  var actor = store.get('myUserId');
  var generation = (store.get('trelloConnectionGeneration') || 0) + 1;
  store.set({ trelloConnectionGeneration: generation });
  try {
    var response = await fetch('/api/trello/connection');
    if (!response.ok) throw new Error('Could not load Trello connection.');
    var data = await response.json();
    if (store.get('trelloConnectionGeneration') !== generation || store.get('myUserId') !== actor) return;
    store.set({ trelloConnection: data });
    setTrelloStatus(data.connected ? 'Connected to ' + data.account.name : 'Not connected', data.connected ? 'connected' : '');
    var disconnect = document.getElementById('us-trello-disconnect');
    if (disconnect) disconnect.disabled = !data.connected;
  } catch (error) { if (store.get('trelloConnectionGeneration') === generation) setTrelloStatus(error.message, 'error'); }
}
export function initTrelloSettings() {
  var form = document.getElementById('us-trello-form');
  if (!form || store.get('trelloSettingsBound')) return;
  store.set({ trelloSettingsBound: true });
  async function save(disconnect) {
    if (store.get('trelloConnectionSaving')) return;
    var actor = store.get('myUserId');
    store.set({ trelloConnectionSaving: true, trelloConnectionGeneration: (store.get('trelloConnectionGeneration') || 0) + 1 });
    var key = document.getElementById('us-trello-key');
    var token = document.getElementById('us-trello-token');
    var buttons = form.querySelectorAll('button');
    buttons.forEach(function (button) { button.disabled = true; });
    setTrelloStatus(disconnect ? 'Disconnecting…' : 'Connecting…', '');
    try {
      var response = await fetch('/api/trello/connection', { method: disconnect ? 'DELETE' : 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: disconnect ? undefined : JSON.stringify({ key: key.value, token: token.value }) });
      if (store.get('myUserId') !== actor) return;
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not update Trello connection.');
      clearTrelloKeyInput();
      store.set({ trelloConnection: data, githubWorkRefresh: null });
      form.hidden = true;
      setTrelloStatus(data.connected ? 'Connected to ' + data.account.name : 'Disconnected', data.connected ? 'connected' : '');
    } catch (error) { setTrelloStatus(error.message, 'error'); }
    finally {
      store.set({ trelloConnectionSaving: false });
      buttons.forEach(function (button) { button.disabled = false; });
      document.getElementById('us-trello-disconnect').disabled = !(store.get('trelloConnection') || {}).connected;
    }
  }
  store.subscribe(function (state, previous) {
    if (state.myUserId !== previous.myUserId) { clearTrelloKeyInput(); store.set({ trelloConnection: null, trelloConnectionGeneration: (state.trelloConnectionGeneration || 0) + 1 }); }
  });
  form.addEventListener('submit', function (event) { event.preventDefault(); save(false); });
  document.getElementById('us-trello-disconnect').addEventListener('click', function () { save(true); });
}
