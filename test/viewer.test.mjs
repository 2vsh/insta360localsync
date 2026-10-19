import test from 'node:test';
import assert from 'node:assert/strict';
import { angle, defaultView, samplePath, smoothPan } from '../public/view-path.js';
import { Viewer } from '../public/viewer.js';
import { cutCommands, validateCut } from '../lib/media.mjs';

test('pan smoothing follows elapsed time, takes the shortest seam crossing and preserves zoom and roll', () => {
  const view = { ...defaultView(), yaw: 175, roll: 12, fov: 65 }, target = { yaw: -175, pitch: 40 };
  const expected = smoothPan(view, target, .5);
  for (const rate of [30, 60, 144]) {
    let actual = view;
    for (let i = 0; i < rate; i++) actual = smoothPan(actual, target, .5 / rate);
    assert.ok(Math.abs(angle(actual.yaw - expected.yaw)) < 1e-9);
    assert.ok(Math.abs(actual.pitch - expected.pitch) < 1e-9);
    assert.equal(actual.roll, 12); assert.equal(actual.fov, 65);
  }
  assert.ok(expected.yaw < -175 && expected.yaw > -180, 'cross the seam by ten degrees, without a spin');
  assert.deepEqual(smoothPan(view, target, 0), view);
  assert.deepEqual(smoothPan(view, target, -1), view);
  const settled = smoothPan(view, target, 10);
  assert.ok(Math.abs(angle(settled.yaw - target.yaw)) < 1e-6);
  assert.ok(Math.abs(settled.pitch - target.pitch) < 1e-6);
});

function viewerFixture(t) {
  const elements = Object.fromEntries(['smooth-panning', 'smooth-panning-state', 'cut-start', 'cut-end', 'aspect', 'quality', 'take-status'].map(id => [id, {}]));
  Object.assign(elements['cut-start'], { value: '0' }); Object.assign(elements['cut-end'], { value: '2' });
  elements.aspect.value = '16:9'; elements.quality.value = '720'; elements['smooth-panning'].checked = false;
  const previousDocument = globalThis.document, previousStorage = globalThis.localStorage, drafts = new Map();
  globalThis.document = { getElementById: id => elements[id] };
  globalThis.localStorage = { getItem: key => drafts.get(key) ?? null, setItem: (key, value) => drafts.set(key, value) };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; if (previousStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = previousStorage; });
  const viewer = Object.create(Viewer.prototype);
  Object.assign(viewer, { view: defaultView(), video: { currentTime: 0, paused: false, seeking: false }, info: { duration: 2, lensGuardCorrection: true }, file: { id: 'fixture' }, frames: [], readout() {} });
  viewer.resetPan();
  return { viewer, elements, drafts };
}

test('optional smoothing accumulates input, records eased positions and leaves direct controls immediate', t => {
  const { viewer, elements } = viewerFixture(t);
  viewer.changeView({ yaw: 20, pitch: 10 });
  assert.equal(viewer.view.yaw, 20); assert.equal(viewer.view.pitch, 10, 'off retains direct input');
  viewer.changeView(defaultView(), true);
  elements['smooth-panning'].checked = true; viewer.recording = true; viewer.panClock = 0;
  viewer.capture(true);
  for (let i = 0; i < 10; i++) viewer.changeView({ yaw: viewer.panTarget.yaw + 3, pitch: viewer.panTarget.pitch + 2 });
  assert.equal(viewer.panTarget.yaw, 30); assert.equal(viewer.panTarget.pitch, 20);
  assert.equal(viewer.view.yaw, 0, 'input sets a target instead of jumping the live view');
  viewer.video.currentTime = .1; viewer.updatePan(100); viewer.capture();
  assert.ok(viewer.view.yaw > 0 && viewer.view.yaw < 30);
  assert.equal(viewer.frames[1].yaw, viewer.view.yaw, 'capture uses the visible eased view');
  viewer.changeView({ roll: 18, fov: 60 });
  assert.equal(viewer.view.roll, 18); assert.equal(viewer.view.fov, 60);
  assert.equal(viewer.panTarget.yaw, 30, 'zoom does not lose pending panning input');
  viewer.changeView(defaultView(), true);
  assert.deepEqual(viewer.view, defaultView(), 'Reset view is immediate');
});

