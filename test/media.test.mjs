import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { MediaLibrary, validateCut, cutCommands } from '../lib/media.mjs';
import { validateConfig, atomicJson } from '../lib/sync.mjs';
import { samplePath, viewMatrix } from '../public/view-path.js';
import { Viewer } from '../public/viewer.js';

const testRoot = path.resolve('.test-data');
async function temporary(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'media-'));
  t.after(async () => { const relative = path.relative(testRoot, dir); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
const frame = (time, yaw = 0, pitch = 0, roll = 0, fov = 90) => ({ time, yaw, pitch, roll, fov });
test('director paths cross the 180-degree seam smoothly and reject incomplete or unsafe takes', () => {
  const frames = [frame(2, 170, 10, 175, 80), frame(4, -170, 30, -175, 40)];
  assert.deepEqual(samplePath(frames, 3), frame(3, -180, 20, -180, 60));
  // Replaying stores a sampled time in the view; a new take must use its own clock.
  const recorder = { frames: [], view: samplePath(frames, 3), range: { start: 2, end: 4 } };
  Viewer.prototype.capture.call(recorder, true, 2);
  Viewer.prototype.capture.call(recorder, false, 2.2);
  assert.deepEqual(recorder.frames.map(sample => sample.time), [2, 2.2]);
  const cut = validateCut({ start: 2, end: 4, frames, aspect: '9:16', quality: '720' }, 8);
  assert.equal(cut.width, 720); assert.equal(cut.height, 1280);
  assert.match(cutCommands(cut), /v360@camera yaw/); assert.match(cutCommands(cut), /v360@camera h_fov/);
  for (const input of [
    { start: -1 }, { end: 20 }, { start: 4, end: 2 }, { frames: [frame(3), frame(4)] },
    { frames: [frame(2), frame(2)] }, { frames: [frame(2, NaN), frame(4)] }, { frames: [frame(2, 0, 95), frame(4)] },
    { quality: '9999' }, { aspect: 'script' }, { frames: [frame(2, 0, 0, 0, 180), frame(4)] },
  ]) assert.throws(() => validateCut({ start: 2, end: 4, frames, ...input }, 8));
  // This is the coordinate convention shared with FFmpeg, checked at cardinal views.
  const yaw = viewMatrix(frame(0, 90)), pitch = viewMatrix(frame(0, 0, 90));
  assert.ok(Math.abs(yaw[6] - 1) < 1e-6 && Math.abs(yaw[8]) < 1e-6);
  assert.ok(Math.abs(pitch[7] + 1) < 1e-6 && Math.abs(pitch[8]) < 1e-6);
});

test('media source lookup is limited to unchanged manifest entries and rejects links outside the destination', async t => {
  const dir = await temporary(t), destination = path.join(dir, 'originals'); await fs.mkdir(destination);
  const id = 'a'.repeat(64), filename = path.join(destination, 'clip.mp4'), data = Buffer.from('fixture'); await fs.writeFile(filename, data);
  const record = { id, name: 'clip.mp4', path: 'clip.mp4', size: data.length, sha256: id, mtimeMs: (await fs.stat(filename)).mtimeMs };
  const save = entry => atomicJson(path.join(destination, '.insta360-sync', 'manifest.json'), { version: 1, files: { [id]: entry } });
  await save(record); const media = new MediaLibrary({ destination: () => destination, cacheDir: path.join(dir, 'cache') }); t.after(() => media.close());
  assert.equal((await media.source(id)).filename, await fs.realpath(filename));
  await assert.rejects(media.source('b'.repeat(64)), /no longer/);
  await assert.rejects(media.source('../clip.mp4'), /Invalid/);
  await fs.appendFile(filename, 'changed'); await assert.rejects(media.source(id), /changed or is missing/);
  const outside = path.join(dir, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'clip.mp4'), data);
  const link = path.join(destination, 'link'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await save({ ...record, path: 'link/clip.mp4', mtimeMs: undefined }); await assert.rejects(media.source(id), /escapes/);
});

const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { windowsHide: true, maxBuffer: 8e6 });
  assert.equal(result.status, 0, String(result.stderr)); return result.stdout;
}
function probe(filename) { const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { windowsHide: true }); assert.equal(result.status, 0, String(result.stderr)); return JSON.parse(result.stdout); }
async function wait(url, initial) {
  let job = initial;
  for (let i = 0; i < 600; i++) {
    if (job.status === 'complete') return job.result;
    assert.ok(!['failed', 'cancelled'].includes(job.status), job.error);
    await new Promise(resolve => setTimeout(resolve, 100)); job = await (await fetch(`${url}/api/jobs/${job.id}`)).json();
  }
  throw new Error('Media job timed out.');
}

