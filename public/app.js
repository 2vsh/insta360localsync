import { createSettings } from './settings.js';
import { Viewer, waitJob, timecode } from './viewer.js';
const $ = id => document.getElementById(id);
let token, polling = false, pending = false, backupBusy = false;
const formatBytes = n => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n, u = 0;
  while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
  return `${value.toFixed(u ? (value < 10 ? 2 : 1) : 0)} ${units[u]}`;
};
const date = value => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not yet synced';
const notice = (id, text) => { $(id).textContent = text || ''; $(id).hidden = !text; };
async function post(url, value = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token }, body: JSON.stringify(value) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const policyNames = { keep: 'Keep both', mirror: 'Mirror deletions', archive: 'Archive on this PC', space: 'Make room when needed' };
const settings = createSettings({ post, poll, formatBytes });
function render(data) {
  token = data.token;
  $('demo-banner').hidden = !data.demo;
  settings.render(data);
  const wasBusy = backupBusy; backupBusy = data.running;
  $('sync').disabled = data.running || pending;
  $('sync').textContent = data.running ? 'Sync in progress…' : 'Sync now';
  const status = $('camera-status');
  status.className = 'badge' + (data.cameraReachable === true ? ' online' : data.cameraReachable === false ? ' offline' : '');
  status.textContent = data.running ? 'Syncing' : data.cameraReachable === true ? 'Connected at last check' : data.cameraReachable === false ? 'Check connection' : 'Not checked';
  $('camera-name').textContent = data.camera?.model || 'Insta360 X5';
  $('camera-detail').textContent = data.cameraReachable === false ? 'Join the X5 Wi-Fi in Windows, then retry.' : data.camera ? `Camera connected · ${data.demo ? 'simulated camera' : 'FW ' + (data.camera.firmware || 'unknown')}` : 'Join your camera’s Wi-Fi to get started.';
  $('destination-label').textContent = data.config.destination;
  $('library-folder').textContent = data.config.destination;
  $('saved-count').textContent = data.files.length;
  $('saved-size').textContent = formatBytes(data.backedUpBytes);
  $('last-sync').textContent = data.files[0]?.savedAt ? date(data.files[0].savedAt) : 'No backups yet';
  $('auto-status').textContent = data.config.autoSync ? `Checks every ${data.config.intervalSeconds} seconds while this app is running.` : 'Automatic checks are off.';
  $('progress-count').textContent = data.total ? `${data.completed} / ${data.total} files` : '';
  const fractional = data.current?.size ? data.current.received / data.current.size : 0;
  $('progress').max = Math.max(1, data.total);
  $('progress').value = data.running ? Math.min(data.total, data.completed + fractional) : data.error ? data.completed : data.total;
  $('progress-title').textContent = data.running ? ({preview: 'Previewing backup policy', cleanup: 'Applying backup policy', restore: 'Restoring local files'}[data.phase] || (data.current ? 'Downloading originals' : 'Connecting and listing files…')) : data.result ? (data.error ? 'Some files need another try' : 'Sync complete') : data.error ? 'Connection needs attention' : 'Ready to sync';
  $('current-file').textContent = data.current ? `${data.current.name} · ${formatBytes(data.current.received)} / ${formatBytes(data.current.size)}` : data.result ? `${data.result.downloaded} saved · ${data.result.skipped} already backed up · ${data.result.failed} failed` : `Policy: ${policyNames[data.config.backupMode]}.`;
  $('active-policy').textContent = policyNames[data.config.backupMode];
  $('camera-storage').textContent = data.storage ? `${formatBytes(data.storage.free)} free of ${formatBytes(data.storage.total)} (${Math.round(data.storage.usedPercent)}% used) · at last check` : 'Not checked';
  const cleanup = data.result?.cleanup;
  notice('cleanup-notice', cleanup?.blocked ? 'Cleanup paused: ' + cleanup.blocked : cleanup ? `${cleanup.cameraDeleted} camera files removed · ${cleanup.localRecycled} local files in recovery · ${cleanup.pending} pending` : null);
  notice('sync-error', data.error);
  notice('history-error', data.historyError);
  updateLibrary(data);
  if (wasBusy && !backupBusy) { for (const [id, info] of metadata) if (info.error) metadata.delete(id); renderGallery(); inspectNext(); }
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
let library = [], signature = '', filter = 'all', limit = 24, metadata = new Map(), inspectQueue = [], inspecting = 0;
const kind = file => /\.(insp|jpe?g|png|dng)$/i.test(file.name) ? 'image' : /\.(insv|mp4|mov|webm|lrv)$/i.test(file.name) ? 'video' : 'other';
const mediaUrl = url => `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
function showPage(page, focus = true) {
  for (const name of ['library', 'transfer', 'settings']) { $(`${name}-page`).hidden = name !== page; $(`${name}-tab`).classList.toggle('selected', name === page); if (name === page) $(`${name}-tab`).setAttribute('aria-current', 'page'); else $(`${name}-tab`).removeAttribute('aria-current'); }
  window.scrollTo(0, 0);
  document.title = `${page === 'transfer' ? 'Sync' : page === 'settings' ? 'Settings' : 'Library'} · Insta360 Local Sync`;
  if (focus) $(`${page}-heading`).focus({ preventScroll: true });
  const hash = '#' + (page === 'transfer' ? 'sync' : page);
  if (location.hash !== hash) history.pushState(null, '', hash);
}
function pageFromHash(focus = true) { showPage(({ '#sync': 'transfer', '#settings': 'settings' })[location.hash] || 'library', focus); }
window.addEventListener('hashchange', () => pageFromHash());
document.querySelector('.skip-link').onclick = event => { event.preventDefault(); $('main').focus(); };
pageFromHash(false);
for (const id of ['go-sync', 'empty-sync', 'transfer-tab']) $(id).onclick = () => showPage('transfer');
$('settings-tab').onclick = $('open-settings').onclick = () => showPage('settings');
$('library-tab').onclick = () => showPage('library');
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
const viewer = new Viewer({ post, mediaUrl, onExport: exports => {
  const tray = $('export-tray'); tray.hidden = exports.size === 0;
  // Keep completed cuts accessible after the viewer is closed.
  for (const [id, item] of exports) {
    let row = tray.querySelector(`[data-id="${id}"]`);
    if (!row) {
      row = element('div', 'export-item'); row.dataset.id = id;
      row.append(element('span'), element('button', 'text-button')); tray.append(row);
    }
    row.firstChild.textContent = item.result ? `${item.file.name} · Cut ready` : item.error || `Rendering cut · ${Math.round(item.job.progress * 100)}%`;
    row.lastChild.onclick = () => item.result ? viewer.saveFile(item.result).catch(e => notice('connection-error', e.message)) : viewer.open(item.file);
    row.lastChild.textContent = item.result ? 'Save MP4 as…' : 'Open clip';
  }
} });
function updateLibrary(data) {
  const next = JSON.stringify([data.config.destination, data.config.lensGuardCorrection, data.files.map(f => [f.id, f.size, f.mtimeMs, f.savedAt])]);
  if (signature === next) return;
  signature = next;
  // Older cameras split a recording into _00_ / _10_ files. Show one card per pair.
  const paths = new Set(data.files.map(f => f.path.toLowerCase()));
  library = data.files.filter(f => !/_10_\d+\.insv$/i.test(f.name) || !paths.has(f.path.replace(/_10_(\d+)\.insv$/i, '_00_$1.insv').toLowerCase()));
  metadata = new Map(); inspectQueue = []; limit = 24; renderGallery();
}
function renderGallery() {
  observer.disconnect();
  const query = $('search').value.toLowerCase().trim(), sort = $('sort').value;
  const files = library.filter(f => (filter === 'all' || kind(f) === filter) && f.name.toLowerCase().includes(query)).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'oldest' ? a.savedAt.localeCompare(b.savedAt) : b.savedAt.localeCompare(a.savedAt));
  $('library-count').textContent = library.length; $('empty-state').hidden = library.length > 0; $('gallery').hidden = !files.length; $('no-results').hidden = !library.length || !!files.length; $('load-more').hidden = files.length <= limit;
  const fragment = document.createDocumentFragment();
  for (const file of files.slice(0, limit)) {
    const card = element('button', 'media-card'); card.dataset.id = file.id; card.setAttribute('aria-label', `Open ${file.name}`);
    const thumbnail = element('div', 'thumbnail'), placeholder = element('div', 'thumbnail-placeholder'); placeholder.append(element('span', '', kind(file) === 'image' ? '▧' : '▶'), element('small', '', 'Loading preview…')); thumbnail.append(placeholder, element('span', 'thumbnail-tag', kind(file) === 'image' ? 'Photo' : /\.insv$/i.test(file.name) ? '360° video' : kind(file) === 'video' ? 'Video' : 'File'), element('span', 'play-overlay', kind(file) === 'image' ? '↗' : '▶'));
    card.append(thumbnail, element('p', 'media-title', file.name));
    card.title = file.name;
    const details = element('div', 'media-details'); details.append(element('span', '', file.savedAt ? date(file.savedAt) : 'Backup date unavailable'), element('span', '', formatBytes(file.size))); card.append(details); card.onclick = () => viewer.open(file); fragment.append(card);
    const info = metadata.get(file.id); if (info) decorate(card, info); else observer.observe(card);
  }
  $('gallery').replaceChildren(fragment);
}
function decorate(card, info) {
  const thumbnail = card.querySelector('.thumbnail'), placeholder = card.querySelector('.thumbnail-placeholder');
  if (info.error) { placeholder.lastChild.textContent = 'Preview unavailable'; card.title = info.error; return; }
  if (!thumbnail.querySelector('img')) { const img = element('img'); img.src = mediaUrl(info.thumbnail); img.alt = ''; img.loading = 'lazy'; img.onload = () => { placeholder.hidden = true; }; thumbnail.prepend(img); }
  if (!info.image && !thumbnail.querySelector('.thumbnail-duration')) thumbnail.append(element('span', 'thumbnail-duration', timecode(info.duration)));
  card.querySelector('.thumbnail-tag').textContent = info.image ? 'Photo' : info.projection === 'equirect' ? '360° video' : 'Video';
}
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); const id = entry.target.dataset.id; if (!metadata.has(id) && !inspectQueue.some(item => item.id === id)) inspectQueue.push({ id, signature }); }
  inspectNext();
}, { rootMargin: '150px' });
async function inspectNext() {
  if (backupBusy) return;
  while (inspecting < 2 && inspectQueue.length) {
    const item = inspectQueue.shift(); if (metadata.has(item.id) || item.signature !== signature) continue;
    inspecting++;
    (async () => {
      let info;
      try { info = await waitJob(await post(`/api/media/${item.id}/inspect`)); }
      catch (e) { info = { error: e.message }; }
      if (item.signature === signature) { metadata.set(item.id, info); const card = $('gallery').querySelector(`[data-id="${item.id}"]`); if (card) decorate(card, info); }
    })().finally(() => { inspecting--; inspectNext(); });
  }
}
document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { filter = button.dataset.filter; limit = 24; document.querySelectorAll('[data-filter]').forEach(node => { const selected = node === button; node.classList.toggle('selected', selected); node.setAttribute('aria-pressed', selected); }); renderGallery(); });
$('search').oninput = () => { limit = 24; renderGallery(); }; $('sort').onchange = renderGallery; $('load-more').onclick = () => { limit += 24; renderGallery(); };
fetch('/api/media-tools').then(response => response.json()).then(data => { if (!data.available) notice('tools-notice', 'Gallery previews and MP4 rendering need FFmpeg. Install with “winget install Gyan.FFmpeg”, then restart the launcher. Downloads still work.'); }).catch(() => {});
poll(); setInterval(poll, 1500);