test('recording smoothing freezes during pauses and buffering, and replay bypasses the live filter', t => {
  const { viewer, elements } = viewerFixture(t);
  elements['smooth-panning'].checked = true; viewer.recording = true; viewer.panClock = 0;
  viewer.changeView({ yaw: 60 }); viewer.video.currentTime = .1; viewer.updatePan(100);
  const beforePause = { ...viewer.view };
  viewer.video.paused = true; viewer.updatePan(30000);
  assert.deepEqual(viewer.view, beforePause);
  viewer.video.paused = false; viewer.updatePan(60000);
  assert.deepEqual(viewer.view, beforePause, 'wall time cannot move a frozen media clock');
  viewer.video.currentTime = .2; viewer.updatePan(60100);
  assert.ok(viewer.view.yaw > beforePause.yaw && viewer.view.yaw < 60);
  viewer.video.paused = true; viewer.changeView({ yaw: 45, pitch: 15 });
  assert.equal(viewer.view.yaw, 45); assert.equal(viewer.frames.at(-1).yaw, 45, 'paused manual adjustment is captured immediately');
  viewer.video.paused = false; viewer.replaying = true;
  viewer.view = samplePath([{ time: 0, ...defaultView() }, { time: 2, ...defaultView(), yaw: -30 }], 1);
  const replayed = { ...viewer.view }; viewer.video.currentTime = 1; viewer.updatePan(70000);
  assert.deepEqual(viewer.view, replayed, 'replay never filters the stored path a second time');
});

test('smoothing is stored with the clip draft and old drafts restore with smoothing off', t => {
  const { viewer, elements, drafts } = viewerFixture(t);
  elements['smooth-panning'].checked = true; viewer.saveDraft();
  const draft = JSON.parse(drafts.get(viewer.draftKey)); assert.equal(draft.smoothPanning, true);
  elements['smooth-panning'].checked = false; viewer.loadDraft();
  assert.equal(elements['smooth-panning'].checked, true); assert.equal(elements['smooth-panning-state'].textContent, 'On');
  delete draft.smoothPanning; drafts.set(viewer.draftKey, JSON.stringify(draft)); viewer.loadDraft();
  assert.equal(elements['smooth-panning'].checked, false); assert.equal(elements['smooth-panning-state'].textContent, 'Off');
});

test('smoothed takes reduce abrupt speed changes and export the recorded path unchanged', () => {
  const frames = [{ time: 0, ...defaultView() }], raw = [0]; let view = defaultView();
  for (let i = 1; i <= 20; i++) {
    const yaw = i < 4 ? 0 : i < 9 ? 50 : i < 13 ? 20 : 80;
    view = smoothPan(view, { yaw, pitch: 10 }, .1); frames.push({ ...view, time: i / 10 }); raw.push(yaw);
  }
  const roughness = positions => positions.slice(2).reduce((sum, value, i) => sum + (value - 2 * positions[i + 1] + positions[i]) ** 2, 0);
  assert.ok(roughness(frames.map(frame => frame.yaw)) < roughness(raw) * .3, 'ease abrupt input changes');
  const cut = validateCut({ start: 0, end: 2, frames, quality: '720' }, 2);
  assert.deepEqual(cut.frames, frames, 'the renderer accepts the exact recorded positions');
  const expected = samplePath(frames, .5).yaw.toFixed(5);
  assert.ok(cutCommands(cut).includes(`0.500000 v360@camera yaw ${expected}`), 'FFmpeg commands use the same view as replay');
});
