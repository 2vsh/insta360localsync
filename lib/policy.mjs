import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inside, sha256, atomicJson, normalizeEntry, readManifest, lockDestination } from './sync.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const historyFile = config => path.join(config.destination, '.insta360-sync', 'manifest.json');
export const cameraIdentity = (config, info) => hash(String(info.serialNumber || config.cameraUrl));
export const policyContext = (config, info) => hash(JSON.stringify([config.backupMode, config.policyRevision, config.cameraUrl, cameraIdentity(config, info)]));

// Constrain every component before reading, moving or restoring a local original.
// Missing components are permitted for downloads; symbolic links are not.
export async function safeLocal(root, relative) {
  const filename = inside(root, relative);
  let current = path.resolve(root);
  for (const component of path.relative(current, filename).split(path.sep)) {
    current = path.join(current, component);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('A symbolic link in the backup path needs attention.'); }
    catch (e) { if (e.code === 'ENOENT') break; throw e; }
  }
  return filename;
}
async function localState(config, file, verify = false) {
  const filename = await safeLocal(config.destination, file.path);
  let stat;
  try { stat = await fs.stat(filename); } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
  if (!stat.isFile() || stat.size !== file.size) return 'changed';
  if (verify && await sha256(filename) !== file.sha256) return 'changed';
  return 'present';
}
function groupKey(file) {
  const match = /^(VID|LRV|IMG)_(\d{8}_\d{6})_\d{2}_(\d+)\.[^.]+$/i.exec(file.name);
  return match ? `${path.posix.dirname(file.path)}/${match[1].toUpperCase() === 'IMG' ? 'IMG' : 'VID'}_${match[2]}_${match[3]}` : file.path;
}
function groups(files) {
  const result = new Map();
  for (const file of files) { const key = groupKey(file); if (!result.has(key)) result.set(key, []); result.get(key).push(file); }
  return result;
}
function stateFor(config, manifest, info) {
  const previous = manifest.policy?.[cameraIdentity(config, info)];
  if (previous?.context !== policyContext(config, info)) return { context: policyContext(config, info), baseline: {}, missing: {} };
  if (!previous.baseline || !previous.missing || typeof previous.baseline !== 'object' || typeof previous.missing !== 'object' || Array.isArray(previous.baseline) || Array.isArray(previous.missing)) throw new Error('Invalid policy baseline; cleanup stopped.');
  return structuredClone(previous);
}
const inventoryKey = entries => JSON.stringify(entries.map(e => [e.id, e.fingerprint]).sort((a, b) => a[0].localeCompare(b[0])));
export async function currentInventory(camera, config, info) {
  const entries = (await camera.list()).map(raw => normalizeEntry(raw, { ...config, skipLrv: false }, info)).filter(Boolean);
  if (new Set(entries.map(e => e.path.toLowerCase())).size !== entries.length) throw new Error('Camera paths are ambiguous; cleanup stopped.');
  return entries;
}

