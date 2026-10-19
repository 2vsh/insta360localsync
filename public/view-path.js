// Shared by the browser and the renderer. Times are seconds on the source clip.
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const angle = n => ((n + 180) % 360 + 360) % 360 - 180;
export const defaultView = () => ({ yaw: 0, pitch: 0, roll: 0, fov: 90 });
// Ease live pan input over 180 ms, independently of the display refresh rate.
// Record the resulting positions; replay and export must not smooth them again.
export function smoothPan(view, target, seconds) {
  const blend = -Math.expm1(-Math.max(0, seconds) / .18);
  const yaw = angle(target.yaw - view.yaw), pitch = target.pitch - view.pitch;
  return { ...view, yaw: angle(view.yaw + yaw * blend), pitch: view.pitch + pitch * blend };
}
export function samplePath(frames, time) {
  if (!frames.length) return defaultView();
  let lo = 0, hi = frames.length - 1;
  if (time <= frames[lo].time) return { ...frames[lo] };
  if (time >= frames[hi].time) return { ...frames[hi] };
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (frames[mid].time <= time) lo = mid; else hi = mid; }
  const a = frames[lo], b = frames[hi], t = (time - a.time) / (b.time - a.time);
  return { time, yaw: angle(a.yaw + angle(b.yaw - a.yaw) * t), pitch: a.pitch + (b.pitch - a.pitch) * t,
    roll: angle(a.roll + angle(b.roll - a.roll) * t), fov: a.fov + (b.fov - a.fov) * t };
}
// FFmpeg's v360 uses Y-down coordinates and the rotation order Ry * Rx * Rz.
export function viewMatrix(view) {
  const [y, p, r] = [view.yaw, view.pitch, view.roll].map(n => n * Math.PI / 180);
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r);
  return new Float32Array([
    cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr,
    -cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr,
    sy * cp, -sp, cy * cp,
  ]);
}
