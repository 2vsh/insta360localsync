import * as fs from 'node:fs/promises';
import path from 'node:path';

// INSV offset layout and omnidirectional projection informed by insta360-rs
// (Apache-2.0). This JavaScript implementation supports X5 V3/V6 offsets;
// it does not include vendor assets or gyro stabilization.
// See THIRD_PARTY_NOTICES.md for the format reference and license.
const magic = '8db42d694ccc418790edff439fe026bf';
const radians = degrees => degrees * Math.PI / 180;
const clamp = x => Math.min(1, Math.max(0, x));

function entries(buffer) {
  let cursor = 0, count = 0;
  const result = [];
  const varint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (cursor >= buffer.length) throw new Error('Truncated metadata');
      const byte = buffer[cursor++];
      if (i === 9 && byte > 1) throw new Error('Invalid metadata integer');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new Error('Invalid metadata integer');
  };
  while (cursor < buffer.length) {
    if (++count > 65536) throw new Error('Too many metadata fields');
    const key = Number(varint()), tag = Math.floor(key / 8), wire = key % 8;
    if (!tag || tag > 536870911) throw new Error('Invalid metadata tag');
    let value;
    if (wire === 0) value = varint();
    else {
      const length = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(varint()) : NaN;
      if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - cursor) throw new Error('Invalid metadata field');
      value = buffer.subarray(cursor, cursor + length); cursor += length;
    }
    result.push([tag, value]);
  }
  return result;
}

function fields(buffer, unique = [27, 54, 68, 80, 104, 111, 128, 145]) {
  const result = new Map();
  for (const [tag, value] of entries(buffer)) {
    if (result.has(tag) && unique.includes(tag)) throw new Error('Ambiguous calibration');
    result.set(tag, value);
  }
  return result;
}

const polynomial = (coefficients, theta) => coefficients.reduceRight((value, coefficient) => value * theta + coefficient, 0);
const integer = (metadata, tag, fallback) => {
  const value = metadata.get(tag);
  if (value === undefined) return fallback;
  if (typeof value !== 'bigint' || value > 0xffffffffn) throw new Error('Invalid metadata number');
  return Number(value);
};

function opticalProfile(metadata) {
  const state = integer(metadata, 68, 0);
  const name = state === 0 ? 'bare' : state === 4 ? 'ProtectorA' : state === 5 ? 'ProtectorS'
    : state === 6 ? ({ 1: 'ProtectorA', 2: 'ProtectorS', 3: 'bare', 4: 'ProtectorAS' })[integer(metadata, 104)] : null;
  if (!name) throw new Error('Unsupported optical setup');
  if (name === 'bare') return { name, fov: 200 };
  const data = metadata.get(145), profiles = new Map();
  if (!Buffer.isBuffer(data) || data.length > 1024 * 1024) throw new Error('Missing guard profiles');
  let visited = 0;
  const collect = (buffer, depth) => {
    if (depth > 4) return;
    if (++visited > 256) throw new Error('Too many optical profile records');
    let pairs;
    try { pairs = entries(buffer); } catch { return; }
    const names = pairs.filter(([tag, value]) => tag === 1 && Buffer.isBuffer(value) && value.length <= 32);
    const profileName = names.length === 1 && names[0][1].toString('ascii');
    if (['bare', 'ProtectorA', 'ProtectorS', 'ProtectorAS'].includes(profileName)) {
      const encoded = pairs.filter(([tag]) => tag === 2).map(([, value]) => value);
      // These are two separate named records: six double coefficients and one
      // double FOV. Keep both; a Map of protobuf tags would discard coefficients.
      if (![1, 6].includes(encoded.length) || !encoded.every(value => Buffer.isBuffer(value) && value.length === 8)) throw new Error('Invalid optical profile');
      const values = encoded.map(value => value.readDoubleLE());
      if (!values.every(Number.isFinite)) throw new Error('Invalid optical profile');
      const profile = profiles.get(profileName) || {}, key = values.length === 1 ? 'fov' : 'coefficients';
      if (profile[key]) throw new Error('Ambiguous optical profile');
      profile[key] = values.length === 1 ? values[0] : values;
      profiles.set(profileName, profile); return;
    }
    for (const [, value] of pairs) if (Buffer.isBuffer(value)) collect(value, depth + 1);
  };
  collect(data, 0);
  const source = profiles.get('bare'), target = profiles.get(name);
  if (!source?.coefficients || !target?.coefficients || !(source.fov >= 180 && source.fov <= 200) || !(target.fov >= 180 && target.fov <= source.fov)) throw new Error('Incomplete optical profile');
  // Apply the recorded radius ratio to the measured native radial projection.
  // This retains per-unit intrinsics and tangential/prism corrections; it does
  // not replace them with a generic lens or borrow another camera's constants.
  if (source.coefficients[0] !== 0 || target.coefficients[0] !== 0 || source.coefficients[1] <= 0 || target.coefficients[1] <= 0) throw new Error('Invalid optical profile origin');
  let previousSource = 0, previousTarget = 0;
  for (let i = 1; i <= 200; i++) {
    const theta = target.fov * i / 400, a = polynomial(source.coefficients, theta), b = polynomial(target.coefficients, theta);
    if (!(a > previousSource && b > previousTarget && b / a >= .8 && b / a <= 1.25)) throw new Error('Invalid optical profile curve');
    previousSource = a; previousTarget = b;
  }
  return { name, fov: target.fov, source: source.coefficients, target: target.coefficients };
}

