import path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { readManifest, inside, atomicJson } from './sync.mjs';
import { angle, samplePath } from '../public/view-path.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-f0-9]{64}$/;
const imagePattern = /\.(insp|jpe?g|png)$/i;
const videoPattern = /\.(insv|mp4|mov|webm|lrv)$/i;
const baseArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '4'];
const inputArgs = filename => ['-threads', '4', '-protocol_whitelist', 'file,pipe', '-i', filename];
const encoding = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-threads', '4', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

function execute(command, args, { signal, cwd, progress, duration, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', pending = '', expired = false;
    const timer = timeout && setTimeout(() => { expired = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => {
      if (!progress) { output += chunk; if (output.length > 4e6) child.kill(); return; }
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) if (line.startsWith('out_time_us=')) progress(Math.min(.99, Math.max(0, Number(line.slice(12)) / 1e6 / duration)));
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-6000); });
    child.once('error', error => { clearTimeout(timer); reject(error.code === 'ENOENT' ? new Error('Install FFmpeg and FFprobe, add them to PATH, then restart the app. See README for setup.') : error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(expired ? 'Media processing timed out.' : signal?.aborted ? 'Cancelled.' : errors.trim() || 'Media processing failed.')); });
  });
}

export function validateCut(input, duration) {
  const { start, end, frames, aspect = '16:9', quality = '1080' } = input;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + .05 || end - start < .1 || end - start > 21600) throw new Error('Choose a valid section of at least 0.1 seconds (up to six hours).');
  if (!['16:9', '9:16', '1:1'].includes(aspect) || !['720', '1080'].includes(quality)) throw new Error('Choose a supported frame shape and resolution.');
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 220000) throw new Error('Record a camera path before exporting.');
  let previous = -1;
  const clean = frames.map(frame => {
    if (!frame || !['time', 'yaw', 'pitch', 'roll', 'fov'].every(key => Number.isFinite(frame[key])) || frame.time <= previous || frame.time < start - .05 || frame.time > end + .05 || Math.abs(frame.yaw) > 180 || Math.abs(frame.pitch) > 89 || Math.abs(frame.roll) > 180 || frame.fov < 30 || frame.fov > 120) throw new Error('The recorded camera path is invalid. Record a new take.');
    previous = frame.time;
    return Object.fromEntries(['time', 'yaw', 'pitch', 'roll', 'fov'].map(key => [key, frame[key]]));
  });
  if (clean[0].time > start + .06 || clean.at(-1).time < end - .06) throw new Error('The take does not cover the selected section. Finish recording or use the recorded section.');
  const size = Number(quality);
  const dimensions = aspect === '16:9' ? [size / 9 * 16, size] : aspect === '9:16' ? [size, size / 9 * 16] : [size, size];
  return { start, end: Math.min(end, duration), frames: clean, aspect, quality, width: Math.round(dimensions[0] / 2) * 2, height: Math.round(dimensions[1] / 2) * 2 };
}

// Every rendered frame samples the same interpolation as the WebGL preview.
// reset_rot=1 makes v360 commands absolute rather than accumulated rotations.
export function cutCommands(cut, fps = 30) {
  const lines = []; let last = {};
  for (let frame = 0; frame < Math.ceil((cut.end - cut.start) * fps); frame++) {
    const view = samplePath(cut.frames, cut.start + frame / fps), commands = [];
    for (const key of ['yaw', 'pitch', 'roll', 'fov']) {
      const value = Number((key === 'yaw' || key === 'roll' ? angle(view[key]) : view[key]).toFixed(5));
      if (value !== last[key]) commands.push(`v360@camera ${key === 'fov' ? 'h_fov' : key} ${value}`);
      if (key === 'fov' && value !== last[key]) {
        const vertical = 2 * Math.atan(Math.tan(value * Math.PI / 360) * cut.height / cut.width) * 180 / Math.PI;
        commands.push(`v360@camera v_fov ${vertical.toFixed(5)}`);
      }
      last[key] = value;
    }
    if (commands.length) lines.push(`${(frame / fps).toFixed(6)} ${commands.join(', ')};`);
  }
  return lines.join('\n');
}

