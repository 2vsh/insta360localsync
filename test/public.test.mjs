import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPublic, contentReasons } from '../scripts/check-public.mjs';

const testRoot = path.resolve('.test-data');
function git(root, args) {
  const result = spawnSync('git', ['-C', root, '-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'fixture Git command failed');
}
async function repository(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, 'public-'));
  t.after(async () => {
    const relative = path.relative(testRoot, path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'cleanup must stay inside .test-data');
    await fs.rm(root, { recursive: true, force: true });
  });
  git(root, ['init', '--quiet']);
  await fs.copyFile('.gitignore', path.join(root, '.gitignore'));
  return root;
}
async function write(root, name, value) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), value);
}

test('publication ignores personal settings and media, but catches private files already in the index', async t => {
  const root = await repository(t);
  await write(root, 'README.md', 'Public source');
  await write(root, 'config.example.json', JSON.stringify({ cameraUrl: 'http://192.168.42.1', destination: './downloads' }));
  const privateFiles = [
    'config.json', 'config-office.json', 'other.local.json', '.local/profile.json', '.env', '.env.production',
    'key.pem', 'id_ed25519', 'outside/clip.INSV', 'outside/photo.insp', 'outside/clip.mp4', 'outside/raw.DNG',
    'outside/.insta360-sync/manifest.json', 'outside/DCIM/Camera01/unknown.dat', '.demo/result.json',
    '.test-data/launcher-config.json', '.playwright-mcp/snapshot.yml', 'activity.log', 'data.part',
  ];
  for (const filename of privateFiles) await write(root, filename, 'private fixture');
  const result = await checkPublic(root);
  assert.deepEqual(result.files.sort(), ['.gitignore', 'README.md', 'config.example.json']);
  assert.deepEqual(result.issues, []);
  git(root, ['add', '--force', '--', 'config.json', 'outside/clip.INSV']);
  const tracked = await checkPublic(root);
  assert.ok(tracked.issues.some(i => i.filename === 'config.json' && i.rule === 'local configuration'));
  assert.ok(tracked.issues.some(i => i.filename === 'outside/clip.INSV' && i.rule === 'media or transfer artifact'));
});

test('publication scans staged blobs even when a clean working copy replaces or removes them', async t => {
  const root = await repository(t);
  // Synthetic patterns are assembled so this test's source contains no token.
  const fake = ['gh', 'p_', 'x'.repeat(36)].join('');
  await write(root, 'sample.txt', fake);
  git(root, ['add', '--', 'sample.txt']);
  await write(root, 'sample.txt', 'No credential here');
  let result = await checkPublic(root);
  assert.ok(result.issues.some(i => i.filename === 'sample.txt' && i.source === 'Git index' && i.rule === 'GitHub credential'));
  assert.ok(!JSON.stringify(result.issues).includes(fake), 'findings must not reveal matching values');
  await fs.unlink(path.join(root, 'sample.txt'));
  result = await checkPublic(root);
  assert.ok(result.issues.some(i => i.source === 'Git index' && i.rule === 'GitHub credential'));
});

test('publication detects personal paths, runtime profiles and credentials without flagging generic camera examples', () => {
  const scan = (value, filename = 'sample.txt') => contentReasons(filename, Buffer.from(value));
  assert.deepEqual(scan('http://192.168.42.1; D:/Footage/X5; DEMO-X5'), []);
  assert.deepEqual(scan(JSON.stringify({ cameraUrl: 'http://192.168.42.1', destination: './downloads' }), 'config.example.json'), []);
  assert.ok(scan(JSON.stringify({ cameraUrl: 'http://192.168.42.1', destination: './downloads' }), 'unexpected-profile.json').includes('runtime configuration'));
  assert.ok(scan(['C:', 'Users', 'someone', 'Footage'].join('\\')).includes('personal Windows path'));
  assert.ok(scan(['', 'home', 'someone', 'footage'].join('/') + '/').includes('personal home path'));
  assert.ok(scan(['api', '_key', ' = "', 'x'.repeat(24), '"'].join('')).includes('literal credential'));
  assert.ok(scan(['-----BEGIN ', 'PRIVATE KEY-----'].join('')).includes('private key'));
  assert.ok(scan(['AK', 'IA', 'X'.repeat(16)].join('')).includes('AWS access key'));
  assert.ok(scan(['https://', 'user', ':', 'password', '@', 'example.invalid/'].join('')).includes('credential in URL'));
});
