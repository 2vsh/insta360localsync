import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmdirSync, openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const defaults = {
  cameraUrl: 'http://192.168.42.1', destination: './downloads', autoSync: false,
  intervalSeconds: 120, skipLrv: true, port: 8640, requestTimeoutSeconds: 30, pageSize: 100,
};
const hash = value => createHash('sha256').update(value).digest('hex');
const media = /\.(insv|insp|mp4|mov|jpg|jpeg|png|webm|lrv|dng|wav|m4a)$/i;
const noFile = error => error.code === 'ENOENT';

export function validateConfig(input, baseDir = process.cwd()) {
  const c = { ...defaults, ...input };
  const url = new URL(c.cameraUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Camera URL must be an HTTP(S) address, for example http://192.168.42.1.');
  }
  if (typeof c.destination !== 'string' || !c.destination.trim() || c.destination.includes('\0')) throw new Error('Choose a destination folder.');
  for (const [key, min, max] of [['intervalSeconds', 10, 86400], ['port', 1, 65535], ['requestTimeoutSeconds', 1, 600], ['pageSize', 1, 1000]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  if (typeof c.autoSync !== 'boolean' || typeof c.skipLrv !== 'boolean') throw new Error('autoSync and skipLrv must be true or false.');
  return { ...c, cameraUrl: url.origin, destination: path.resolve(baseDir, c.destination) };
}

export async function loadConfig(filename) {
  let raw;
  try { raw = JSON.parse((await fs.readFile(filename, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (e) { if (noFile(e)) raw = defaults; else throw new Error(`Cannot read ${filename}: ${e.message}`); }
  return validateConfig(raw, path.dirname(filename));
}

export async function atomicJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, filename);
  } finally { await fs.unlink(temp).catch(e => { if (!noFile(e)) throw e; }); }
}

// The manifest travels with the destination, so moving to another PC retains history.
export async function readManifest(destination) {
  const filename = path.join(destination, '.insta360-sync', 'manifest.json');
  try {
    const m = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (m.version !== 1 || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('Invalid manifest format');
    for (const item of Object.values(m.files)) {
      if (!item || typeof item.path !== 'string' || !Number.isSafeInteger(item.size) || typeof item.sha256 !== 'string') throw new Error('Invalid file record');
      inside(destination, item.path);
    }
    return m;
  } catch (e) {
    if (noFile(e)) return { version: 1, files: {} };
    throw new Error(`Backup history cannot be read; keeping it intact: ${e.message}`);
  }
}

export function inside(root, relative) {
  const result = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), result);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('File path escapes the destination.');
  return result;
}

function safeSegment(value) {
  if (!value || value === '.' || value === '..' || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || value.length > 200) {
    throw new Error(`Camera supplied an unsafe Windows filename: ${JSON.stringify(value)}`);
  }
  return value;
}

// Exclusive creation works on Windows without fcntl. A crashed process leaves a
// descriptive lock; it is recovered only when its local PID is definitely gone.
export function lockDestination(destination) {
  const dir = path.join(destination, '.insta360-sync');
  mkdirSync(dir, { recursive: true });
  const filename = path.join(dir, 'sync.lock');
  const owner = { pid: process.pid, host: os.hostname(), token: randomUUID(), started: new Date().toISOString() };
  const acquire = () => {
    const fd = openSync(filename, 'wx');
    try {
      writeFileSync(fd, JSON.stringify(owner));
    } finally { closeSync(fd); }
  };
  const definitelyDead = () => {
    try {
      const old = JSON.parse(readFileSync(filename, 'utf8'));
      if (old.host === os.hostname() && Number.isInteger(old.pid) && old.pid > 0) {
        try { process.kill(old.pid, 0); } catch (e) { return e.code === 'ESRCH'; }
      }
    } catch {} // Never discard unreadable or foreign-machine locks automatically.
    return false;
  };
  const busy = () => new Error(`Another sync owns this folder (${filename}). If a previous process crashed, stop it and remove that lock file.`);
  try { acquire(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!definitelyDead()) throw busy();
    // Serialize recovery and recheck under that gate. A second recovering process
    // must never unlink a fresh lock created by the first.
    const recovery = filename + '.recovery';
    try { mkdirSync(recovery); } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    try {
      if (!definitelyDead()) throw busy();
      unlinkSync(filename);
      try { acquire(); } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error; }
    } finally { rmdirSync(recovery); }
  }
  return () => {
    try { if (JSON.parse(readFileSync(filename, 'utf8')).token === owner.token) unlinkSync(filename); }
    catch (e) { if (!noFile(e)) throw e; }
  };
}

// Native HTTP is intentionally used instead of fetch: no system proxy, explicit
// inactivity timeouts, no redirect to another host, and streamed multi-GB bodies.
export function request(url, { method = 'GET', headers = {}, body, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers }, resolve);
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('Camera connection timed out.')));
    if (body) req.write(body);
    req.end();
  });
}

