const $ = id => document.getElementById(id);
const form = $('settings-form');
let token, initialized = false, polling = false, pending = false;
const formatBytes = n => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n, u = 0;
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
  return `${value.toFixed(u ? (value < 10 ? 2 : 1) : 0)} ${units[u]}`;
};
const date = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const notice = (id, text) => { $(id).textContent = text || ''; $(id).hidden = !text; };
async function post(url, value = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token }, body: JSON.stringify(value) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
function render(data) {
  token = data.token;
  $('demo-banner').hidden = !data.demo;
  if (!initialized) {
    $('destination').value = data.config.destination;
    $('camera-url').value = data.config.cameraUrl;
    $('skip-lrv').checked = data.config.skipLrv;
    $('auto-sync').checked = data.config.autoSync;
    $('interval').value = data.config.intervalSeconds;
    initialized = true;
  }
  $('destination').readOnly = data.demo;
  $('camera-url').readOnly = data.demo;
  $('settings-fields').disabled = data.running || pending;
  $('sync').disabled = data.running || pending;
  $('sync').textContent = data.running ? 'Downloading…' : 'Download new footage ↓';
  const status = $('camera-status');
  status.className = 'badge' + (data.cameraReachable === true ? ' online' : data.cameraReachable === false ? ' offline' : '');
  status.textContent = data.running ? 'Syncing' : data.cameraReachable === true ? 'Connected at last check' : data.cameraReachable === false ? 'Check connection' : 'Not checked';
  $('camera-name').textContent = data.camera?.model || 'Insta360 X5';
  $('camera-detail').textContent = data.cameraReachable === false ? 'Join the X5 Wi-Fi in Windows, then retry.' : data.camera ? `${data.camera.serial || 'Camera connected'} · ${data.demo ? 'simulated camera' : 'FW ' + (data.camera.firmware || 'unknown')}` : 'Join your camera’s Wi-Fi to get started.';
  $('destination-label').textContent = data.config.destination;
  $('saved-count').textContent = data.files.length;
  $('saved-size').textContent = formatBytes(data.backedUpBytes);
  $('last-sync').textContent = date(data.lastSuccess);
  $('auto-status').textContent = data.config.autoSync ? `Checks every ${data.config.intervalSeconds} seconds while this app is running.` : 'Automatic checks are off.';
  $('progress-count').textContent = data.total ? `${data.completed} / ${data.total} files` : '';
  const fractional = data.current?.size ? data.current.received / data.current.size : 0;
  $('progress').max = Math.max(1, data.total);
  $('progress').value = data.running ? Math.min(data.total, data.completed + fractional) : data.error ? data.completed : data.total;
  $('progress-title').textContent = data.running ? (data.current ? 'Downloading originals' : 'Connecting & listing files…') : data.result ? (data.error ? 'Some files need another try' : 'Everything is up to date') : data.error ? 'Connection needs attention' : 'Ready when you are';
  $('current-file').textContent = data.current ? `${data.current.name} · ${formatBytes(data.current.received)} / ${formatBytes(data.current.size)}` : data.result ? `${data.result.downloaded} saved · ${data.result.skipped} already backed up · ${data.result.failed} failed` : 'Original files stay on the camera.';
  notice('sync-error', data.error);
  notice('history-error', data.historyError);
  $('empty-state').hidden = data.files.length > 0;
  $('files-wrap').hidden = !data.files.length;
  const fragment = document.createDocumentFragment();
  for (const file of data.files.slice(0, 200)) {
    const row = document.createElement('tr');
    row.title = file.path;
    for (const text of [file.name, formatBytes(file.size), date(file.savedAt), '✓ Saved']) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    fragment.append(row);
  }
  $('files').replaceChildren(fragment);
  $('logs').textContent = data.logs.map(x => `${new Date(x.time).toLocaleTimeString()}  ${x.level === 'error' ? 'ERROR  ' : ''}${x.message}`).join('\n') || 'No transfers yet.';
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    notice('connection-error', null);
  } catch (e) {
    notice('connection-error', 'The local app is unavailable. Keep the launcher window open, or restart Start-Sync.cmd. ' + e.message);
    $('sync').disabled = true; $('settings-fields').disabled = true;
  } finally { polling = false; }
}
$('sync').addEventListener('click', async () => {
  if (pending) return;
  pending = true; $('sync').disabled = true;
  try { await post('/api/sync'); }
  catch (e) { notice('sync-error', e.message); }
  finally { pending = false; await poll(); }
});
form.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  pending = true; $('settings-fields').disabled = true;
  $('save-message').textContent = 'Saving…'; $('save-message').classList.remove('problem');
  try {
    await post('/api/config', { destination: $('destination').value.trim(), cameraUrl: $('camera-url').value.trim(), skipLrv: $('skip-lrv').checked, autoSync: $('auto-sync').checked, intervalSeconds: Number($('interval').value) });
    $('save-message').textContent = 'Settings saved.'; initialized = false;
  } catch (e) { $('save-message').textContent = e.message; $('save-message').classList.add('problem'); }
  finally { pending = false; await poll(); }
});
poll(); setInterval(poll, 1000);