test('real FFmpeg pipeline prepares dual lenses and renders a trimmed MP4 with audio, guarded seeking and download', { skip: !ffmpegAvailable, timeout: 120000 }, async t => {
  const dir = await temporary(t), destination = path.join(dir, 'originals'); await fs.mkdir(destination);
  const filename = path.join(destination, 'dual.insv');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=30', '-f', 'lavfi', '-i', 'color=c=blue:size=128x128:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-map', '0:v', '-map', '1:v', '-map', '2:a', '-t', '1.2', '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', '-f', 'mp4', filename]);
  const stat = await fs.stat(filename), id = createHash('sha256').update('synthetic dual lens').digest('hex');
  await atomicJson(path.join(destination, '.insta360-sync', 'manifest.json'), { version: 1, files: { [id]: { id, name: 'dual.insv', path: 'dual.insv', size: stat.size, sha256: id, mtimeMs: stat.mtimeMs, savedAt: new Date().toISOString() } } });
  const app = await createApp(validateConfig({ destination }), { quiet: true, configFile: path.join(dir, 'config.json'), mediaDir: path.join(dir, 'cache') }); t.after(() => app.close());
  const url = await app.listen(0), status = await (await fetch(url + '/api/status')).json(), token = status.token;
  const post = async (route, data = {}) => { const res = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token }, body: JSON.stringify(data) }); const body = await res.json(); assert.ok(res.ok, body.error); return body; };
  const root = `/api/media/${id}`;
  assert.equal((await fetch(url + root + '/prepare', { method: 'POST' })).status, 403);
  const info = await wait(url, await post(root + '/inspect')); assert.equal(info.dual, true); assert.equal(info.projection, 'equirect');
  const thumbnail = await fetch(url + info.thumbnail + '?token=' + token); assert.equal(thumbnail.headers.get('content-type'), 'image/jpeg'); assert.ok((await thumbnail.arrayBuffer()).byteLength > 100);
  const preview = await wait(url, await post(root + '/prepare')); assert.equal(preview.audio, true);
  assert.equal((await fetch(url + preview.url)).status, 403);
  assert.equal((await fetch(url + preview.url + '?token=' + token, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const head = await fetch(url + preview.url + '?token=' + token, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('accept-ranges'), 'bytes');
  const whole = Buffer.from(await (await fetch(url + preview.url + '?token=' + token)).arrayBuffer());
  const range = await fetch(url + preview.url + '?token=' + token, { headers: { Range: 'bytes=5-31' } }); assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), whole.subarray(5, 32));
  const suffix = await fetch(url + preview.url + '?token=' + token, { headers: { Range: 'bytes=-17' } }); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), whole.subarray(-17));
  for (const range of ['bytes=999999999-', 'bytes=8-3', 'bytes=0-1,3-4', 'bytes=-0']) assert.equal((await fetch(url + preview.url + '?token=' + token, { headers: { Range: range } })).status, 416);
  const cut = { start: .2, end: .8, aspect: '9:16', quality: '720', frames: [frame(.2), frame(.5, 20, 10, 5, 70), frame(.8, 40, 20, 10, 50)] };
  const exported = await wait(url, await post(root + '/export', cut)); assert.equal(exported.width, 720); assert.equal(exported.height, 1280);
  const response = await fetch(url + exported.url + '?token=' + token); assert.equal(response.status, 200); assert.match(response.headers.get('content-disposition'), /attachment/);
  const output = path.join(dir, 'download.mp4'); await fs.writeFile(output, Buffer.from(await response.arrayBuffer()));
  const metadata = probe(output), video = metadata.streams.find(s => s.codec_type === 'video'), audio = metadata.streams.find(s => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264'); assert.equal(video.width, 720); assert.equal(video.height, 1280); assert.equal(audio.codec_name, 'aac'); assert.ok(Math.abs(Number(metadata.format.duration) - .6) < .06);
  ffmpeg(['-xerror', '-i', output, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
  // At output frame 9 the view must match source time .5. This catches
  // accumulated rotations, missed commands, trim offsets, and stretched zooms.
  const cache = path.join(dir, 'cache', (await fs.readdir(path.join(dir, 'cache')))[0], 'preview.mp4');
  const rendered = ffmpeg(['-ss', '0.3', '-i', output, '-frames:v', '1', '-vf', 'scale=180:320', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  const reference = ffmpeg(['-ss', '0.5', '-i', cache, '-frames:v', '1', '-vf', 'v360=equirect:flat:w=720:h=1280:h_fov=70:yaw=20:pitch=10:roll=5:rorder=ypr,scale=180:320', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  assert.equal(rendered.length, reference.length);
  const error = rendered.reduce((sum, value, index) => sum + Math.abs(value - reference[index]), 0) / rendered.length;
  assert.ok(error < 6, `The exported movement differs from the selected view: mean RGB error ${error.toFixed(2)}`);
  const invalid = await fetch(url + root + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Token': token }, body: JSON.stringify({ ...cut, frames: [] }) }); assert.equal(invalid.status, 400);
  assert.equal((await fetch(url + '/originals/dual.insv')).status, 404);
  assert.equal((await fs.stat(filename)).size, stat.size, 'the original is untouched');
});

test('browser projection math agrees with FFmpeg for combined pan, tilt, rotation and zoom', { skip: !ffmpegAvailable }, () => {
  const width = 160, height = 90, view = frame(0, 35, 20, 12, 70), matrix = viewMatrix(view);
  const pixels = ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=1024x512,format=gbrp,geq=r='255*X/W':g='255*Y/H':b=64", '-vf', `v360=equirect:flat:w=${width}:h=${height}:h_fov=70:yaw=35:pitch=20:roll=12:rorder=ypr`, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  for (let y = 10; y < height - 10; y += 20) for (let x = 10; x < width - 10; x += 30) {
    const tangent = Math.tan(view.fov * Math.PI / 360);
    const ray = [(2 * (x + .5) / width - 1) * tangent, (2 * (y + .5) / height - 1) * tangent * height / width, 1];
    const rotated = [0, 1, 2].map(i => matrix[i] * ray[0] + matrix[i + 3] * ray[1] + matrix[i + 6]);
    const uv = [Math.atan2(rotated[0], rotated[2]) / (2 * Math.PI) + .5, Math.asin(rotated[1] / Math.hypot(...rotated)) / Math.PI + .5];
    for (let channel = 0; channel < 2; channel++) assert.ok(Math.abs(pixels[(y * width + x) * 3 + channel] - uv[channel] * 255) < 4, 'Viewer and export must use the same camera direction and lens shape.');
  }
});

test('photos, standard video and separate lens pairs prepare locally; cancellation leaves originals intact', { skip: !ffmpegAvailable, timeout: 120000 }, async t => {
  const dir = await temporary(t), destination = path.join(dir, 'originals'); await fs.mkdir(destination);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=30', '-t', '0.6', '-c:v', 'libx264', '-threads', '2', path.join(destination, 'flat.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=256x128', '-frames:v', '1', '-update', '1', path.join(destination, 'photo.jpg')]);
  for (const name of ['VID_fixture_00_001.insv', 'VID_fixture_10_001.insv']) ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=128x128:r=30', '-t', '0.6', '-c:v', 'libx264', '-threads', '2', '-f', 'mp4', path.join(destination, name)]);
  await fs.writeFile(path.join(destination, 'broken.insv'), 'invalid camera file');
  const records = {};
  for (const name of await fs.readdir(destination)) { const stat = await fs.stat(path.join(destination, name)), id = createHash('sha256').update(name).digest('hex'); records[id] = { id, name, path: name, size: stat.size, sha256: id, mtimeMs: stat.mtimeMs }; }
  await atomicJson(path.join(destination, '.insta360-sync', 'manifest.json'), { version: 1, files: records });
  const media = new MediaLibrary({ destination: () => destination, cacheDir: path.join(dir, 'cache') }); t.after(() => media.close());
  const id = name => Object.values(records).find(r => r.name === name).id;
  const wait = async job => {
    for (let i = 0; i < 600; i++) { const state = media.job(job.id); if (state.status === 'complete') return state.result; if (['failed', 'cancelled'].includes(state.status)) throw new Error(state.error); await new Promise(r => setTimeout(r, 50)); }
    throw new Error('Media job timed out.');
  };
  const photo = await wait(await media.prepare(id('photo.jpg'))); assert.equal(photo.image, true); assert.equal(photo.projection, 'equirect');
  const flat = await wait(await media.prepare(id('flat.mp4'))); assert.equal(flat.projection, 'flat'); assert.equal(flat.audio, false);
  const dual = await wait(await media.prepare(id('VID_fixture_00_001.insv'))); assert.equal(dual.dual, true); assert.equal(dual.separate, true);
  await assert.rejects(wait(await media.prepare(id('broken.insv'))), /could not be decoded/);
  const cut = { start: 0, end: .5, frames: [frame(0), frame(.5, 10, 5, 10, 70)], quality: '720' };
  const exported = await wait(await media.export(id('flat.mp4'), cut));
  const asset = await media.asset(id('flat.mp4'), 'exports', exported.url.split('/').at(-1));
  assert.equal(probe(asset.filename).streams.filter(s => s.codec_type === 'audio').length, 0);
  const job = await media.export(id('flat.mp4'), cut); media.cancel(job.id); await assert.rejects(wait(job), /Cancelled/);
  await assert.rejects(media.export(id('photo.jpg'), cut), /require a video/);
  for (const record of Object.values(records)) assert.equal((await fs.stat(path.join(destination, record.path))).size, record.size);
});