async function jsonRequest(url, body, timeout) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const response = await request(url, {
    method: data === undefined ? 'GET' : 'POST', timeout, body: data,
    headers: { 'Content-Type': 'application/json;charset=utf-8', Accept: 'application/json', 'X-XSRF-Protected': '1', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
  });
  const chunks = []; let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) { response.destroy(); throw new Error('Camera JSON response is too large.'); }
    chunks.push(chunk);
  }
  if (response.statusCode !== 200) throw new Error(`Camera returned HTTP ${response.statusCode}.`);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class Camera {
  constructor(config) { this.config = config; this.timeout = config.requestTimeoutSeconds * 1000; }
  info() { return jsonRequest(this.config.cameraUrl + '/osc/info', undefined, this.timeout); }
  async execute(parameters) {
    let result = await jsonRequest(this.config.cameraUrl + '/osc/commands/execute', { name: 'camera.listFiles', parameters }, this.timeout);
    const deadline = Date.now() + this.timeout;
    while (result.state === 'inProgress' && result.id && Date.now() < deadline) {
      await delay(1000);
      result = await jsonRequest(this.config.cameraUrl + '/osc/commands/status', { id: result.id }, this.timeout);
    }
    if (result.state !== 'done') {
      const error = new Error(`camera.listFiles: ${JSON.stringify(result.error ?? result)}`);
      error.oscCode = result.error?.code?.trim(); throw error;
    }
    if (!result.results || !Array.isArray(result.results.entries)) throw new Error('Camera file-list response has no entries array.');
    return result.results;
  }
  async list() {
    const entries = [], seen = new Set(); let start = 0, nested = false;
    for (let page = 0; page < 10000; page++) {
      const params = { fileType: 'all', entryCount: this.config.pageSize, maxThumbSize: 0, startPosition: start };
      let results;
      try { results = await this.execute(nested ? { options: params } : params); }
      catch (e) {
        if (!start && !nested && ['invalidParameterName', 'invalidParameterValue', 'missingParameter'].includes(e.oscCode)) { nested = true; page--; continue; }
        throw e;
      }
      for (const entry of results.entries) {
        if (typeof entry.fileUrl !== 'string' || seen.has(entry.fileUrl)) throw new Error('Camera pagination repeated a file or returned an invalid URL; stopping instead of silently missing footage.');
        seen.add(entry.fileUrl); entries.push(entry);
      }
      start += results.entries.length;
      if (!results.entries.length) {
        if (Number.isInteger(results.totalEntries) && start < results.totalEntries) throw new Error('Camera file list ended before totalEntries. Retry when the camera is idle.');
        return entries;
      }
      if (Number.isInteger(results.totalEntries) ? start >= results.totalEntries : results.entries.length < this.config.pageSize) return entries;
    }
    throw new Error('Camera file list exceeded the pagination limit.');
  }
}

export function normalizeEntry(raw, config, info) {
  const name = safeSegment(raw.name);
  if (!media.test(name) || (config.skipLrv && (/^LRV_/i.test(name) || /\.lrv$/i.test(name)))) return null;
  const url = new URL(raw.fileUrl, config.cameraUrl);
  if (url.origin !== new URL(config.cameraUrl).origin || url.username || url.password) throw new Error(`Camera file URL points to a different server: ${name}`);
  const segments = url.pathname.split('/').filter(Boolean).map(s => safeSegment(decodeURIComponent(s)));
  if (!segments.length || segments.at(-1) !== name) throw new Error(`Camera filename does not match its URL: ${name}`);
  const size = Number(raw.size);
  if (raw.size === undefined || raw.size === null || !Number.isSafeInteger(size) || size < 0) throw new Error(`Camera did not supply a valid size for ${name}.`);
  const source = String(info.serialNumber || config.cameraUrl);
  const slug = String(info.serialNumber || 'camera').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const cameraDir = `${String(info.model || 'X5').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}-${slug}-${hash(source).slice(0, 8)}`;
  return {
    id: hash(source + '\n' + url.pathname), name, url: url.href, size,
    fingerprint: hash(JSON.stringify([size, raw.dateTimeZone ?? raw.dateTime ?? ''])),
    path: [cameraDir, ...segments].join('/'), camera: info.model || 'Insta360 X5',
  };
}

