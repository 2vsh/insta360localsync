import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createMockCamera } from '../lib/mock-camera.mjs';
import { runSync, validateConfig, readManifest, inside, atomicJson } from '../lib/sync.mjs';
import { restoreRecovery } from '../lib/policy.mjs';
import { createApp } from '../server.mjs';

const root = path.resolve('.test-data'), now = Date.parse('2026-10-21T12:00:00Z');
const clip = (stamp, view = '00', size = 20000, prefix = 'VID') => ({ name: `${prefix}_${stamp}_${view}_001.${prefix === 'LRV' ? 'mp4' : 'insv'}`, data: Buffer.alloc(size, 97), dateTimeZone: `2026:10:${stamp.slice(6, 8)} 12:00:00+00:00` });
const pair = () => [clip('20261018_120000'), clip('20261018_120000', '10'), clip('20261018_120000', '01', 1000, 'LRV')];
async function setup(t, mode, files = pair(), controls = {}) {
  await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'policy-'));
  const camera = await createMockCamera({ files, controls });
  const config = validateConfig({ cameraUrl: camera.url, destination: path.join(dir, 'footage'), backupMode: mode, mirrorGraceHours: 1, minFreeDiskGB: 0, requestTimeoutSeconds: 2, pageSize: 2 });
  t.after(async () => { await camera.close(); const rel = path.relative(root, dir); assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel)); await fs.rm(dir, { recursive: true, force: true }); });
  const sync = (extra = {}) => runSync(config, { now, ...extra });
  return { dir, camera, config, sync, records: async () => Object.values((await readManifest(config.destination)).files) };
}

test('archive backs up every companion and verifies bytes before removing the recording', async t => {
  const { camera, config, sync, records } = await setup(t, 'archive');
  const result = await sync(); assert.equal(result.downloaded, 3); assert.equal(result.cleanup.cameraDeleted, 3); assert.equal(result.cleanup.blocked, null);
  assert.equal(camera.files.length, 0); assert.equal(camera.deletions.length, 1);
  assert.equal((await records()).length, 3);
  for (const f of await records()) assert.equal((await fs.readFile(inside(config.destination, f.path))).length, f.size);
});

test('cleanup rehashes backups even when size and modification time still match', async t => {
  const { camera, config, sync, records } = await setup(t, 'keep');
  await sync(); config.backupMode = 'archive';
  const file = (await records())[0], filename = inside(config.destination, file.path), stat = await fs.stat(filename);
  await fs.writeFile(filename, Buffer.alloc(file.size, 42)); await fs.utimes(filename, stat.atime, stat.mtime);
  // A forged same-size, same-mtime record must still fail the cleanup hash.
  const manifest = await readManifest(config.destination); manifest.files[file.id].mtimeMs = (await fs.stat(filename)).mtimeMs;
  await atomicJson(path.join(config.destination, '.insta360-sync/manifest.json'), manifest);
  const result = await sync(); assert.match(result.cleanup.blocked, /verification failed/); assert.equal(camera.deletions.length, 0);
});

for (const controls of [{ interruptOnce: true }, { storageError: true }, { recording: true }, { cardState: 'noCard' }]) test(`unsafe cleanup conditions preserve originals: ${JSON.stringify(controls)}`, async t => {
  const { camera, sync } = await setup(t, 'archive', pair(), controls);
  const result = await sync(); assert.equal(result.cleanup.cameraDeleted, 0); assert.ok(result.cleanup.blocked); assert.equal(camera.deletions.length, 0); assert.equal(camera.files.length, 3);
});

test('unknown or recent camera dates are never cleanup candidates', async t => {
  const files = [clip('20261018_120000'), clip('20261021_120000')]; files[0].dateTimeZone = '2026:10:18 12:00:00';
  const { camera, sync } = await setup(t, 'archive', files);
  const result = await sync(); assert.equal(result.downloaded, 2); assert.equal(result.cleanup.cameraDeleted, 0); assert.equal(camera.deletions.length, 0);
});

