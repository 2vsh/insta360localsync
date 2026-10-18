import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseCalibration, readCalibration, projectLens, lensTransforms } from '../lib/stitch.mjs';
import { MediaLibrary } from '../lib/media.mjs';
import { atomicJson } from '../lib/sync.mjs';

const varint = number => { const bytes = []; do { bytes.push((number & 127) | (number >= 128 ? 128 : 0)); number = Math.floor(number / 128); } while (number); return Buffer.from(bytes); };
const field = (tag, value) => typeof value === 'number' ? Buffer.concat([varint(tag * 8), varint(value)]) : Buffer.concat([varint(tag * 8 + 2), varint(Buffer.byteLength(value)), Buffer.from(value)]);
function offset(version = 6, type = 113) {
  const lenses = [[2, 210, 207, 121, 126], [2, 215, 211, 388, 130]].map(a => [...a, 0, -90, 0, 0, 0, 0, ...Array(version === 6 ? 13 : 5).fill(0), 512, 256, type]);
  return [2, ...lenses.flat(), version * 65536 + 1024].join('_');
}
const metadata = (extra = [], order = 1) => Buffer.concat([field(80, order), field(111, offset()), ...extra]);
const double = value => { const bytes = Buffer.alloc(8); bytes.writeDoubleLE(value); return Buffer.concat([varint(17), bytes]); };
function guardProfiles(target = [0, .0104, 0, 0, 0, 0]) {
  const records = [['bare', [0, .01, 0, 0, 0, 0]], ['ProtectorS', target], ['bare', [200]], ['ProtectorS', [195]]];
  return field(145, Buffer.concat(records.map(([name, values]) => field(1, Buffer.concat([field(1, name), ...values.map(double)])))));
}
const cropField = (sw = 256, dw = 240) => field(27, Buffer.concat([field(1, sw), field(2, sw), field(3, dw), field(4, dw), field(5, 0), field(6, 0)]));
const guardMetadata = () => [field(68, 5), cropField(), guardProfiles()];
function trailer(data) {
  const footer = Buffer.alloc(6); footer[0] = 1; footer[1] = 1; footer.writeUInt32LE(data.length, 2);
  const header = Buffer.alloc(72); header.writeUInt32LE(data.length + 6 + 72, 32); header.writeUInt32LE(3, 36); header.write('8db42d694ccc418790edff439fe026bf', 40);
  const box = Buffer.alloc(8); box.writeUInt32BE(8 + data.length + 6 + 72); box.write('inst', 4);
  return Buffer.concat([box, data, footer, header]);
}
async function temporary(t) {
  const root = path.resolve('.test-data'); await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'stitch-'));
  t.after(async () => { assert.ok(path.relative(root, dir) && !path.relative(root, dir).startsWith('..')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('calibration reads only the current supported offset, validates ordering, and rejects malformed metadata', () => {
  const calibration = parseCalibration(metadata());
  assert.equal(calibration.version, 6); assert.equal(calibration.reverse, true); assert.equal(calibration.blend, 190);
  assert.equal(calibration.lenses[1].cx, 388);
  assert.equal(parseCalibration(metadata([], 2)).reverse, false);
  assert.equal(parseCalibration(metadata([], 0)), null);
  assert.equal(parseCalibration(metadata([], 0), { separate: true }).reverse, false);
  assert.equal(parseCalibration(Buffer.concat([field(80, 2), field(54, offset(3))])).version, 3);
  for (const invalid of [
    Buffer.from([0xff]), Buffer.from([0]), Buffer.concat([field(80, 1), field(80, 2), field(111, offset())]),
    Buffer.concat([field(80, 1), field(111, offset().replace('210', 'NaN'))]),
    Buffer.concat([field(80, 1), field(111, offset(6, 117)), field(54, offset(3)), field(112, offset())]),
    Buffer.concat([field(80, 1), field(111, offset().replace('394240', '197632'))]),
    Buffer.concat([field(80, '1'), field(111, offset())]),
  ]) assert.equal(parseCalibration(invalid), null);
  const transforms = lensTransforms(calibration);
  assert.ok(transforms[0].every((x, i) => Math.abs(x - (i % 4 === 0 ? 1 : 0)) < 1e-12));
  assert.ok(Math.abs(transforms[1][0] + 1) < 1e-12 && Math.abs(transforms[1][8] + 1) < 1e-12);
  assert.equal(projectLens(calibration.lenses[0], 0, transforms[0], [0, 0, -1], 256), null);
  assert.equal(projectLens(calibration.lenses[0], 0, transforms[0], [0, 0, 1], 256).x, 121);
  // Independent numeric oracle for radial, tangential and thin-prism slots.
  const lens = { ...calibration.lenses[0], coefficients: [.1, .2, .3, .4, .5, .006, -.007, .008, -.009, .01, -.02, .03, -.04] };
  const sample = projectLens(lens, 0, transforms[0], [.6, 0, .8], 256);
  const u = .6 / 2.8, r = u * u;
  const radial = 1 + .1 * r + .2 * r ** 2 + .3 * r ** 3 + .4 * r ** 4 + .5 * r ** 5;
  assert.ok(Math.abs(sample.x - (121 + 210 * (u * radial + (.006 + .008 * r) * 3 * r + .01 * r + .03 * r * r))) < 1e-10);
  assert.ok(Math.abs(sample.y - (126 + 207 * ((-.007 - .009 * r) * r - .02 * r - .04 * r * r))) < 1e-10);
});

test('recorded guard profiles and crop change the physical projection; unsupported optics never masquerade as bare lenses', () => {
  const calibration = parseCalibration(metadata(guardMetadata()));
  assert.equal(calibration.optics.name, 'ProtectorS'); assert.equal(calibration.optics.fov, 195); assert.equal(calibration.cropped, true);
  assert.equal(calibration.lenses[0].width, 480); assert.equal(calibration.lenses[0].cx, 113); assert.equal(calibration.lenses[1].cx, 364);
  const sample = projectLens(calibration.lenses[0], 0, lensTransforms(calibration)[0], [.6, 0, .8], 256, 190, calibration.optics);
  assert.ok(Math.abs(sample.x - ((121 - 8) + 210 * (.6 / 2.8) * 1.04) * 256 / 240) < 1e-9);
  assert.ok(Math.abs(sample.y - (126 - 8) * 256 / 240) < 1e-9);
  assert.equal(parseCalibration(metadata([field(68, 6), field(104, 2), guardProfiles()])).optics.name, 'ProtectorS');
  assert.equal(parseCalibration(metadata([field(68, 6), field(104, 3)])).optics.name, 'bare');
  // A crop already represented in the native canvas must not be applied twice.
  assert.equal(parseCalibration(metadata([cropField(272, 256)])).cropped, false);
  for (const extra of [
    [field(68, 5)], [field(68, 2), guardProfiles()], [field(68, 6), field(104, 0), guardProfiles()],
    [field(68, 5), guardProfiles([0, NaN, 0, 0, 0, 0])], [field(68, 5), guardProfiles([0, -.01, 0, 0, 0, 0])],
    [field(68, 5), guardProfiles([0, .02, 0, 0, 0, 0])], [field(68, 5), guardProfiles(), guardProfiles()],
    [cropField(240, 256)], [field(27, Buffer.from([255]))],
    [field(68, '0')], [field(128, '190')],
    [field(27, Buffer.concat([field(1, 256), field(1, 256), ...[2, 3, 4].map(tag => field(tag, 240))]))],
    [field(27, Buffer.concat([field(1, '256'), ...[2, 3, 4].map(tag => field(tag, 240))]))],
  ]) assert.equal(parseCalibration(metadata(extra)), null);
});

test('explicit guard correction off uses bare geometry without discarding native calibration or crop', () => {
  const encoded = metadata(guardMetadata()), enabled = parseCalibration(encoded), bare = parseCalibration(encoded, { lensGuardCorrection: false });
  assert.equal(bare.optics.name, 'bare'); assert.equal(bare.cropped, true);
  assert.deepEqual(bare.lenses, enabled.lenses); assert.equal(bare.reverse, enabled.reverse);
  const sample = projectLens(bare.lenses[0], 0, lensTransforms(bare)[0], [.6, 0, .8], 256, 190, bare.optics);
  assert.ok(Math.abs(sample.x - ((121 - 8) + 210 * (.6 / 2.8)) * 256 / 240) < 1e-9);
  assert.deepEqual(parseCalibration(metadata()), parseCalibration(metadata(), { lensGuardCorrection: false }), 'on does not invent guards for bare footage');
  assert.equal(parseCalibration(metadata([field(68, 5)]), { lensGuardCorrection: false }).optics.name, 'bare', 'off explicitly bypasses unavailable guard data');
  assert.equal(parseCalibration(Buffer.concat([field(80, 1), field(111, offset(6, 117)), field(54, offset(3))]), { lensGuardCorrection: false }), null, 'off never falls back to stale native offsets');
});

test('bounded trailer reader ignores corrupt lengths and preserves the original', async t => {
  const dir = await temporary(t), filename = path.join(dir, 'fixture.insv'), bytes = Buffer.concat([Buffer.alloc(32), trailer(metadata())]);
  await fs.writeFile(filename, bytes); assert.equal((await readCalibration(filename)).version, 6);
  assert.deepEqual(await fs.readFile(filename), bytes);
  const corrupt = Buffer.from(bytes); corrupt.writeUInt32LE(0xffffffff, corrupt.length - 40);
  await fs.writeFile(filename, corrupt); assert.equal(await readCalibration(filename), null);
  await fs.writeFile(filename, bytes.subarray(0, 100)); assert.equal(await readCalibration(filename), null);
  await fs.writeFile(filename, Buffer.concat([Buffer.alloc(32), trailer(Buffer.from([0xff]))])); assert.equal(await readCalibration(filename), null);
});

const available = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 && spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-filter_complex_threads', '2', ...args], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr?.toString()); return result.stdout;
}
for (const guarded of [false, true]) test(`calibrated FFmpeg stitch reconstructs both seams with reversed tracks, unequal lenses${guarded ? ', guards and sensor crop' : ''}`, { skip: !available, timeout: 90000 }, async t => {
  const dir = await temporary(t), destination = path.join(dir, 'originals'); await fs.mkdir(destination);
  const calibration = parseCalibration(metadata());
  // Invert the ideal unified camera model analytically to draw a known RGB sphere
  // into each sensor. Its unequal principal points/focal lengths catch the old
  // generic dfisheye mapping. The decoded panorama must recover that sphere.
  for (let i = 0; i < 2; i++) {
    const lens = calibration.lenses[i], pixels = Buffer.alloc(256 * 256 * 3);
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      // Independent source-image construction: crop 8 px from each edge of the
      // 256 px native sensor, then resize to 256; guards expand radii by 4%.
      const sensorX = guarded ? x * 240 / 256 + 8 : x, sensorY = guarded ? y * 240 / 256 + 8 : y, magnification = guarded ? 1.04 : 1;
      const u = (sensorX + i * 256 - lens.cx) / (lens.fx * magnification), v = (sensorY - lens.cy) / (lens.fy * magnification), r = u * u + v * v, discriminant = 1 - 3 * r;
      if (discriminant < 0) continue;
      const z = (-2 * r + Math.sqrt(discriminant)) / (1 + r), sign = i ? -1 : 1;
      const ray = [sign * u * (z + 2), v * (z + 2), sign * z];
      for (let channel = 0; channel < 3; channel++) pixels[(y * 256 + x) * 3 + channel] = Math.round(128 + 100 * ray[channel]);
    }
    await fs.writeFile(path.join(dir, `lens${i}.ppm`), Buffer.concat([Buffer.from('P6\n256 256\n255\n'), pixels]));
  }
  const filename = path.join(destination, 'calibrated.insv');
  ffmpeg(['-loop', '1', '-i', path.join(dir, 'lens1.ppm'), '-loop', '1', '-i', path.join(dir, 'lens0.ppm'), '-map', '0:v', '-map', '1:v', '-t', '0.4', '-r', '5', '-c:v', 'libx264', '-crf', '12', '-threads', '2', '-pix_fmt', 'yuv420p', '-f', 'mp4', filename]);
  await fs.appendFile(filename, trailer(metadata(guarded ? guardMetadata() : [])));
  const original = await fs.readFile(filename), stat = await fs.stat(filename), id = 'c'.repeat(64);
  await atomicJson(path.join(destination, '.insta360-sync', 'manifest.json'), { version: 1, files: { [id]: { id, name: 'calibrated.insv', path: 'calibrated.insv', size: stat.size, mtimeMs: stat.mtimeMs, sha256: id } } });
  const media = new MediaLibrary({ destination: () => destination, cacheDir: path.join(dir, 'cache') }); t.after(() => media.close());
  async function complete(job) {
    const deadline = Date.now() + 60000;
    while (['queued', 'running'].includes(job.status) && Date.now() < deadline) { await new Promise(r => setTimeout(r, 50)); job = media.job(job.id); }
    assert.equal(job.status, 'complete', job.error || 'render must finish without waiting for looped map inputs'); return job.result;
  }
  assert.equal((await complete(await media.inspect(id))).stitch, 'calibrated');
  const info = await complete(await media.prepare(id)); assert.equal(info.stitch, 'calibrated');
  assert.equal(info.calibration.optics.name, guarded ? 'ProtectorS' : 'bare'); assert.equal(info.calibration.cropped, guarded);
  const asset = await media.asset(id, 'preview');
  const rgb = ffmpeg(['-i', asset.filename, '-vf', 'scale=720:360', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  let error = 0, count = 0, seamError = 0;
  for (let y = 12; y < 348; y += 7) for (let x = 0; x < 720; x += 3) {
    const lon = (x + .5) / 720 * 2 * Math.PI - Math.PI, lat = Math.PI / 2 - (y + .5) / 360 * Math.PI;
    const ray = [Math.cos(lat) * Math.sin(lon), -Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    const e = ray.reduce((sum, value, channel) => sum + Math.abs(rgb[(y * 720 + x) * 3 + channel] - (128 + 100 * value)), 0) / 3;
    error += e; count++;
    if (Math.abs(Math.abs(lon) - Math.PI / 2) < .08) seamError = Math.max(seamError, e);
  }
  assert.ok(error / count < 3, `mean RGB error ${error / count}`);
  assert.ok(seamError < 8, `seam RGB error ${seamError}`);
  const take = await complete(await media.export(id, { start: 0, end: .3, quality: '720', frames: [{ time: 0, yaw: 90, pitch: 76, roll: 0, fov: 90 }, { time: .3, yaw: 90, pitch: 76, roll: 0, fov: 90 }] }));
  const exported = await media.asset(id, 'exports', new URL(take.url, 'http://localhost').pathname.split('/').at(-1)); ffmpeg(['-i', exported.filename, '-f', 'null', '-']);
  assert.deepEqual(await fs.readFile(filename), original);
});

test('overlap alignment reduces parallax from separated camera centers in the actual FFmpeg pipeline', { skip: !available, timeout: 90000 }, async t => {
  const dir = await temporary(t), destination = path.join(dir, 'originals'); await fs.mkdir(destination);
  const calibration = parseCalibration(metadata());
  const color = ray => [
    128 + 55 * Math.sin(29 * ray[0] + 19 * ray[1]) + 45 * Math.cos(23 * ray[2] - 17 * ray[1]),
    128 + 55 * Math.sin(23 * ray[1] + 21 * ray[2]) + 45 * Math.cos(27 * ray[0] + 13 * ray[1]),
    128 + 60 * Math.cos(17 * ray[0] - 25 * ray[2]),
  ];
  // Ray/sphere intersection from two distinct camera centers. This source does
  // not use the stitch projection or matcher to construct the displaced scene.
  for (let i = 0; i < 2; i++) {
    const lens = calibration.lenses[i], pixels = Buffer.alloc(256 * 256 * 3), centerZ = i ? -.015 : .015;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const u = (x + i * 256 - lens.cx) / lens.fx, v = (y - lens.cy) / lens.fy, r = u * u + v * v, discriminant = 1 - 3 * r;
      if (discriminant < 0) continue;
      const z = (-2 * r + Math.sqrt(discriminant)) / (1 + r), sign = i ? -1 : 1, ray = [sign * u * (z + 2), v * (z + 2), sign * z];
      const distance = -centerZ * ray[2] + Math.sqrt((centerZ * ray[2]) ** 2 + 1 - centerZ ** 2);
      const point = ray.map((component, axis) => component * distance + (axis === 2 ? centerZ : 0));
      color(point).forEach((value, channel) => { pixels[(y * 256 + x) * 3 + channel] = Math.round(value); });
    }
    await fs.writeFile(path.join(dir, `parallax${i}.ppm`), Buffer.concat([Buffer.from('P6\n256 256\n255\n'), pixels]));
  }
  const filename = path.join(destination, 'parallax.insv');
  ffmpeg(['-loop', '1', '-i', path.join(dir, 'parallax1.ppm'), '-loop', '1', '-i', path.join(dir, 'parallax0.ppm'), '-map', '0:v', '-map', '1:v', '-t', '0.4', '-r', '10', '-c:v', 'libx264', '-crf', '10', '-threads', '2', '-pix_fmt', 'yuv420p', '-f', 'mp4', filename]);
  await fs.appendFile(filename, trailer(metadata()));
  const original = await fs.readFile(filename), stat = await fs.stat(filename), id = 'd'.repeat(64);
  await atomicJson(path.join(destination, '.insta360-sync', 'manifest.json'), { version: 1, files: { [id]: { id, name: 'parallax.insv', path: 'parallax.insv', size: stat.size, mtimeMs: stat.mtimeMs, sha256: id } } });
  const media = new MediaLibrary({ destination: () => destination, cacheDir: path.join(dir, 'cache') }); t.after(() => media.close());
  const source = await media.source(id), info = await media.probe(source), rendering = await media.rendering(source, info);
  const unaligned = path.join(dir, 'unaligned.png');
  ffmpeg([...rendering.inputs, '-filter_complex', rendering.graph, '-map', '[out]', '-frames:v', '1', unaligned]);
  let job = await media.prepare(id);
  for (let i = 0; i < 600 && ['queued', 'running'].includes(job.status); i++) { await new Promise(r => setTimeout(r, 50)); job = media.job(job.id); }
  assert.equal(job.status, 'complete', job.error); assert.equal(job.result.alignment, 'local');
  const aligned = (await media.asset(id, 'preview')).filename;
  const error = file => {
    const width = 720, height = 360, rgb = ffmpeg(['-i', file, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
    let sum = 0, count = 0;
    // Both seams, including the directions that cross the panorama's poles.
    for (let y = 10; y < height - 10; y += 2) for (const center of [180, 540]) for (let x = center - 3; x <= center + 3; x++) {
      const lon = (x + .5) / width * 2 * Math.PI - Math.PI, lat = Math.PI / 2 - (y + .5) / height * Math.PI;
      const expected = color([Math.cos(lat) * Math.sin(lon), -Math.sin(lat), Math.cos(lat) * Math.cos(lon)]);
      expected.forEach((value, channel) => { sum += Math.abs(value - rgb[(y * width + x) * 3 + channel]); count++; });
    }
    return sum / count;
  };
  const before = error(unaligned), after = error(aligned);
  t.diagnostic(`Mean seam RGB error: ${before.toFixed(2)} before, ${after.toFixed(2)} after alignment`);
  assert.ok(after < before * .8, `seam RGB error improves from ${before} to ${after}`);
  assert.deepEqual(await fs.readFile(filename), original);
});