function sensorCrop(lenses, encoded) {
  if (encoded === undefined) return false;
  if (!Buffer.isBuffer(encoded)) throw new Error('Invalid sensor crop');
  const crop = fields(encoded, [1, 2, 3, 4, 5, 6]), values = [1, 2, 3, 4].map(tag => integer(crop, tag));
  if (!values.every(value => Number.isInteger(value) && value > 0 && value <= 32768)) throw new Error('Invalid sensor crop');
  const [sw, sh, dw, dh] = values;
  const signed = tag => { const value = crop.get(tag) ?? 0n; if (typeof value !== 'bigint') throw new Error('Invalid crop offset'); return Number(BigInt.asIntN(32, value)); };
  const ox = signed(5), oy = signed(6), left = (sw - dw) / 2 + ox, top = (sh - dh) / 2 + oy;
  if (dw > sw || dh > sh || left < 0 || top < 0 || left + dw > sw || top + dh > sh) throw new Error('Invalid crop bounds');
  if (sw === dw && sh === dh && !ox && !oy) return false;
  const width = lenses[0].width / 2, height = lenses[0].height;
  if (width === dw && height === dh) return false;
  if (width * sh !== height * sw || dw !== dh) throw new Error('Unsupported sensor crop');
  const scale = sw / width;
  lenses.forEach((lens, i) => {
    lens.cx = (lens.cx - i * width + .5) * scale - .5 - left + i * dw;
    lens.cy = (lens.cy + .5) * scale - .5 - top;
    lens.fx *= scale; lens.fy *= scale; lens.width = dw * 2; lens.height = dh;
  });
  return true;
}

export function parseCalibration(buffer, { separate = false, lensGuardCorrection = true } = {}) {
  try {
    const metadata = fields(buffer), order = integer(metadata, 80);
    // A missing/unknown track order must never silently swap the physical lenses.
    if (!separate && ![1, 2].includes(order)) return null;
    // Do not substitute an older optical setup when a newer offset is present.
    const candidate = metadata.has(111) ? [6, 111, 27] : [3, 54, 19];
    for (const [version, tag, stride] of [candidate]) {
      const encoded = metadata.get(tag);
      if (!Buffer.isBuffer(encoded) || encoded.length > 65536) continue;
      const tokens = encoded.toString('ascii').split('_');
      if (tokens.some(s => !/^-?\d+(?:\.\d+)?$/.test(s))) continue;
      const values = tokens.map(Number);
      if (values.length !== 2 * stride + 2 || values[0] !== 2 || !values.every(Number.isFinite) || Math.floor(values.at(-1) / 65536) !== version) continue;
      const lenses = [0, 1].map(i => {
        const a = values.slice(1 + i * stride, 1 + (i + 1) * stride), dimension = stride - 3;
        return { xi: a[0], fx: a[1], fy: a[2], cx: a[3], cy: a[4], euler: a.slice(5, 8), coefficients: a.slice(11, dimension), width: a[dimension], height: a[dimension + 1], type: a[dimension + 2] };
      });
      if (!lenses.every(l => l.type === 113 && l.xi > 1 && l.xi < 5 && l.fx > 0 && l.fy > 0 && Number.isInteger(l.width) && l.width === l.height * 2 && l.height >= 128 && l.height <= 32768 && l.cx >= 0 && l.cx < l.width && l.cy >= 0 && l.cy < l.height)) continue;
      if (lenses[0].width !== lenses[1].width || lenses[0].height !== lenses[1].height || lenses[0].cx >= lenses[0].width / 2 || lenses[1].cx < lenses[1].width / 2) continue;
      // The explicit off setting uses native bare-lens geometry, retaining the
      // recorded sensor crop, track order and per-unit calibration. On never
      // invents a guard profile when the footage lacks supported guard data.
      const optics = lensGuardCorrection ? opticalProfile(metadata) : { name: 'bare', fov: 200 };
      const cropped = sensorCrop(lenses, metadata.get(27));
      const recordedBlend = integer(metadata, 128, 0);
      return { version, lenses, optics, cropped, reverse: !separate && order === 1, blend: recordedBlend >= 180 && recordedBlend <= optics.fov ? recordedBlend : 190 };
    }
  } catch { /* Unsupported/malformed metadata uses the explicitly labelled fallback. */ }
  return null;
}