export async function planPolicy({ config, manifest, entries, info, now, storage }) {
  const state = stateFor(config, manifest, info), byId = new Map(entries.map(e => [e.id, e]));
  const actions = [], waiting = [], suppress = new Set(), observations = {};
  const preview = { mode: config.backupMode, downloads: 0, cameraFiles: 0, localFiles: 0, actions, waiting, storage,
    note: 'Preview only. No files downloaded, moved or deleted. A real sync verifies local SHA-256 and lists the camera again before cleanup.' };
  const addWait = (key, files, reason) => waiting.push({ key, names: files.map(f => f.name), reason });
  if (config.backupMode === 'mirror') {
    for (const [key, files] of groups(Object.values(state.baseline))) {
      if (files.some(f => !f || !/^[a-f0-9]{64}$/.test(f.id) || typeof f.path !== 'string')) throw new Error('Invalid mirror baseline.');
      const cameraFiles = files.filter(f => byId.has(f.id));
      const local = await Promise.all(files.map(f => localState(config, f)));
      if (cameraFiles.some(f => byId.get(f.id).fingerprint !== f.fingerprint)) { addWait(key, files, 'Camera file identity changed.'); continue; }
      const cameraMissing = cameraFiles.length === 0, localMissing = local.every(s => s === 'missing');
      if (cameraMissing && localMissing) { actions.push({ key, kind: 'forget', files }); continue; }
      if (!cameraMissing && !localMissing && cameraFiles.length === files.length && local.every(s => s === 'present')) continue;
      // Do not resurrect a local deletion or separate a recording's companions.
      if (local.some(s => s === 'missing')) for (const f of files) suppress.add(f.id);
      if ((!cameraMissing && cameraFiles.length !== files.length) || (!localMissing && local.some(s => s === 'missing')) || local.includes('changed')) {
        addWait(key, files, 'Only part of this recording is missing or changed. Restore the companions or remove the complete recording.'); continue;
      }
      const kind = cameraMissing ? 'local' : 'camera';
      const previous = state.missing[key];
      const observation = previous?.kind === kind && Number.isFinite(previous.since) && Number.isSafeInteger(previous.count)
        ? { ...previous, count: previous.count + 1 } : { kind, since: now, count: 1 };
      observations[key] = observation;
      const mature = observation.count >= 2 && now > observation.since && now - observation.since >= config.mirrorGraceHours * 3600e3;
      if (!mature) { addWait(key, files, `Deletion pending: needs two successful checks and ${config.mirrorGraceHours} hour(s) of grace.`); continue; }
      actions.push({ key, kind, files: kind === 'camera' ? files.map(f => byId.get(f.id)) : files });
    }
  }
  if (config.backupMode === 'archive' || config.backupMode === 'space') {
    const triggered = config.backupMode === 'archive' || storage && storage.usedPercent >= config.cleanupAtPercent;
    let projectedFree = storage?.free ?? 0;
    const target = storage ? storage.total * (1 - config.cleanupToPercent / 100) : 0;
    if (!storage) addWait('storage', [], 'Storage information is unavailable; camera cleanup is paused.');
    if (triggered && storage) {
      const ordered = [...groups(entries)].sort((a, b) => (a[1][0].capturedAt || '9999').localeCompare(b[1][0].capturedAt || '9999'));
      for (const [key, files] of ordered) {
        if (config.backupMode === 'space' && projectedFree >= target) break;
        const age = Math.max(config.minCameraAgeMinutes / 60, config.backupMode === 'space' ? config.keepRecentHours : 0) * 3600e3;
        if (files.some(f => !f.capturedAt || now - Date.parse(f.capturedAt) < age)) { addWait(key, files, 'Recording is too recent, or its capture time has no timezone.'); continue; }
        const records = files.map(f => manifest.files[f.id]);
        if (records.some((r, i) => !r || r.fingerprint !== files[i].fingerprint || r.path !== files[i].path) || (await Promise.all(records.map(r => localState(config, r)))).some(s => s !== 'present')) {
          addWait(key, files, 'A complete backup is required. New downloads can become eligible later in this sync.'); continue;
        }
        actions.push({ key, kind: 'camera', files }); projectedFree += files.reduce((n, f) => n + f.size, 0);
      }
    }
  }
  for (const entry of entries) {
    if (suppress.has(entry.id)) continue;
    const record = manifest.files[entry.id];
    if (!record || record.fingerprint !== entry.fingerprint || await localState(config, record) !== 'present') preview.downloads++;
  }
  preview.cameraFiles = actions.filter(a => a.kind === 'camera').reduce((n, a) => n + a.files.length, 0);
  preview.localFiles = actions.filter(a => a.kind === 'local').reduce((n, a) => n + a.files.length, 0);
  preview.actions = actions.filter(a => a.kind !== 'forget').slice(0, 200).map(a => ({ kind: a.kind, names: a.files.map(f => f.name), bytes: a.files.reduce((n, f) => n + f.size, 0) }));
  preview.waiting = waiting.slice(0, 200);
  return { state, observations, actions, suppress, preview };
}