export class MediaLibrary {
  constructor({ destination, cacheDir }) {
    this.destination = destination; this.cacheDir = cacheDir;
    this.jobs = new Map(); this.queue = []; this.active = null; this.closed = false;
  }
  async tools() {
    if (!this.toolCheck) this.toolCheck = Promise.all([execute('ffmpeg', ['-version'], { timeout: 10000 }), execute('ffprobe', ['-version'], { timeout: 10000 })])
      .then(() => ({ available: true })).catch(error => ({ available: false, error: error.message }));
    return this.toolCheck;
  }
  async source(id) {
    if (!idPattern.test(id)) throw new Error('Invalid library item.');
    const destination = this.destination(), manifest = await readManifest(destination);
    const record = manifest.files[id];
    if (!record) throw new Error('This recording is no longer in the selected library.');
    const resolve = async item => {
      const root = await fs.realpath(destination), filename = await fs.realpath(inside(destination, item.path));
      inside(root, filename);
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size !== item.size || (item.mtimeMs && Math.abs(stat.mtimeMs - item.mtimeMs) > 2)) throw new Error('The original file changed or is missing. Run a sync to check the backup.');
      return filename;
    };
    const filename = await resolve(record);
    const pairName = record.name.replace(/_00_(\d+)\.insv$/i, '_10_$1.insv');
    const pair = pairName !== record.name && Object.values(manifest.files).find(f => f.name === pairName && path.dirname(f.path) === path.dirname(record.path));
    const partner = pair ? await resolve(pair) : null;
    const key = hash(JSON.stringify([destination, record.path, record.sha256, record.size, record.mtimeMs, pair?.sha256, 2]));
    const dir = path.join(this.cacheDir, key);
    return { record, filename, partner, key, dir };
  }
  job(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error('This job has expired. Open the clip again.');
    const { controller, run, key, ...publicJob } = job;
    return publicJob;
  }
  enqueue(key, kind, run) {
    if (this.closed) throw new Error('The media service is stopping.');
    for (const job of this.jobs.values()) if (job.key === key && !['failed', 'cancelled'].includes(job.status)) return this.job(job.id);
    if (this.queue.length >= 64) throw new Error('The media queue is full. Please wait for the current jobs.');
    for (const [id, job] of this.jobs) if (this.jobs.size >= 150 && ['complete', 'failed', 'cancelled'].includes(job.status)) this.jobs.delete(id);
    const job = { id: randomUUID(), key, kind, status: 'queued', progress: 0, message: 'Waiting for the media processor', controller: new AbortController(), run };
    this.jobs.set(job.id, job); this.queue.push(job); this.pump(); return this.job(job.id);
  }
  async pump() {
    if (this.active || this.closed) return;
    const job = this.queue.shift(); if (!job) return;
    this.active = job; job.status = 'running';
    try {
      job.result = await job.run(job); job.controller.signal.throwIfAborted();
      job.status = 'complete'; job.progress = 1; job.message = 'Ready';
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.controller.signal.aborted ? 'Cancelled.' : error.message; job.message = job.error;
    } finally { this.active = null; this.pump(); }
  }
  cancel(id) {
    const job = this.jobs.get(id); if (!job) throw new Error('Job not found.');
    if (['complete', 'failed', 'cancelled'].includes(job.status)) return this.job(id);
    job.controller.abort();
    if (job.status === 'queued') { this.queue = this.queue.filter(j => j !== job); job.status = 'cancelled'; job.error = 'Cancelled.'; }
    return this.job(id);
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) if (['queued', 'running'].includes(job.status)) job.controller.abort();
    while (this.active) await new Promise(resolve => setTimeout(resolve, 20));
  }
  async probe(source, signal) {
    await fs.mkdir(source.dir, { recursive: true });
    const metadataFile = path.join(source.dir, 'metadata.json');
    try { return JSON.parse(await fs.readFile(metadataFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!imagePattern.test(source.record.name) && !videoPattern.test(source.record.name)) throw new Error('This original is backed up. The viewer supports video and JPEG/PNG photos; open RAW and audio files in a desktop editor.');
    const tools = await this.tools(); if (!tools.available) throw new Error(tools.error);
    let probe;
    try { probe = JSON.parse(await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', source.filename], { signal, timeout: 30000 })); }
    catch (e) { if (signal?.aborted || /Install FFmpeg/.test(e.message)) throw e; throw new Error('This file could not be decoded. Demo transfer fixtures are not playable footage.'); }
    const videos = probe.streams.filter(s => s.codec_type === 'video');
    if (!videos.length) throw new Error('No playable video or image stream was found.');
    const first = videos[0], image = imagePattern.test(source.record.name);
    const dual = /\.insv$/i.test(source.record.name) && (videos.length >= 2 || source.partner) && first.width === first.height;
    if (/\.insv$/i.test(source.record.name) && !dual && first.width === first.height) throw new Error('This recording needs its second lens file. Download both originals before opening it.');
    const duration = image ? 0 : Number(probe.format.duration || first.duration);
    if (!image && (!Number.isFinite(duration) || duration <= 0)) throw new Error('The video duration could not be read.');
    const info = { duration, image, dual: Boolean(dual), separate: Boolean(dual && videos.length < 2), projection: dual || Math.abs(first.width / first.height - 2) < .03 ? 'equirect' : 'flat',
      width: first.width, height: first.height, audio: probe.streams.some(s => s.codec_type === 'audio'), fps: first.avg_frame_rate, stitch: dual ? 'basic' : null };
    await atomicJson(metadataFile, info); return info;
  }
  graph(info, { thumbnail = false } = {}) {
    if (info.dual) {
      const lensSize = thumbnail ? 512 : 1440, width = thumbnail ? 1024 : 2880;
      const graph = `[0:v:0]scale=${lensSize}:${lensSize},setsar=1[a];[${info.separate ? '1:v:0' : '0:v:1'}]scale=${lensSize}:${lensSize},setsar=1[b];[a][b]hstack,v360=input=dfisheye:output=equirect:ih_fov=200:iv_fov=200:w=${width}:h=${width / 2}[sphere];`;
      return graph + (thumbnail ? '[sphere]v360=equirect:flat:w=480:h=270:h_fov=100[out]' : '[sphere]null[out]');
    }
    if (info.projection === 'equirect') return thumbnail ? '[0:v:0]v360=equirect:flat:w=480:h=270:h_fov=100,setsar=1[out]' : '[0:v:0]scale=2880:1440,setsar=1[out]';
    return thumbnail ? '[0:v:0]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,setsar=1[out]' : '[0:v:0]scale=1920:1920:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[out]';
  }
  async inspect(id) {
    const source = await this.source(id);
    return this.enqueue(`inspect:${source.key}`, 'thumbnail', async job => {
      job.message = 'Reading clip & creating thumbnail';
      const info = await this.probe(source, job.controller.signal);
      const filename = path.join(source.dir, 'thumbnail.jpg');
      try { await fs.access(filename); } catch {
        const temporary = path.join(source.dir, `${job.id}.jpg`);
        const seek = info.image ? [] : ['-ss', String(Math.min(1, info.duration / 3))];
        const args = [...baseArgs, ...seek, ...inputArgs(source.filename), ...(info.separate ? [...seek, ...inputArgs(source.partner)] : []), '-filter_complex', this.graph(info, { thumbnail: true }), '-map', '[out]', '-frames:v', '1', '-update', '1', temporary];
        try { await execute('ffmpeg', args, { signal: job.controller.signal, timeout: 60000 }); await fs.rename(temporary, filename); }
        finally { await fs.unlink(temporary).catch(() => {}); }
      }
      return { ...info, thumbnail: `/api/media/${id}/thumbnail` };
    });
  }
  async prepare(id) {
    const source = await this.source(id);
    return this.enqueue(`prepare:${source.key}`, 'preview', async job => {
      const info = await this.probe(source, job.controller.signal);
      const name = info.image ? 'preview.jpg' : 'preview.mp4', filename = path.join(source.dir, name);
      try { await fs.access(filename); } catch {
        job.message = info.dual ? 'Stitching both lenses for local playback' : 'Preparing browser playback';
        const temporary = path.join(source.dir, `${job.id}.${info.image ? 'jpg' : 'mp4'}`);
        const args = [...baseArgs, ...inputArgs(source.filename), ...(info.separate ? inputArgs(source.partner) : []), '-filter_complex', this.graph(info), '-map', '[out]',
          ...(info.image ? ['-frames:v', '1', '-update', '1'] : ['-map', '0:a:0?', '-r', '30', ...encoding, '-progress', 'pipe:1']), temporary];
        try {
          await execute('ffmpeg', args, { signal: job.controller.signal, duration: info.duration, progress: info.image ? undefined : n => { job.progress = n; }, timeout: 24 * 3600e3 });
          job.controller.signal.throwIfAborted(); await fs.rename(temporary, filename);
        } finally { await fs.unlink(temporary).catch(() => {}); }
      }
      return { ...info, url: `/api/media/${id}/preview` };
    });
  }
  async export(id, input) {
    const source = await this.source(id), info = await this.probe(source);
    if (info.image) throw new Error('Director cuts require a video.');
    const cut = validateCut(input, info.duration);
    await fs.access(path.join(source.dir, 'preview.mp4')).catch(() => { throw new Error('Wait for the playback preview to finish preparing.'); });
    const nonce = randomUUID();
    return this.enqueue(`export:${nonce}`, 'export', async job => {
      job.message = 'Rendering your camera movements to MP4';
      const directory = path.join(source.dir, 'exports', job.id);
      await fs.mkdir(directory, { recursive: true });
      const temporary = path.join(directory, 'render.mp4'), filename = path.join(directory, 'cut.mp4');
      await fs.writeFile(path.join(directory, 'commands.txt'), cutCommands(cut));
      await atomicJson(path.join(directory, 'take.json'), cut);
      const vertical = 2 * Math.atan(Math.tan(Math.PI / 4) * info.height / info.width) * 180 / Math.PI;
      const inputProjection = info.projection === 'flat' ? `input=flat:ih_fov=90:iv_fov=${vertical}` : 'input=equirect';
      const vf = `fps=30,setpts=PTS-STARTPTS,sendcmd=f=commands.txt,v360@camera=${inputProjection}:output=flat:w=${cut.width}:h=${cut.height}:h_fov=90:reset_rot=1:rorder=ypr,setsar=1`;
      try {
        await execute('ffmpeg', [...baseArgs, '-ss', String(cut.start), ...inputArgs(path.join(source.dir, 'preview.mp4')), '-t', String(cut.end - cut.start), '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf, ...encoding, '-progress', 'pipe:1', temporary],
          { cwd: directory, signal: job.controller.signal, duration: cut.end - cut.start, progress: n => { job.progress = n; }, timeout: 24 * 3600e3 });
        job.controller.signal.throwIfAborted(); await fs.rename(temporary, filename);
        return { url: `/api/media/${id}/exports/${job.id}`, filename: `${path.parse(source.record.name).name}-director-cut.mp4`, duration: cut.end - cut.start, width: cut.width, height: cut.height };
      } finally { await fs.unlink(temporary).catch(() => {}); }
    });
  }
  async asset(id, kind, exportId) {
    const source = await this.source(id);
    const info = await this.probe(source);
    if (kind === 'thumbnail') return { filename: path.join(source.dir, 'thumbnail.jpg'), type: 'image/jpeg' };
    if (kind === 'preview') return { filename: path.join(source.dir, info.image ? 'preview.jpg' : 'preview.mp4'), type: info.image ? 'image/jpeg' : 'video/mp4' };
    if (kind === 'exports' && /^[a-f0-9-]{36}$/.test(exportId)) return { filename: path.join(source.dir, 'exports', exportId, 'cut.mp4'), type: 'video/mp4', download: `${path.parse(source.record.name).name}-director-cut.mp4` };
    throw new Error('Media not found.');
  }
}

// Open before replying, support seeking, and close the handle on aborted requests.
export async function serveMedia(req, res, asset) {
  const handle = await fs.open(asset.filename, 'r');
  try {
    const { size } = await handle.stat();
    let start = 0, end = size - 1, code = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Number(match[2]); }
      end = Math.min(end, size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
      code = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    res.setHeader('Content-Type', asset.type); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', end - start + 1);
    if (asset.download) res.setHeader('Content-Disposition', `attachment; filename="director-cut.mp4"; filename*=UTF-8''${encodeURIComponent(asset.download)}`);
    res.writeHead(code);
    if (req.method === 'HEAD') res.end();
    else await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally { await handle.close(); }
}
