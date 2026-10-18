import http from 'node:http';

export async function createMockCamera(options = {}) {
  const content = n => Buffer.from(Array.from({ length: n }, (_, i) => (i * 17 + 31) % 251));
  const files = options.files ?? [
    { name: 'VID_20261018_120000_00_001.insv', data: content(768 * 1024) },
    { name: 'VID_20261018_120000_10_001.insv', data: content(512 * 1024) },
    { name: 'IMG_20261018_120100_00_002.insp', data: content(128 * 1024) },
    { name: 'LRV_20261018_120000_01_001.mp4', data: content(32 * 1024) },
  ];
  const requests = [];
  const deletions = [];
  const controls = { ignoreRange: false, wrongRange: false, interruptOnce: false, repeatPage: false, ...options.controls };
  let url;
  const server = http.createServer(async (req, res) => {
    try {
      requests.push({ method: req.method, path: req.url, range: req.headers.range });
      const send = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'GET' && req.url === '/osc/info') return send({ model: 'Insta360 X5', serialNumber: 'DEMO-X5', firmwareVersion: 'simulated' });
      if (req.method === 'POST' && req.url === '/osc/state') return send({ state: { _cardState: controls.cardState ?? 'pass', batteryLevel: .8, _recording: controls.recording ?? false } });
      if (req.method === 'POST' && req.url === '/osc/commands/execute') {
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Body too large'); }
        const command = JSON.parse(body);
        requests.at(-1).command = command.name;
        if (command.name === 'camera.getOptions') {
          if (controls.storageError) return send({ state: 'error', error: { code: 'invalidParameterName' } });
          const total = controls.totalSpace ?? 32 * 1024 ** 3;
          return send({ state: 'done', results: { options: { totalSpace: total, remainingSpace: controls.freeSpace ?? Math.max(0, total - (controls.otherUsed ?? 0) - files.reduce((n, f) => n + f.data.length, 0)) } } });
        }
        if (command.name === 'camera.delete') {
          deletions.push(command.parameters.fileUrls);
          if (controls.deleteError) return send({ state: 'error', error: { code: 'disabledCommand', message: 'Simulated refusal.' } });
          if (!controls.deleteNoop) for (const fileUrl of command.parameters.fileUrls.slice(0, controls.deletePartial ? 1 : undefined)) {
            const name = decodeURIComponent(new URL(fileUrl).pathname.split('/').at(-1));
            const index = files.findIndex(f => f.name === name); if (index >= 0) files.splice(index, 1);
          }
          return send({ state: 'done', results: { fileUrls: [] } });
        }
        if (command.name !== 'camera.listFiles') return send({ state: 'error', error: { code: 'unknownCommand', message: 'This simulator only lists files.' } });
        if (options.nestedOnly && !command.parameters.options) return send({ state: 'error', error: { code: 'invalidParameterName' } });
        const p = command.parameters.options ?? command.parameters;
        controls.onList?.(files, p);
        const start = controls.repeatPage ? 0 : p.startPosition ?? 0;
        return send({ state: 'done', results: { ...(controls.omitTotal ? {} : { totalEntries: files.length }), entries: files.slice(start, start + p.entryCount).map(f => ({
          name: f.name, size: f.data.length, dateTimeZone: f.dateTimeZone ?? '2026:10:18 12:00:00-05:00',
          fileUrl: `${url}/DCIM/Camera01/${encodeURIComponent(f.name)}`,
        })) } });
      }
      const name = decodeURIComponent((req.url ?? '').split('/').at(-1));
      const file = files.find(f => f.name === name);
      if (req.method !== 'GET' || !file) return send({ error: 'Not found' }, 404);
      let start = 0;
      if (req.headers.range && !controls.ignoreRange) {
        start = Number(/^bytes=(\d+)-$/.exec(req.headers.range)?.[1] ?? NaN);
        if (!Number.isInteger(start) || start >= file.data.length) { res.writeHead(416); return res.end(); }
        res.writeHead(206, { 'Content-Range': `bytes ${controls.wrongRange ? start + 1 : start}-${file.data.length - 1}/${file.data.length}`, 'Content-Length': file.data.length - start });
      } else res.writeHead(200, { 'Content-Length': file.data.length, 'Content-Type': 'application/octet-stream' });
      if (controls.interruptOnce) {
        controls.interruptOnce = false;
        res.write(file.data.subarray(start, start + Math.max(1, Math.floor((file.data.length - start) / 2))));
        setTimeout(() => res.destroy(), 20); return;
      }
      res.end(file.data.subarray(start));
    } catch (e) { if (!res.headersSent) res.writeHead(500); res.end(e.message); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, files, requests, controls, deletions, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