export async function readCalibration(filename, options) {
  const file = await fs.open(filename, 'r');
  try {
    const { size } = await file.stat();
    const read = async (position, length) => {
      if (position < 0 || length < 0 || position + length > size) throw new Error('Invalid trailer bounds');
      const buffer = Buffer.alloc(length), result = await file.read(buffer, 0, length, position);
      if (result.bytesRead !== length) throw new Error('Truncated trailer');
      return buffer;
    };
    if (size < 80) return null;
    const header = await read(size - 72, 72);
    if (header.subarray(40).toString('ascii') !== magic || header.readUInt32LE(36) !== 3) return null;
    const trailerSize = header.readUInt32LE(32) + 8, start = size - trailerSize;
    if (trailerSize < 80 || start < 0) return null;
    const box = await read(start, 8);
    if (box.toString('ascii', 4, 8) !== 'inst' || box.readUInt32BE(0) !== trailerSize) return null;
    let cursor = size - 72;
    for (let count = 0; count < 256 && cursor >= start + 14; count++) {
      const footer = await read(cursor - 6, 6), length = footer.readUInt32LE(2), offset = cursor - 6 - length;
      if (offset < start + 8) return null;
      if (footer[1] === 1) return footer[0] === 1 && length <= 8 * 1024 * 1024 ? parseCalibration(await read(offset, length), options) : null;
      cursor = offset;
    }
  } catch { /* Files without a supported bounded trailer remain playable. */ }
  finally { await file.close(); }
  return null;
}

function rotation([x, y, z]) {
  x = radians(x); y = radians(y + 90); z = radians(z);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}

export function lensTransforms(calibration) {
  const first = rotation(calibration.lenses[0].euler), second = rotation(calibration.lenses[1].euler);
  // The second module faces backwards; encoded Euler angles are module corrections.
  for (const index of [0, 1, 2, 6, 7, 8]) second[index] *= -1;
  // Keep the first physical lens upright at the front of the viewer.
  return [first, second].map(matrix => Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3), col = i % 3;
    return matrix[row * 3] * first[col * 3] + matrix[row * 3 + 1] * first[col * 3 + 1] + matrix[row * 3 + 2] * first[col * 3 + 2];
  }));
}

