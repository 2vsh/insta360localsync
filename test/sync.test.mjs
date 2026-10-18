import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createMockCamera } from '../lib/mock-camera.mjs';
import { validateConfig, runSync, readManifest, normalizeEntry, lockDestination, inside, request } from '../lib/sync.mjs';
import { createApp } from '../server.mjs';

const testRoot = path.resolve('.test-data');
async function setup(t, options = {}) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'sync-'));
  const camera = await createMockCamera(options);
  const config = validateConfig({ cameraUrl: camera.url, destination: path.join(dir, 'footage'), pageSize: 2, requestTimeoutSeconds: 2 });
  t.after(async () => {
    await camera.close();
    const relative = path.relative(testRoot, path.resolve(dir));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup must stay inside .test-data');
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, camera, config };
}
async function exists(filename) { try { await fs.stat(filename); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
const fixture = { name: 'VID_20261018_120000_00_001.insv', data: Buffer.alloc(512 * 1024, 93) };

test('backs up exact bytes, keeps lens pairs together, skips proxies, and re-downloads only missing files', async t => {
  const { camera, config } = await setup(t);
  const result = await runSync(config);
  assert.deepEqual(result, { listed: 3, skipped: 0, downloaded: 3, failed: 0, bytes: 1441792 });
  const records = Object.values((await readManifest(config.destination)).files);
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await fs.readFile(inside(config.destination, record.path)), camera.files.find(f => f.name === record.name).data);
  }
  assert.equal(path.dirname(records[0].path), path.dirname(records[1].path));
  assert.equal(records[0].name, 'VID_20261018_120000_00_001.insv');
  const downloads = camera.requests.filter(r => r.path.startsWith('/DCIM/')).length;
  assert.equal((await runSync(config)).skipped, 3);
  assert.equal(camera.requests.filter(r => r.path.startsWith('/DCIM/')).length, downloads);
  await fs.unlink(inside(config.destination, records[0].path));
  assert.equal((await runSync(config)).downloaded, 1);
  assert.equal(camera.requests.filter(r => r.path.startsWith('/DCIM/')).length, downloads + 1);
  assert.ok(camera.requests.every(r => !r.path.includes('delete')));
});

test('interrupted downloads are not published and resume from the exact saved offset', async t => {
  const { camera, config } = await setup(t, { files: [fixture], controls: { interruptOnce: true } });
  assert.equal((await runSync(config)).failed, 1);
  assert.equal(Object.keys((await readManifest(config.destination)).files).length, 0);
  const partialDir = path.join(config.destination, '.insta360-sync', 'partials');
  const partial = path.join(partialDir, (await fs.readdir(partialDir))[0]);
  const have = (await fs.stat(partial)).size;
  assert.ok(have > 0 && have < fixture.data.length);
  assert.equal((await runSync(config)).downloaded, 1);
  assert.ok(camera.requests.some(r => r.range === `bytes=${have}-`));
  const record = Object.values((await readManifest(config.destination)).files)[0];
  assert.deepEqual(await fs.readFile(inside(config.destination, record.path)), fixture.data);
});

for (const mode of ['ignoreRange', 'wrongRange']) {
  test(`${mode}: restart a full response safely or reject a bad range without damaging the partial`, async t => {
    const { camera, config } = await setup(t, { files: [fixture], controls: { interruptOnce: true } });
    await runSync(config);
    const partialDir = path.join(config.destination, '.insta360-sync', 'partials');
    const part = path.join(partialDir, (await fs.readdir(partialDir))[0]);
    const before = await fs.readFile(part);
    camera.controls[mode] = true;
    const result = await runSync(config);
    if (mode === 'wrongRange') {
      assert.equal(result.failed, 1);
      assert.deepEqual(await fs.readFile(part), before);
      camera.controls.wrongRange = false;
      assert.equal((await runSync(config)).downloaded, 1);
    } else assert.equal(result.downloaded, 1);
    const record = Object.values((await readManifest(config.destination)).files)[0];
    assert.deepEqual(await fs.readFile(inside(config.destination, record.path)), fixture.data);
  });
}