test('smart cleanup removes oldest complete backed-up recordings down to target, retaining recent footage', async t => {
  const files = [clip('20261017_120000', '00', 20000), clip('20261018_120000', '00', 20000), clip('20261021_120000', '00', 20000)];
  const { camera, config, sync } = await setup(t, 'space', files, { totalSpace: 100000, otherUsed: 31000 });
  config.cleanupToPercent = 60;
  const result = await sync(); assert.equal(result.cleanup.cameraDeleted, 2);
  assert.equal(camera.deletions[0][0].includes('20261017'), true); assert.equal(camera.files.length, 1); assert.match(camera.files[0].name, /20261021/);
});

test('mirror establishes a baseline before following deletions in either direction with grace and recovery', async t => {
  const { camera, config, sync, records } = await setup(t, 'mirror');
  await sync(); camera.files.splice(0);
  assert.equal((await sync({ now: now + 1000 })).cleanup.localRecycled, 0);
  const result = await sync({ now: now + 3601e3 }); assert.equal(result.cleanup.localRecycled, 3); assert.equal((await records()).length, 0);
  const manifest = await readManifest(config.destination), item = Object.values(manifest.trash)[0]; assert.equal(item.status, 'ready');
  assert.equal((await restoreRecovery(config, item.id)).restored, 3); assert.equal((await records()).length, 3);
  assert.equal((await sync({ now: now + 7202e3 })).cleanup.localRecycled, 0, 'restored PC-only files stay outside the mirror baseline');
  assert.equal(camera.deletions.length, 0);
});

test('mirror follows complete local deletions without re-downloading them, but preserves partial lens pairs', async t => {
  const { camera, config, sync, records } = await setup(t, 'mirror');
  await sync(); const files = await records(); await fs.unlink(inside(config.destination, files[0].path));
  const partial = await sync({ now: now + 1000 }); assert.equal(partial.downloaded, 0); assert.equal(camera.deletions.length, 0);
  for (const file of files.slice(1)) await fs.unlink(inside(config.destination, file.path));
  await sync({ now: now + 2000 }); const result = await sync({ now: now + 3603e3 });
  assert.equal(result.cleanup.cameraDeleted, 3); assert.equal(result.downloaded, 0); assert.equal(camera.files.length, 0); assert.equal((await records()).length, 0);
});

test('enabling mirror retains historical PC-only footage and restores old local omissions as a fresh baseline', async t => {
  const { camera, config, sync, records } = await setup(t, 'keep');
  await sync(); const files = await records(); camera.files.splice(1);
  await fs.unlink(inside(config.destination, files[0].path)); config.backupMode = 'mirror';
  assert.equal((await sync()).downloaded, 1); assert.equal((await sync({ now: now + 7200e3 })).cleanup.localRecycled, 0); assert.equal((await records()).length, 2);
});

test('policy previews do not advance mirror grace, download or delete anything', async t => {
  const { camera, config, sync, records } = await setup(t, 'mirror');
  await sync(); const files = await records(); for (const f of files) await fs.unlink(inside(config.destination, f.path));
  const before = await fs.readFile(path.join(config.destination, '.insta360-sync/manifest.json'));
  const preview = await sync({ dryRun: true, now: now + 7200e3 }); assert.equal(preview.mode, 'mirror'); assert.equal(preview.downloads, 0);
  assert.deepEqual(await fs.readFile(path.join(config.destination, '.insta360-sync/manifest.json')), before);
  assert.equal(camera.deletions.length, 0);
});

test('camera deletion errors or incomplete deletion confirmations stop cleanup and retain recovery intent', async t => {
  for (const controls of [{ deleteError: true }, { deleteNoop: true }, { deletePartial: true }]) {
    const { config, sync, records } = await setup(t, 'archive', pair(), controls);
    const result = await sync(); assert.ok(result.cleanup.blocked); assert.equal((await records()).length, 3);
    const state = Object.values((await readManifest(config.destination)).policy)[0]; assert.ok(state.pending);
  }
});

