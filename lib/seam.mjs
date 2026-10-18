import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export const seamSize = { width: 1152, height: 64, top: 256, fps: 10 };
const step = 8, radius = 4, search = 8;
const wrap = (x, width) => (x + width) % width;

// Match small textured patches in an equatorial overlap belt. The two axes
// have equal angular scale, so matching remains well-conditioned at the poles
// of the final panorama. No movement is inferred from featureless regions.
export function matchSeam(a, b, width, height, valid, previous) {
  const columns = Math.ceil(width / step), rows = Math.ceil(height / step);
  const field = new Float32Array(columns * rows * 3), n = (2 * radius + 1) ** 2;
  const patch = new Float32Array(n);
  for (let gy = 1; gy < rows - 1; gy++) for (let gx = 0; gx < columns; gx++) {
    const x = gx * step, y = gy * step;
    let total = 0, squared = 0, ok = true, k = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const index = (y + dy) * width + wrap(x + dx, width), value = a[index];
      if (!valid[0][index]) ok = false;
      patch[k++] = value; total += value; squared += value * value;
    }
    const variance = squared / n - (total / n) ** 2;
    if (!ok || variance < 25) continue;
    const mean = total / n;
    for (let i = 0; i < n; i++) patch[i] -= mean;
    const score = (dx, dy) => {
      if (y + dy - radius < 0 || y + dy + radius >= height) return Infinity;
      let sum = 0, sq = 0, cross = 0, k = 0;
      for (let oy = -radius; oy <= radius; oy++) for (let ox = -radius; ox <= radius; ox++) {
        const index = (y + dy + oy) * width + wrap(x + dx + ox, width);
        if (!valid[1][index]) return Infinity;
        const value = b[index]; sum += value; sq += value * value; cross += value * patch[k++];
      }
      return Math.sqrt(Math.max(0, (squared - total * total / n + sq - sum * sum / n - 2 * cross) / n));
    };
    let best = Infinity, bx = 0, by = 0, error = Infinity;
    const consider = (dx, dy) => {
      const cost = score(dx, dy), regularized = cost + .035 * (dx * dx + dy * dy);
      if (regularized < best) { best = regularized; bx = dx; by = dy; error = cost; }
    };
    for (let dy = -search; dy <= search; dy += 2) for (let dx = -search; dx <= search; dx += 2) consider(dx, dy);
    const cx = bx, cy = by;
    for (let dy = Math.max(-search, cy - 1); dy <= Math.min(search, cy + 1); dy++) for (let dx = Math.max(-search, cx - 1); dx <= Math.min(search, cx + 1); dx++) consider(dx, dy);
    const limit = Math.min(14, Math.sqrt(variance) * .65);
    if (error >= limit || Math.abs(bx) === search || Math.abs(by) === search) continue;
    // Parabolic refinement avoids full-pixel jumps in slowly moving footage.
    const refine = (before, center, after) => {
      const curvature = before - 2 * center + after;
      return Number.isFinite(curvature) && curvature > .01 ? Math.max(-.5, Math.min(.5, .5 * (before - after) / curvature)) : 0;
    };
    let dx = bx + refine(score(bx - 1, by), error, score(bx + 1, by));
    let dy = by + refine(score(bx, by - 1), error, score(bx, by + 1));
    const index = (gy * columns + gx) * 3, confidence = 1 - error / limit;
    if (previous?.[index + 2] && Math.hypot(dx - previous[index], dy - previous[index + 1]) < 3) {
      dx = .75 * dx + .25 * previous[index]; dy = .75 * dy + .25 * previous[index + 1];
    }
    field[index] = dx; field[index + 1] = dy; field[index + 2] = confidence;
  }
  return field;
}