test('supports nested firmware parameters and lists all pages', async t => {
  const { camera, config } = await setup(t, { nestedOnly: true });
  config.pageSize = 1;
  assert.equal((await runSync(config)).downloaded, 3);
  assert.equal(camera.requests.filter(r => r.command === 'camera.listFiles').length, 5);
});

test('rejects repeated pagination instead of silently losing files', async t => {
  const { config } = await setup(t, { controls: { repeatPage: true } });
  config.pageSize = 1;
  await assert.rejects(runSync(config), /pagination repeated/);
  assert.equal(Object.keys((await readManifest(config.destination)).files).length, 0);
});

test('preserves conflicting local files and can adopt a completed partial after the conflict is moved', async t => {
  const { config } = await setup(t, { files: [fixture] });
  const entry = normalizeEntry({ name: fixture.name, size: fixture.data.length, fileUrl: config.cameraUrl + '/DCIM/Camera01/' + fixture.name, dateTimeZone: '2026:10:18 12:00:00-05:00' }, config, { model: 'Insta360 X5', serialNumber: 'DEMO-X5' });
  const final = inside(config.destination, entry.path);
  await fs.mkdir(path.dirname(final), { recursive: true });
  await fs.writeFile(final, 'existing footage must survive');
  assert.equal((await runSync(config)).failed, 1);
  assert.equal(await fs.readFile(final, 'utf8'), 'existing footage must survive');
  assert.equal(Object.keys((await readManifest(config.destination)).files).length, 0);
  await fs.rename(final, final + '.saved-by-test');
  assert.equal((await runSync(config)).downloaded, 1);
  assert.deepEqual(await fs.readFile(final), fixture.data);
});

test('rechecks changed local bytes and preserves them instead of claiming a valid backup', async t => {
  const { config } = await setup(t, { files: [fixture] });
  await runSync(config);
  const record = Object.values((await readManifest(config.destination)).files)[0];
  const final = inside(config.destination, record.path);
  const changed = Buffer.alloc(fixture.data.length, 12);
  await fs.writeFile(final, changed);
  const later = new Date(Date.now() + 3000); await fs.utimes(final, later, later);
  const result = await runSync(config);
  assert.equal(result.failed, 1); assert.equal(result.skipped, 0);
  assert.deepEqual(await fs.readFile(final), changed);
});

test('a live destination lock rejects overlapping syncs and is not removed by the loser', async t => {
  const { config } = await setup(t);
  const release = lockDestination(config.destination);
  try {
    await assert.rejects(runSync(config), /Another sync owns/);
    assert.equal(await exists(path.join(config.destination, '.insta360-sync', 'sync.lock')), true);
  } finally { release(); }
  assert.equal((await runSync(config)).failed, 0);
});

test('recovers a lock from a dead local process, and leaves foreign-machine locks untouched', async t => {
  const { config } = await setup(t, { files: [fixture] });
  const filename = path.join(config.destination, '.insta360-sync', 'sync.lock');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const child = spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0);
  await fs.writeFile(filename, JSON.stringify({ pid: Number(child.stdout.trim()), host: os.hostname(), token: 'crashed-process' }));
  assert.equal((await runSync(config)).downloaded, 1);
  const foreign = JSON.stringify({ pid: 1, host: 'different-computer', token: 'foreign' });
  await fs.writeFile(filename, foreign);
  await assert.rejects(runSync(config), /Another sync owns/);
  assert.equal(await fs.readFile(filename, 'utf8'), foreign);
});

test('corrupt history fails closed and is left intact', async t => {
  const { config, camera } = await setup(t);
  const filename = path.join(config.destination, '.insta360-sync', 'manifest.json');
  await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, 'broken history');
  await assert.rejects(runSync(config), /history cannot be read/);
  assert.equal(await fs.readFile(filename, 'utf8'), 'broken history');
  assert.equal(camera.requests.length, 0);
});