export async function sha256(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

export async function download(entry, part, timeout, progress = () => {}) {
  await fs.mkdir(path.dirname(part), { recursive: true });
  let have = 0;
  try { have = (await fs.stat(part)).size; } catch (e) { if (!noFile(e)) throw e; }
  if (have > entry.size) { await fs.truncate(part, 0); have = 0; }
  // A previous transfer may have finished immediately before a process crash.
  if (have === entry.size && existsSync(part)) return sha256(part);
  const response = await request(entry.url, { timeout, headers: { 'Accept-Encoding': 'identity', ...(have ? { Range: `bytes=${have}-` } : {}) } });
  try {
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new Error('Camera returned compressed media; refusing unsafe byte offsets.');
    if (response.statusCode === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
      if (!range || +range[1] !== have || +range[2] !== entry.size - 1 || +range[3] !== entry.size) throw new Error('Camera returned an incorrect Content-Range; partial file kept intact.');
    } else if (response.statusCode === 200) {
      have = 0; // Camera ignored Range: restart instead of appending duplicate bytes.
    } else throw new Error(`Download returned HTTP ${response.statusCode}.`);
    if (response.headers['content-length'] !== undefined && Number(response.headers['content-length']) !== entry.size - have) throw new Error('Camera download length differs from the listed file size.');
    let received = have, lastUpdate = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > entry.size) return callback(new Error('Download exceeded the listed size.'));
      if (Date.now() - lastUpdate > 200) { lastUpdate = Date.now(); progress(received); }
      callback(null, chunk);
    } });
    await pipeline(response, meter, createWriteStream(part, { flags: have ? 'a' : 'w' }));
    if ((await fs.stat(part)).size !== entry.size) throw new Error('Incomplete download; will resume on the next sync.');
    const handle = await fs.open(part, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    progress(entry.size);
    return await sha256(part);
  } finally { response.destroy(); }
}

export async function runSync(config, { log = () => {}, update = () => {} } = {}) {
  const unlock = lockDestination(config.destination);
  try {
    const manifest = await readManifest(config.destination);
    const camera = new Camera(config);
    log('Connecting to ' + config.cameraUrl);
    const info = await camera.info();
    if (!info || typeof info.model !== 'string') throw new Error('The address did not return Insta360 camera information.');
    update({ camera: { model: info.model, firmware: info.firmwareVersion, serial: info.serialNumber }, cameraReachable: true });
    log(`${info.model} connected${info.firmwareVersion ? ' · firmware ' + info.firmwareVersion : ''}`);
    const raw = await camera.list();
    const entries = raw.map(e => normalizeEntry(e, config, info)).filter(Boolean);
    const localPaths = new Set();
    for (const e of entries) {
      const key = e.path.toLowerCase();
      if (localPaths.has(key)) throw new Error('Two camera files resolve to the same Windows path. Stopping to protect existing files.');
      localPaths.add(key);
    }
    const result = { listed: entries.length, skipped: 0, downloaded: 0, failed: 0, bytes: 0 };
    update({ total: entries.length, completed: 0, result });
    log(`${entries.length} media files found; ${raw.length - entries.length} proxy/unsupported files excluded.`);
    for (const [index, entry] of entries.entries()) {
      const final = inside(config.destination, entry.path);
      const previous = manifest.files[entry.id];
      update({ current: { name: entry.name, size: entry.size, received: 0 }, completed: index });
      try {
        let existing;
        try { existing = await fs.stat(final); } catch (e) { if (!noFile(e)) throw e; }
        if (previous?.fingerprint === entry.fingerprint && previous.path === entry.path && existing?.size === entry.size) {
          if (existing.mtimeMs === previous.mtimeMs || await sha256(final) === previous.sha256) {
            result.skipped++; continue;
          }
        }
        const part = path.join(config.destination, '.insta360-sync', 'partials', `${entry.id}-${entry.fingerprint}.part`);
        log('Downloading ' + entry.name);
        const digest = await download(entry, part, config.requestTimeoutSeconds * 1000, received => update({ current: { name: entry.name, size: entry.size, received } }));
        if (existing) {
          if (existing.size !== entry.size || await sha256(final) !== digest) throw new Error(`A different file already exists at ${final}. Move it aside and sync again; existing footage was preserved.`);
          await fs.unlink(part);
        } else {
          await fs.mkdir(path.dirname(final), { recursive: true });
          await fs.rename(part, final);
        }
        const local = await fs.stat(final);
        manifest.files[entry.id] = {
          id: entry.id, name: entry.name, path: entry.path, size: entry.size,
          sha256: digest, fingerprint: entry.fingerprint, mtimeMs: local.mtimeMs,
          camera: entry.camera, savedAt: new Date().toISOString(),
        };
        await atomicJson(path.join(config.destination, '.insta360-sync', 'manifest.json'), manifest);
        result.downloaded++; result.bytes += entry.size;
        log('Saved ' + entry.name);
      } catch (e) { result.failed++; log(`${entry.name}: ${e.message}`, 'error'); }
      finally { update({ completed: index + 1, result: { ...result } }); }
    }
    log(`${result.downloaded} saved · ${result.skipped} already backed up · ${result.failed} failed. Camera files kept.`);
    update({ current: null, result });
    return result;
  } finally { unlock(); }
}