async function recycle(config, manifest, files) {
  const id = randomUUID(), relative = `.insta360-sync/recovery/${id}`;
  const item = { id, time: new Date().toISOString(), status: 'pending', files: files.map(f => ({ ...manifest.files[f.id], recoveryPath: `${relative}/${f.id}` })) };
  if (item.files.some(f => !f.path)) throw new Error('A mirror backup record is missing.');
  for (const file of item.files) if (await localState(config, file, true) !== 'present') throw new Error('Local backup changed; mirror removal stopped.');
  manifest.trash ??= {}; manifest.trash[id] = item;
  await atomicJson(historyFile(config), manifest);
  for (const file of item.files) {
    const target = await safeLocal(config.destination, file.recoveryPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(await safeLocal(config.destination, file.path), target);
    delete manifest.files[file.id];
  }
  item.status = 'ready'; await atomicJson(historyFile(config), manifest);
}

export async function applyPolicy({ config, manifest, camera, info, entries, policy, now, log, update, failed }) {
  const result = { cameraDeleted: 0, localRecycled: 0, pending: 0, blocked: null };
  let state = policy.state;
  const persist = async () => { manifest.policy ??= {}; manifest.policy[cameraIdentity(config, info)] = state; await atomicJson(historyFile(config), manifest); };
  try {
    if (!info.serialNumber) throw new Error('Camera identity is unavailable; cleanup stopped.');
    if (failed) throw new Error('Some transfers failed; cleanup is paused for this pass.');
    if ((await camera.info()).serialNumber !== info.serialNumber) throw new Error('Connected camera identity changed; cleanup stopped.');
    let storage = await camera.storage(); update({ storage, phase: 'cleanup' });
    let current = await currentInventory(camera, config, info);
    if (inventoryKey(current) !== inventoryKey(entries)) throw new Error('Camera inventory changed during sync; cleanup is paused.');
    const fresh = await planPolicy({ config, manifest, entries: current, info, now, storage });
    // Missing observations are committed only after complete, stable listings.
    state = fresh.state; state.missing = fresh.observations;
    await persist();
    let count = 0;
    for (const action of fresh.actions) {
      if (action.kind !== 'forget' && count >= config.maxDeletesPerRun) { result.pending += action.files.length; continue; }
      if (action.kind === 'camera') {
        if (config.backupMode === 'space' && storage.usedPercent <= config.cleanupToPercent) break;
        const live = new Map(current.map(f => [f.id, f]));
        if (action.files.some(f => live.get(f.id)?.fingerprint !== f.fingerprint)) throw new Error('Camera recording changed before cleanup.');
        for (const file of action.files) {
          const record = manifest.files[file.id];
          if (config.backupMode === 'mirror') {
            const root = await safeLocal(config.destination, file.path.split('/')[0]);
            if (!(await fs.stat(root)).isDirectory()) throw new Error('Camera backup folder is unavailable.');
            if (await localState(config, file) !== 'missing') throw new Error('Local file reappeared; mirror cleanup paused.');
          } else if (!record || record.fingerprint !== file.fingerprint || await localState(config, record, true) !== 'present') throw new Error('Backup verification failed; camera original kept.');
        }
        // Save intent before the irreversible command. On interruption the next
        // pass re-lists and re-verifies rather than trusting the command response.
        state.pending = { kind: 'camera', files: action.files.map(f => ({ id: f.id, fingerprint: f.fingerprint })), time: new Date().toISOString() };
        await persist();
        await camera.deleteFiles(action.files);
        const expected = current.filter(f => !action.files.some(removed => removed.id === f.id));
        current = await currentInventory(camera, config, info);
        if (action.files.some(f => current.some(c => c.id === f.id))) throw new Error('Camera did not confirm all requested removals; cleanup stopped.');
        if (inventoryKey(expected) !== inventoryKey(current)) throw new Error('Other camera files changed during removal; cleanup stopped.');
        result.cameraDeleted += action.files.length; count++;
        if (config.backupMode === 'mirror') for (const f of action.files) delete manifest.files[f.id];
        log(`Removed ${action.files.length} camera file(s) under the ${config.backupMode} policy.`);
        storage = await camera.storage(); update({ storage });
      } else if (action.kind === 'local') {
        if (action.files.some(f => current.some(c => c.id === f.id))) throw new Error('Camera file reappeared; mirror removal stopped.');
        await recycle(config, manifest, action.files); result.localRecycled += action.files.length; count++;
        log(`Moved ${action.files.length} local file(s) to recovery after camera deletion.`);
      } else for (const f of action.files) delete manifest.files[f.id];
      for (const f of action.files) delete state.baseline[f.id];
      delete state.missing[action.key]; delete state.pending; await persist();
    }
    if (config.backupMode === 'mirror') {
      // Baseline only files that exist on BOTH sides in this policy context.
      // Enabling mirror never interprets historical absence as a deletion.
      for (const [key, files] of groups(current)) {
        if (state.missing[key] || fresh.suppress.has(files[0].id)) continue;
        let valid = true;
        for (const file of files) {
          const record = manifest.files[file.id];
          if (!record || record.path !== file.path || record.fingerprint !== file.fingerprint || await localState(config, record, true) !== 'present') { valid = false; break; }
        }
        if (valid) for (const file of files) state.baseline[file.id] = { ...manifest.files[file.id], cameraId: file.cameraId, capturedAt: file.capturedAt };
      }
    }
    result.pending += fresh.preview.waiting.reduce((n, item) => n + item.names.length, 0);
    await persist();
  } catch (e) { result.blocked = e.message; log('Cleanup paused: ' + e.message, 'warn'); }
  return result;
}

export async function restoreRecovery(config, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid recovery item.');
  const release = lockDestination(config.destination);
  try {
    const manifest = await readManifest(config.destination), item = manifest.trash?.[id];
    if (!item || !Array.isArray(item.files) || !item.files.length) throw new Error('Recovery item not found.');
    const moves = [];
    for (const file of item.files) {
      if (!file.recoveryPath?.startsWith(`.insta360-sync/recovery/${id}/`)) throw new Error('Invalid recovery path.');
      const source = await safeLocal(config.destination, file.recoveryPath), target = await safeLocal(config.destination, file.path);
      let targetStat; try { targetStat = await fs.stat(target); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let sourceStat; try { sourceStat = await fs.stat(source); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      // A crash between renames can leave some members at their original path.
      if (!sourceStat && ['pending', 'restoring'].includes(item.status) && targetStat?.size === file.size && await sha256(target) === file.sha256) continue;
      if (targetStat) throw new Error('An original already exists at the restore path; it was preserved.');
      if (sourceStat?.size !== file.size || await sha256(source) !== file.sha256) throw new Error('Recovery verification failed.');
      moves.push({ source, target });
    }
    item.status = 'restoring'; await atomicJson(historyFile(config), manifest);
    for (const move of moves) { await fs.mkdir(path.dirname(move.target), { recursive: true }); await fs.rename(move.source, move.target); }
    for (const file of item.files) { const { recoveryPath, ...record } = file; record.mtimeMs = (await fs.stat(await safeLocal(config.destination, file.path))).mtimeMs; manifest.files[file.id] = record; }
    // Restored files are deliberately outside the mirror baseline. There is no
    // upload API: recovery restores the PC copy without erasing it next time.
    for (const state of Object.values(manifest.policy ?? {})) for (const file of item.files) { delete state.baseline?.[file.id]; delete state.missing?.[groupKey(file)]; }
    delete manifest.trash[id]; await atomicJson(historyFile(config), manifest);
    return { restored: item.files.length };
  } finally { release(); }
}
