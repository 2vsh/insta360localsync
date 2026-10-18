import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { loadConfig, validateConfig, atomicJson, readManifest, runSync, defaults } from './lib/sync.mjs';
import { createMockCamera } from './lib/mock-camera.mjs';
import { MediaLibrary, serveMedia } from './lib/media.mjs';
import { restoreRecovery } from './lib/policy.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/viewer.js', ['viewer.js', 'text/javascript; charset=utf-8']],
  ['/view-path.js', ['view-path.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export async function createApp(initialConfig, { configFile = path.join(root, 'config.json'), mediaDir = path.join(root, '.local', 'media'), demo = false, quiet = false } = {}) {
  let config = initialConfig, active = null, timer;
  const media = new MediaLibrary({ destination: () => config.destination, cacheDir: mediaDir, lensGuardCorrection: () => config.lensGuardCorrection });
  const csrf = randomBytes(24).toString('hex');
  const state = { running: false, phase: null, storage: null, cameraReachable: null, camera: null, current: null, completed: 0, total: 0, result: null, lastRun: null, lastSuccess: null, error: null, logs: [] };
  const log = (message, level = 'info') => {
    const entry = { time: new Date().toISOString(), message, level };
    state.logs.push(entry); if (state.logs.length > 120) state.logs.shift();
    if (!quiet) console.log(`[${entry.time}] ${level === 'error' ? 'ERROR ' : ''}${message}`);
  };
  const startSync = () => {
    if (active || media.active || media.queue.length) return false;
    Object.assign(state, { running: true, phase: 'backup', error: null, current: null, completed: 0, total: 0, result: null, cameraReachable: null, lastRun: new Date().toISOString() });
    active = runSync(config, { log, update: patch => Object.assign(state, patch) })
      .then(result => {
        if (result.failed) state.error = `${result.failed} file(s) failed. See activity below; partial downloads will be retried.`;
        else state.lastSuccess = new Date().toISOString();
      })
      .catch(e => { state.error = e.message; if (state.cameraReachable === null) state.cameraReachable = false; log(e.message, 'error'); })
      .finally(() => { state.running = false; state.phase = null; state.current = null; active = null; });
    return true;
  };
  const schedule = () => {
    clearInterval(timer);
    if (config.autoSync) { timer = setInterval(startSync, config.intervalSeconds * 1000); timer.unref(); }
  };
  const readBody = async (req, limit = 16384) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request body is too large.'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  };
  const server = http.createServer(async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Loopback binding plus Host validation prevents LAN exposure and DNS rebinding.
      const address = server.address();
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(403, { error: 'Open this app through localhost or 127.0.0.1.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: 'Open the local app directly.' });
      if (req.method === 'POST') {
        const token = Buffer.from(String(req.headers['x-sync-token'] || ''));
        if (token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf)) || (req.headers.origin && req.headers.origin !== url.origin)) return json(403, { error: 'Reload this page before making changes.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/media-tools') return json(200, await media.tools());
      const jobRoute = /^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/.exec(url.pathname);
      if (jobRoute) {
        if (req.method === 'POST' && jobRoute[2]) return json(200, media.cancel(jobRoute[1]));
        if (req.method === 'GET' && !jobRoute[2]) return json(200, media.job(jobRoute[1]));
      }
      const mediaRoute = /^\/api\/media\/([a-f0-9]{64})\/(inspect|prepare|export|thumbnail|preview|exports)(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
      if (mediaRoute) {
        const [, id, action, exportId] = mediaRoute;
        if (req.method === 'POST' && active) return json(409, { error: 'Wait for the backup operation to finish before preparing media.' });
        if (req.method === 'POST' && action === 'inspect') return json(202, await media.inspect(id));
        if (req.method === 'POST' && action === 'prepare') return json(202, await media.prepare(id));
        if (req.method === 'POST' && action === 'export') return json(202, await media.export(id, await readBody(req, 24 * 1024 * 1024)));
        if (['GET', 'HEAD'].includes(req.method) && ['thumbnail', 'preview', 'exports'].includes(action)) {
          const token = Buffer.from(url.searchParams.get('token') || '');
          if (token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf))) return json(403, { error: 'Reload the page to view media.' });
          const optics = url.searchParams.get('optics');
          if (optics !== null && !['on', 'off'].includes(optics)) return json(400, { error: 'Invalid optics setting.' });
          await serveMedia(req, res, await media.asset(id, action, exportId, optics === null ? undefined : optics === 'on')); return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let files = [], recovery = [], historyError = null;
        try {
          const manifest = await readManifest(config.destination);
          const recovering = new Set(Object.values(manifest.trash ?? {}).flatMap(item => item.files?.map(f => f.id) ?? []));
          files = Object.values(manifest.files).filter(f => !recovering.has(f.id)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
          recovery = Object.values(manifest.trash ?? {}).map(item => ({ id: item.id, time: item.time, status: item.status, names: item.files.map(f => f.name), bytes: item.files.reduce((n, f) => n + f.size, 0) })).sort((a, b) => b.time.localeCompare(a.time));
        }
        catch (e) { historyError = e.message; }
        return json(200, { ...state, config, demo, token: csrf, files, recovery, historyError, backedUpBytes: files.reduce((sum, file) => sum + file.size, 0) });
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const started = startSync(); return json(started ? 202 : 409, started ? { started: true } : { error: 'Wait for the current backup or media job to finish.' });
      }
      const restore = /^\/api\/recovery\/([a-f0-9-]{36})\/restore$/.exec(url.pathname);
      if (req.method === 'POST' && restore) {
        if (active || media.active || media.queue.length) return json(409, { error: 'Wait for backup and media jobs to finish before restoring.' });
        state.running = true; state.phase = 'restore';
        active = restoreRecovery(config, restore[1]);
        try { return json(200, await active); } finally { active = null; state.running = false; state.phase = null; }
      }
      if (req.method === 'POST' && ['/api/config', '/api/policy-preview'].includes(url.pathname)) {
        if (state.running || media.active || media.queue.length) return json(409, { error: 'Wait for downloads and media processing to finish before changing settings.' });
        const input = await readBody(req);
        const allowed = ['cameraUrl', 'destination', 'autoSync', 'intervalSeconds', 'skipLrv', 'backupMode', 'cleanupAtPercent', 'cleanupToPercent', 'keepRecentHours', 'minCameraAgeMinutes', 'mirrorGraceHours', 'minFreeDiskGB', 'maxDeletesPerRun', 'verifyEverySync', 'requestTimeoutSeconds', 'pageSize', 'lensGuardCorrection'];
        const changes = Object.fromEntries(allowed.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
        if (demo) { delete changes.cameraUrl; delete changes.destination; }
        const next = validateConfig({ ...config, ...changes }, path.dirname(configFile));
        const policyChanged = ['backupMode', 'destination', 'cameraUrl'].some(key => next[key] !== config[key]);
        if (policyChanged) next.policyRevision = randomUUID();
        if (url.pathname === '/api/policy-preview') {
          state.running = true; state.phase = 'preview';
          active = runSync(next, { dryRun: true });
          try { return json(200, await active); } finally { active = null; state.running = false; state.phase = null; }
        }
        if (next.backupMode !== 'keep' && policyChanged && input.acknowledgeDeletes !== true) return json(400, { error: 'Acknowledge the selected deletion policy before saving it.' });
        await atomicJson(configFile, next);
        config = next;
        Object.assign(state, { camera: null, storage: null, cameraReachable: null, error: null, lastRun: null, lastSuccess: null, result: null, total: 0, completed: 0 });
        schedule(); log('Settings saved. Destination: ' + config.destination);
        if (config.autoSync) startSync();
        return json(200, { saved: true });
      }
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [name, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); return res.end(await fs.readFile(path.join(root, 'public', name)));
      }
      return json(404, { error: 'Not found.' });
    } catch (e) {
      if (!res.headersSent) json(400, { error: e.message }); else res.destroy();
    }
  });
  server.requestTimeout = 15000;
  return {
    server, state, startSync,
    async listen(port = config.port) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      schedule(); if (config.autoSync) startSync();
      return `http://127.0.0.1:${server.address().port}`;
    },
    async waitForSync() { await active; },
    async close() { clearInterval(timer); await media.close(); await active; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}

async function main() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (['--config', '--destination', '--port'].includes(args[i])) { if (!args[++i]) throw new Error('Missing argument value.'); }
    else if (!['--demo', '--once', '--help', '--open'].includes(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  }
  if (args.includes('--help')) { console.log('node server.mjs [--config path] [--destination folder] [--port 8640] [--once | --demo] [--open]'); return; }
  if (args.includes('--demo') && args.includes('--once')) throw new Error('Use --demo or --once separately.');
  const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const demo = args.includes('--demo');
  const configFile = path.resolve(option('--config') ?? path.join(root, demo ? '.demo/config.json' : 'config.json'));
  let mock, config;
  try {
    if (demo) {
      mock = await createMockCamera();
      config = validateConfig({ ...defaults, cameraUrl: mock.url, destination: path.join(root, '.demo', 'downloads'), autoSync: true });
    } else config = await loadConfig(configFile);
    config = validateConfig({ ...config, ...(option('--destination') ? { destination: option('--destination') } : {}), ...(option('--port') ? { port: Number(option('--port')) } : {}) });
    if (args.includes('--once')) {
      const result = await runSync(config, { log: (m, level) => console.log(`${level === 'error' ? 'ERROR: ' : ''}${m}`) });
      if (result.failed) process.exitCode = 1;
      return;
    }
    const app = await createApp(config, { configFile, demo });
    const url = await app.listen();
    console.log(`\nInsta360 Local Sync${demo ? ' · DEMO (synthetic transfer fixtures)' : ''}\n${url}\nDestination: ${config.destination}\nKeep this window open. Press Ctrl+C to stop.\n`);
    if (args.includes('--open') && process.platform === 'win32') {
      const browser = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath '${url}'`], { windowsHide: true, stdio: 'ignore' });
      browser.on('error', () => console.log('Open ' + url + ' in your browser.'));
    }
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      console.log('Waiting for the current sync to finish. Closing this window keeps partial files for the next run.');
      await app.close(); await mock?.close();
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (e) { await mock?.close(); throw e; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
}
