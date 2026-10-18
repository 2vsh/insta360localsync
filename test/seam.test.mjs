import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSeam, seamDisplacements } from '../lib/seam.mjs';

function pair(dx = 3, dy = 2) {
  const width = 128, height = 64, a = Buffer.alloc(width * height), b = Buffer.alloc(a.length);
  // Independent, nonrepeating two-dimensional texture; horizontal translation
  // crosses the longitude boundary of the spherical overlap belt.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) a[y * width + x] = Math.round(120 + 40 * Math.sin(x * .31) + 30 * Math.cos(y * .47) + 25 * Math.sin(x * .19 + y * .35));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) b[y * width + x] = a[Math.max(0, Math.min(height - 1, y - dy)) * width + (x - dx + width) % width];
  return { width, height, a, b, valid: [new Uint8Array(a.length).fill(1), new Uint8Array(a.length).fill(1)] };
}

test('seam correspondence recovers independent displacement across the spherical wrap', () => {
  for (const [dx, dy] of [[3, 2], [-2, -3], [0, 0]]) {
    const { width, height, a, b, valid } = pair(dx, dy), field = matchSeam(a, b, width, height, valid);
    let accepted = 0, error = 0;
    for (let y = 2; y < 6; y++) for (let x = 0; x < width / 8; x++) {
      const index = (y * (width / 8) + x) * 3;
      if (field[index + 2] > .1) { error += Math.hypot(field[index] - dx, field[index + 1] - dy); accepted++; }
    }
    assert.ok(accepted > 45, `accepted ${accepted} textured patches`);
    assert.ok(error / accepted < .3, `mean displacement error ${error / accepted}`);
    // Include either side of the longitude boundary, rather than only the center.
    for (const x of [0, 15]) {
      const index = (4 * (width / 8) + x) * 3;
      assert.ok(field[index + 2] > .1); assert.ok(Math.hypot(field[index] - dx, field[index + 1] - dy) < .5);
    }
  }
});

test('featureless or invalid overlap never invents a camera correction', () => {
  const { width, height, a, b, valid } = pair();
  a.fill(80); b.fill(130);
  assert.ok(matchSeam(a, b, width, height, valid).every(value => value === 0));
  const textured = pair(); textured.valid[1].fill(0);
  assert.ok(matchSeam(textured.a, textured.b, width, height, textured.valid).every(value => value === 0));
});

test('corrections share displacement between lenses, stay bounded, and leave the rest of each lens intact', () => {
  const { width, height, a, b, valid } = pair(), field = matchSeam(a, b, width, height, valid);
  const maps = seamDisplacements(field, width, height, width * 4);
  const at = (map, x, y) => maps[y * width * 4 + map * width + x];
  for (const y of [0, 1, 2, height - 2, height - 1]) for (let x = 0; x < width; x++) for (let map = 0; map < 4; map++) assert.equal(at(map, x, y), 128);
  assert.ok(at(0, 64, 32) < 128 && at(2, 64, 32) > 128);
  assert.ok(at(1, 64, 32) < 128 && at(3, 64, 32) > 128);
  assert.ok(Math.abs(at(0, 64, 32) + at(2, 64, 32) - 256) <= 1);
  assert.ok(maps.every(value => value >= 118 && value <= 138));
  assert.ok(seamDisplacements(new Float32Array(field.length), width, height, width * 4).every(value => value === 128));
});