test('PC free-space reserve blocks downloads and all cleanup, and deletion caps limit each pass', async t => {
  const a = await setup(t, 'archive'); a.config.minFreeDiskGB = 100000;
  assert.equal((await a.sync()).failed, 3); assert.equal(a.camera.deletions.length, 0);
  const b = await setup(t, 'archive', [clip('20261017_120000'), clip('20261018_120000')]); b.config.maxDeletesPerRun = 1;
  assert.equal((await b.sync()).cleanup.cameraDeleted, 1); assert.equal(b.camera.files.length, 1);
});

test('settings API previews unsaved policies, requires acknowledgment and persists settings with a new mirror context', async t => {
  const { config, dir, camera } = await setup(t, 'keep');
  const filename = path.join(dir, 'profile.json'); const app = await createApp(config, { configFile: filename, quiet: true }); const url = await app.listen(0);
  t.after(() => app.close()); const status = await (await fetch(url + '/api/status')).json();
  const post = (route, input) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': status.token }, body: JSON.stringify(input) });
  const preview = await post('/api/policy-preview', { backupMode: 'archive' }); assert.equal(preview.status, 200); assert.equal((await preview.json()).downloads, 3); assert.equal(camera.deletions.length, 0);
  assert.equal((await post('/api/config', { backupMode: 'mirror' })).status, 400);
  assert.equal((await post('/api/config', { backupMode: 'mirror', acknowledgeDeletes: true })).status, 200);
  const saved = JSON.parse(await fs.readFile(filename, 'utf8')); assert.equal(saved.backupMode, 'mirror'); assert.notEqual(saved.policyRevision, 'initial');
  assert.equal((await post('/api/config', { cleanupToPercent: 95 })).status, 400);
});

test('deletion policies reject incomplete counts and changing inventories before any removal', async t => {
  const a = await setup(t, 'archive', pair(), { omitTotal: true });
  await assert.rejects(a.sync(), /complete camera file count/); assert.equal(a.camera.deletions.length, 0);
  const b = await setup(t, 'archive');
  let lists = 0;
  b.camera.controls.onList = (files, p) => { if (p.startPosition === 0 && ++lists === 2) files.push(clip('20261019_120000')); };
  assert.match((await b.sync()).cleanup.blocked, /inventory changed/); assert.equal(b.camera.deletions.length, 0);
});

test('removing the whole camera folder cannot propagate a local mirror deletion', async t => {
  const { camera, config, sync, records } = await setup(t, 'mirror'); await sync();
  const folder = inside(config.destination, (await records())[0].path.split('/')[0]);
  await fs.rename(folder, folder + '-unavailable');
  await sync({ now: now + 1000 });
  assert.ok((await sync({ now: now + 3602e3 })).cleanup.blocked); assert.equal(camera.deletions.length, 0);
});

test('recovery preserves conflicting originals and rejects a linked recovery directory', async t => {
  const { camera, config, sync, dir, records } = await setup(t, 'mirror'); await sync();
  const file = (await records())[0]; camera.files.splice(0);
  await sync({ now: now + 1000 }); await sync({ now: now + 3602e3 });
  const item = Object.values((await readManifest(config.destination)).trash)[0];
  await fs.writeFile(inside(config.destination, file.path), 'preserve');
  await assert.rejects(restoreRecovery(config, item.id), /already exists/);
  assert.equal(await fs.readFile(inside(config.destination, file.path), 'utf8'), 'preserve');
  await fs.unlink(inside(config.destination, file.path));
  const recovery = path.join(config.destination, '.insta360-sync/recovery');
  const moved = path.join(dir, 'moved-recovery'); await fs.rename(recovery, moved);
  await fs.symlink(moved, recovery, 'junction');
  await assert.rejects(restoreRecovery(config, item.id), /symbolic link/);
  await fs.unlink(recovery);
});