// Four gray displacement maps, packed side-by-side. Corrections are symmetric
// about the common view, spatially smoothed, and fade to zero outside the seam.
// They are encoded at the FINAL panorama's pixel scale, not the analysis scale.
export function seamDisplacements(field, width, height, outputWidth) {
  const columns = Math.ceil(width / step), rows = Math.ceil(height / step), result = Buffer.alloc(width * height * 4, 128);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sx = 0, sy = 0, weights = 0;
    const gx = x / step, gy = y / step;
    for (let j = Math.floor(gy) - 2; j <= Math.floor(gy) + 2; j++) {
      if (j < 0 || j >= rows) continue;
      for (let i = Math.floor(gx) - 2; i <= Math.floor(gx) + 2; i++) {
        const index = (j * columns + wrap(i, columns)) * 3;
        const weight = field[index + 2] * Math.exp(-((i - gx) ** 2 + (j - gy) ** 2) / 1.5);
        weights += weight; sx += weight * field[index]; sy += weight * field[index + 1];
      }
    }
    const t = Math.max(0, 1 - Math.abs(y - height / 2) / (height / 2 - 4));
    const scale = t * t * (3 - 2 * t) * outputWidth / width / 2 / Math.max(.2, weights);
    // Limit how far either source can be bent at the final panorama scale.
    const dx = Math.max(-10, Math.min(10, sx * scale)), dy = Math.max(-10, Math.min(10, sy * scale));
    const offset = y * width * 4 + x;
    result[offset] = Math.round(128 - dx); result[offset + width] = Math.round(128 - dy);
    result[offset + width * 2] = Math.round(128 + dx); result[offset + width * 3] = Math.round(128 + dy);
  }
  return result;
}

// Stream low-resolution lens pairs and lossless correction maps. Memory and
// temporary storage stay bounded independently of the original frame size.
export async function prepareSeam({ args, filename, mapFiles, signal, duration, progress }) {
  signal?.throwIfAborted();
  const { width, height, top, fps } = seamSize, frameBytes = width * height * 2;
  const validity = await Promise.all(mapFiles.map(async file => {
    const data = await fs.readFile(file), pixels = data.subarray(data.length - width * width);
    return Uint8Array.from({ length: width * height }, (_, i) => pixels.readUInt16BE(((top + Math.floor(i / width)) * width + i % width) * 2) !== 65535 ? 1 : 0);
  }));
  const options = { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] };
  const decoder = spawn('ffmpeg', args, options);
  const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'gray', '-video_size', `${width * 4}x${height}`, '-framerate', String(fps), '-i', 'pipe:0', '-c:v', 'ffv1', '-threads', '2', '-f', 'matroska', filename], { ...options, stdio: ['pipe', 'ignore', 'pipe'] });
  const children = [decoder, encoder];
  let failures = '', previous, count = 0;
  const completions = children.map(child => new Promise((resolve, reject) => {
    child.stderr.on('data', chunk => { failures = (failures + chunk).slice(-6000); });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(failures || 'Seam alignment failed.')));
  }));
  // Observe immediately; cancellation can terminate the encoder while decoding.
  for (const completion of completions) completion.catch(() => {});
  encoder.stdin.on('error', () => {});
  const timer = setTimeout(() => children.forEach(child => child.kill()), 24 * 3600e3);
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of decoder.stdout) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        signal?.throwIfAborted();
        const a = Buffer.alloc(width * height), b = Buffer.alloc(width * height);
        for (let y = 0; y < height; y++) {
          pending.copy(a, y * width, y * width * 2, y * width * 2 + width);
          pending.copy(b, y * width, y * width * 2 + width, (y + 1) * width * 2);
        }
        previous = matchSeam(a, b, width, height, validity, previous);
        const maps = seamDisplacements(previous, width, height, 2880);
        if (!encoder.stdin.write(maps)) await once(encoder.stdin, 'drain', { signal });
        pending = pending.subarray(frameBytes); count++; progress?.(Math.min(1, count / fps / duration));
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    if (!count || pending.length) throw new Error('Incomplete seam analysis frames.');
    encoder.stdin.end(); await Promise.all(completions);
  } finally {
    clearTimeout(timer); children.forEach(child => { if (child.exitCode === null) child.kill(); });
    await Promise.allSettled(completions);
  }
}