export function projectLens(lens, index, matrix, ray, size, blend = 190, optics = { fov: 200 }) {
  const x = matrix[0] * ray[0] + matrix[1] * ray[1] + matrix[2] * ray[2];
  const y = matrix[3] * ray[0] + matrix[4] * ray[1] + matrix[5] * ray[2];
  const z = matrix[6] * ray[0] + matrix[7] * ray[1] + matrix[8] * ray[2];
  if (z < Math.cos(radians(optics.fov / 2))) return null;
  const theta = Math.acos(Math.min(1, Math.max(-1, z)));
  const ratio = !optics.source ? 1 : theta < 1e-8 ? optics.target[1] / optics.source[1] : polynomial(optics.target, theta * 180 / Math.PI) / polynomial(optics.source, theta * 180 / Math.PI);
  const u = x / (z + lens.xi), v = y / (z + lens.xi), r = u * u + v * v, c = lens.coefficients;
  let dx, dy;
  if (c.length === 13) {
    const radial = (1 + r * (c[0] + r * (c[1] + r * (c[2] + r * (c[3] + r * c[4]))))) * ratio;
    const a = c[5] + r * c[7], b = c[6] + r * c[8];
    dx = u * radial + a * (r + 2 * u * u) + 2 * b * u * v + c[9] * r + c[11] * r * r;
    dy = v * radial + b * (r + 2 * v * v) + 2 * a * u * v + c[10] * r + c[12] * r * r;
  } else {
    const radial = (1 + r * (c[0] + r * (c[1] + r * c[2]))) * ratio;
    dx = u * radial + 2 * c[3] * u * v + c[4] * (r + 2 * u * u);
    dy = v * radial + 2 * c[4] * u * v + c[3] * (r + 2 * v * v);
  }
  const px = (lens.cx + lens.fx * dx - index * lens.width / 2) * size / (lens.width / 2), py = (lens.cy + lens.fy * dy) * size / lens.height;
  if (!Number.isFinite(px + py) || px < 0 || py < 0 || px > size - 1 || py > size - 1) return null;
  const distance = Math.PI / 2 - theta;
  const alpha = blend === 180 ? (distance >= 0 ? 1 : 0) : clamp(distance / radians(blend - 180) + .5);
  const weight = alpha <= .5 ? .5 * (2 * alpha) ** 5.2 : 1 - .5 * (2 * (1 - alpha)) ** 5.2;
  return { x: px, y: py, weight };
}

export async function stitchMaps(calibration, directory, { width, lensSize, signal, axial = false } = {}) {
  const height = width / 2, prefix = `stitch-${width}-${lensSize}${axial ? '-axial' : ''}`, marker = path.join(directory, `${prefix}.ready`);
  const names = ['ax', 'ay', 'bx', 'by', 'mask'].map(name => `${prefix}-${name}.pgm`);
  try { await fs.access(marker); await Promise.all(names.map(name => fs.access(path.join(directory, name)))); return names; } catch { /* Build once per cache version and size. */ }
  const maps = Array.from({ length: 4 }, () => Buffer.alloc(width * height * 2, 255)), mask = Buffer.alloc(width * height), transforms = lensTransforms(calibration);
  const longitude = Array.from({ length: width }, (_, x) => (x + .5) / width * 2 * Math.PI - Math.PI);
  for (let y = 0; y < height; y++) {
    if (y % 32 === 0) { signal?.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
    const latitude = Math.PI / 2 - (y + .5) / height * Math.PI, cos = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      // For local seam alignment, put the first lens at the north pole. The
      // entire overlap is then a narrow equatorial belt with uniform angular
      // sampling, including directions near the ordinary panorama's poles.
      const ray = axial ? [cos * Math.sin(longitude[x]), cos * Math.cos(longitude[x]), Math.sin(latitude)]
        : [cos * Math.sin(longitude[x]), -Math.sin(latitude), cos * Math.cos(longitude[x])], pixel = y * width + x;
      const samples = calibration.lenses.map((lens, i) => projectLens(lens, i, transforms[i], ray, lensSize, calibration.blend, calibration.optics));
      samples.forEach((sample, i) => { if (sample) { maps[2 * i].writeUInt16BE(Math.round(sample.x), pixel * 2); maps[2 * i + 1].writeUInt16BE(Math.round(sample.y), pixel * 2); } });
      const weights = samples.map(sample => sample?.weight || 0), sum = weights[0] + weights[1];
      mask[pixel] = sum ? Math.round(255 * weights[1] / sum) : samples[1] && !samples[0] ? 255 : 0;
    }
  }
  signal?.throwIfAborted();
  await Promise.all([...maps, mask].map((data, i) => fs.writeFile(path.join(directory, names[i]), Buffer.concat([Buffer.from(`P5\n${width} ${height}\n${i === 4 ? 255 : 65535}\n`), data]))));
  await fs.writeFile(marker, '1'); return names;
}