test('rejects cross-host downloads, unsafe Windows names and paths, and bad configuration', () => {
  const config = validateConfig({});
  const entry = { name: 'test.insv', fileUrl: 'http://192.168.42.1/DCIM/test.insv', size: 12 };
  assert.throws(() => normalizeEntry({ ...entry, fileUrl: 'http://example.com/test.insv' }, config, {}), /different server/);
  for (const name of ['..\\test.insv', 'test.insv ', 'CON.insv', 'test:stream.insv']) {
    assert.throws(() => normalizeEntry({ ...entry, name }, config, {}), /unsafe Windows filename/);
  }
  assert.throws(() => normalizeEntry({ ...entry, size: undefined }, config, {}), /valid size/);
  assert.throws(() => inside(process.cwd(), '../outside.insv'), /escapes/);
  assert.throws(() => validateConfig({ cameraUrl: 'file:///C:/Windows' }));
  assert.throws(() => validateConfig({ intervalSeconds: 0 }));
});

test('a missing camera returns an error, releases its lock, and does not record a backup', async t => {
  const { camera, config } = await setup(t);
  await camera.close();
  await assert.rejects(runSync(config), /ECONNREFUSED/);
  assert.equal(Object.keys((await readManifest(config.destination)).files).length, 0);
  assert.equal(await exists(path.join(config.destination, '.insta360-sync', 'sync.lock')), false);
});

test('local web app serves controls, guards writes and Host headers, saves settings, and runs a real sync', async t => {
  const { config, dir } = await setup(t);
  const configFile = path.join(dir, 'config.json');
  const app = await createApp(config, { configFile, quiet: true });
  const url = await app.listen(0);
  try {
    assert.match(await (await fetch(url)).text(), /id="sync" class="primary">Sync now/);
    assert.equal((await fetch(url + '/app.js')).status, 200);
    let status = await (await fetch(url + '/api/status')).json();
    assert.equal(status.files.length, 0);
    const post = (route, body, headers = {}) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': status.token, ...headers }, body: JSON.stringify(body) });
    assert.equal((await post('/api/sync', {}, { 'X-Sync-Token': '' })).status, 403);
    assert.equal((await post('/api/sync', {}, { Origin: 'https://attacker.invalid' })).status, 403);
    const rebound = await request(url + '/api/status', { headers: { Host: 'attacker.invalid' } });
    assert.equal(rebound.statusCode, 403); rebound.resume();
    const next = { ...config, destination: path.join(dir, 'chosen folder with spaces'), intervalSeconds: 60 };
    assert.equal((await post('/api/config', next)).status, 200);
    assert.equal(JSON.parse(await fs.readFile(configFile, 'utf8')).destination, next.destination);
    assert.equal((await post('/api/sync', {})).status, 202);
    await app.waitForSync();
    status = await (await fetch(url + '/api/status')).json();
    assert.equal(status.running, false); assert.equal(status.files.length, 3); assert.equal(status.error, null);
    assert.ok(status.lastSuccess); assert.ok(status.logs.length > 3);
    assert.equal((await fetch(url + '/.insta360-sync/manifest.json')).status, 404);
    assert.equal((await fetch(url + '/DCIM/Camera01/test.insv')).status, 404);
  } finally { await app.close(); }
});

test('Windows launcher creates a separate profile and downloads into a Unicode folder with spaces', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const { dir, camera } = await setup(t);
  const destination = path.join(dir, 'footage café 日本語');
  const configFile = path.join(dir, 'launcher-profile.json');
  const launcher = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/Start-Sync.ps1'),
    '-Destination', destination, '-Config', configFile, '-CameraUrl', camera.url,
    '-NoBrowser', '-Once',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  launcher.stdout.on('data', c => { output += c; });
  launcher.stderr.on('data', c => { output += c; });
  const code = await new Promise((resolve, reject) => { launcher.on('error', reject); launcher.on('close', resolve); });
  assert.equal(code, 0, output);
  assert.match(output, /3 saved/);
  const settings = JSON.parse((await fs.readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(settings.destination, destination);
  assert.equal(settings.cameraUrl, camera.url);
  const manifest = await readManifest(destination);
  assert.equal(Object.keys(manifest.files).length, 3);
  for (const file of Object.values(manifest.files)) {
    assert.deepEqual(await fs.readFile(inside(destination, file.path)), camera.files.find(f => f.name === file.name).data);
  }
});
