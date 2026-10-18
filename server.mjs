import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { loadConfig, validateConfig, atomicJson, readManifest, runSync, defaults } from './lib/sync.mjs';
import { createMockCamera } from './lib/mock-camera.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

export async function createApp(initialConfig, { configFile = path.join(root, 'config.json'), demo = false, quiet = false } = {}) {
  let config = initialConfig, active = null, timer;
  const csrf = randomBytes(24).toString('hex');
  const state = { running: false, cameraReachable: null, camera: null, current: null, completed: 0, total: 0, result: null, lastRun: null, lastSuccess: null, error: null, logs: [] };
  const log = (message, level = 'info') => {
    const entry = { time: new Date().toISOString(), message, level };
    state.logs.push(entry); if (state.logs.length > 120) state.logs.shift();
    if (!quiet) console.log(`[${entry.time}] ${level === 'error' ? 'ERROR ' : ''}${message}`);
  };
  const startSync = () => {
    if (active) return false;
    Object.assign(state, { running: true, error: null, current: null, completed: 0, total: 0, result: null, cameraReachable: null, lastRun: new Date().toISOString() });
    active = runSync(config, { log, update: patch => Object.assign(state, patch) })
      .then(result => {
        if (result.failed) state.error = `${result.failed} file(s) failed. See activity below; partial downloads will be retried.`;
        else state.lastSuccess = new Date().toISOString();
      })
      .catch(e => { state.error = e.message; if (state.cameraReachable === null) state.cameraReachable = false; log(e.message, 'error'); })
      .finally(() => { state.running = false; state.current = null; active = null; });
    return true;
  };
  const schedule = () => {
    clearInterval(timer);
    if (config.autoSync) { timer = setInterval(startSync, config.intervalSeconds * 1000); timer.unref(); }
  };
  const readBody = async req => {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('Request body is too large.'); }
    return JSON.parse(body || '{}');
  };
  const server = http.createServer(async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      // Loopback binding plus Host validation prevents LAN exposure and DNS rebinding.
      const address = server.address();
      const allowedHosts = [`127.0.0.1:${address.port}`, `localhost:${address.port}`];
      if (!allowedHosts.includes(req.headers.host)) return json(403, { error: 'Open this app through localhost or 127.0.0.1.' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'POST') {
        const token = Buffer.from(String(req.headers['x-sync-token'] || ''));
        if (token.length !== csrf.length || !timingSafeEqual(token, Buffer.from(csrf)) || (req.headers.origin && req.headers.origin !== url.origin)) return json(403, { error: 'Reload this page before making changes.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let files = [], historyError = null;
        try { files = Object.values((await readManifest(config.destination)).files).sort((a, b) => b.savedAt.localeCompare(a.savedAt)); }
        catch (e) { historyError = e.message; }
        return json(200, { ...state, config, demo, token: csrf, files, historyError, backedUpBytes: files.reduce((sum, file) => sum + file.size, 0) });
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') {
        const started = startSync(); return json(started ? 202 : 409, started ? { started: true } : { error: 'A download is already running.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        if (state.running) return json(409, { error: 'Wait for this sync to finish before changing settings.' });
        const input = await readBody(req);
        const next = validateConfig({ ...config, cameraUrl: demo ? config.cameraUrl : input.cameraUrl, destination: demo ? config.destination : input.destination, autoSync: input.autoSync, intervalSeconds: input.intervalSeconds, skipLrv: input.skipLrv }, path.dirname(configFile));
        await atomicJson(configFile, next);
        config = next;
        Object.assign(state, { camera: null, cameraReachable: null, error: null, lastRun: null, lastSuccess: null, result: null, total: 0, completed: 0 });
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
    async close() { clearInterval(timer); await active; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
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
