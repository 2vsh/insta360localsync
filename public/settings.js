const $ = id => document.getElementById(id);
const numeric = { intervalSeconds: 'interval', cleanupAtPercent: 'cleanup-at', cleanupToPercent: 'cleanup-to', keepRecentHours: 'keep-recent', minCameraAgeMinutes: 'min-camera-age', mirrorGraceHours: 'mirror-grace', minFreeDiskGB: 'disk-reserve', maxDeletesPerRun: 'delete-limit', requestTimeoutSeconds: 'request-timeout', pageSize: 'page-size' };
export function createSettings({ post, poll, formatBytes }) {
  let config, initialized = false, busy = false, dirty = false;
  const form = $('settings-form'), mode = () => form.querySelector('[name=backupMode]:checked').value;
  function collect() {
    return { destination: $('destination').value.trim(), cameraUrl: $('camera-url').value.trim(),
      backupMode: mode(), skipLrv: $('skip-lrv').checked, autoSync: $('auto-sync').checked,
      verifyEverySync: $('verify-sync').checked, lensGuardCorrection: $('lens-guards').checked, acknowledgeDeletes: $('acknowledge-deletes').checked,
      ...Object.fromEntries(Object.entries(numeric).map(([key, id]) => [key, Number($(id).value)])) };
  }
  function options() {
    const selected = mode();
    $('space-options').hidden = selected !== 'space'; $('mirror-options').hidden = selected !== 'mirror';
    $('age-options').hidden = !['space', 'archive'].includes(selected);
    $('delete-options').hidden = selected === 'keep';
    $('proxy-policy-note').hidden = selected === 'keep'; $('skip-lrv').disabled = selected !== 'keep';
    const changed = selected !== config?.backupMode || $('destination').value.trim() !== config?.destination || $('camera-url').value.trim() !== config?.cameraUrl;
    $('policy-acknowledgment').hidden = selected === 'keep' || !changed;
    $('settings-dirty').textContent = dirty ? 'Unsaved changes' : 'Settings saved';
    $('lens-guard-state').textContent = $('lens-guards').checked ? 'On' : 'Off';
  }
  function populate() {
    $('destination').value = config.destination; $('camera-url').value = config.cameraUrl;
    form.querySelector(`[name=backupMode][value="${config.backupMode}"]`).checked = true;
    $('skip-lrv').checked = config.skipLrv; $('auto-sync').checked = config.autoSync; $('verify-sync').checked = config.verifyEverySync;
    $('lens-guards').checked = config.lensGuardCorrection;
    for (const [key, id] of Object.entries(numeric)) $(id).value = config[key];
    $('acknowledge-deletes').checked = false; dirty = false; options();
  }
  form.addEventListener('input', () => { dirty = true; options(); });
  form.addEventListener('change', event => { if (event.target.name === 'backupMode') $('acknowledge-deletes').checked = false; dirty = true; options(); $('policy-preview-result').hidden = true; });
  $('reset-settings').onclick = () => { populate(); $('save-message').textContent = ''; $('policy-preview-result').hidden = true; };
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    busy = true; $('settings-fields').disabled = true; $('save-message').textContent = 'Saving settings…';
    try { await post('/api/config', collect()); initialized = false; $('save-message').textContent = 'Settings saved. Backup changes apply to the next sync. Reopen footage to apply playback changes.'; }
    catch (e) { $('save-message').textContent = e.message; }
    finally { busy = false; await poll(); }
  });
  $('preview-policy').onclick = async () => {
    if (busy || !form.reportValidity()) return;
    busy = true; $('settings-fields').disabled = true; $('save-message').textContent = 'Reading camera and backup history. No files will be changed…';
    try {
      const result = await post('/api/policy-preview', collect()), output = $('policy-preview-result');
      output.replaceChildren(); output.hidden = false;
      const text = document.createElement('p'); text.textContent = `${result.downloads} file(s) to download · ${result.cameraFiles} camera file(s) to remove · ${result.localFiles} local file(s) to recovery`; output.append(text);
      const note = document.createElement('p'); note.className = 'input-hint'; note.textContent = result.note; output.append(note);
      const list = document.createElement('ul');
      for (const action of result.actions) { const li = document.createElement('li'); li.textContent = `${action.kind === 'camera' ? 'Remove from camera' : 'Move to local recovery'}: ${action.names.join(', ')} (${formatBytes(action.bytes)})`; list.append(li); }
      for (const item of result.waiting) { const li = document.createElement('li'); li.textContent = `${item.names.join(', ') || 'Cleanup'}: ${item.reason}`; list.append(li); }
      output.append(list); $('save-message').textContent = 'Preview complete. It does not save settings or start a sync.';
    } catch (e) { $('save-message').textContent = e.message; }
    finally { busy = false; await poll(); }
  };
  return { render(data) {
    config = data.config;
    if (!initialized) { populate(); initialized = true; }
    $('destination').readOnly = data.demo; $('camera-url').readOnly = data.demo;
    $('settings-fields').disabled = data.running || busy;
    const list = $('recovery-list');
    if (!list.matches(':focus-within')) {
      list.replaceChildren();
      for (const item of data.recovery ?? []) {
        const row = document.createElement('div'); row.className = 'recovery-item';
        const description = document.createElement('span'); description.textContent = `${item.names.join(', ')} · ${formatBytes(item.bytes)}${item.status !== 'ready' ? ' · interrupted operation' : ''}`;
        const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'secondary'; restore.textContent = 'Restore'; restore.disabled = data.running || busy;
        restore.onclick = async () => { busy = true; restore.disabled = true; try { const result = await post(`/api/recovery/${item.id}/restore`); $('recovery-message').textContent = `${result.restored} file(s) restored to the backup folder.`; } catch (e) { $('recovery-message').textContent = e.message; } finally { busy = false; await poll(); } };
        row.append(description, restore); list.append(row);
      }
    }
    $('recovery-empty').hidden = Boolean(data.recovery?.length);
  } };
}
