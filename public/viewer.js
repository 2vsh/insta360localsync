import { angle, clamp, defaultView, samplePath, viewMatrix } from './view-path.js';
const $ = id => document.getElementById(id);
export const timecode = seconds => {
  const value = Math.max(0, seconds || 0), h = Math.floor(value / 3600), m = Math.floor(value / 60) % 60, s = Math.floor(value % 60);
  return `${h ? h + ':' + String(m).padStart(2, '0') : Math.floor(value / 60)}:${String(s).padStart(2, '0')}`;
};
const notice = text => { $('director-error').textContent = text || ''; $('director-error').hidden = !text; };
export async function waitJob(job, update = () => {}) {
  while (true) {
    update(job);
    if (job.status === 'complete') return job.result;
    if (['failed', 'cancelled'].includes(job.status)) throw new Error(job.error || 'Media processing failed.');
    await new Promise(resolve => setTimeout(resolve, 650));
    const response = await fetch(`/api/jobs/${job.id}`);
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'The local app stopped responding.'); job = data;
  }
}

class Panorama {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is unavailable. Enable hardware acceleration in your browser, then reload this page.');
    this.gl = gl;
    const compile = (type, code) => { const shader = gl.createShader(type); gl.shaderSource(shader, code); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('The browser could not initialize the video viewer.'); return shader; };
    const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 position; varying vec2 screen; void main(){screen=vec2(position.x,-position.y);gl_Position=vec4(position,0.,1.);}');
    const fragment = compile(gl.FRAGMENT_SHADER, `precision highp float;
      varying vec2 screen; uniform sampler2D frame; uniform mat3 rotation;
      uniform float tangent; uniform float aspect; uniform float flatProjection; uniform float inputAspect;
      void main(){
        vec3 ray=normalize(rotation*vec3(screen.x*tangent,screen.y*tangent/aspect,1.)); vec2 uv;
        if(flatProjection>0.5){
          uv=vec2(ray.x/ray.z*.5+.5,ray.y/ray.z*inputAspect*.5+.5);
          if(ray.z<=0. || uv.x<0. || uv.x>1. || uv.y<0. || uv.y>1.){gl_FragColor=vec4(0.,0.,0.,1.);return;}
        }else{uv=vec2(fract(atan(ray.x,ray.z)/6.28318530718+.5),asin(clamp(ray.y,-1.,1.))/3.14159265359+.5);}
        gl_FragColor=texture2D(frame,uv);
      }`);
    const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('The browser could not link the video viewer.');
    gl.useProgram(program); this.program = program;
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = Object.fromEntries(['rotation', 'tangent', 'aspect', 'flatProjection', 'inputAspect'].map(key => [key, gl.getUniformLocation(program, key)]));
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, key, gl.CLAMP_TO_EDGE);
    for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, key, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(program, 'frame'), 0);
  }
  draw(source, info, view) {
    const { gl, canvas, uniforms: u } = this;
    const ratio = Math.min(devicePixelRatio || 1, 1.5), width = Math.max(2, Math.round(canvas.clientWidth * ratio)), height = Math.max(2, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; gl.viewport(0, 0, width, height); }
    if (this.source !== source || (!info.image && !source.requestVideoFrameCallback)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); this.source = source;
    }
    gl.uniformMatrix3fv(u.rotation, false, viewMatrix(view)); gl.uniform1f(u.tangent, Math.tan(view.fov * Math.PI / 360));
    gl.uniform1f(u.aspect, width / height); gl.uniform1f(u.flatProjection, info.projection === 'flat' ? 1 : 0); gl.uniform1f(u.inputAspect, info.width / info.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

export class Viewer {
  constructor({ post, mediaUrl, onExport }) {
    this.post = post; this.mediaUrl = mediaUrl; this.onExport = onExport;
    this.video = $('source-video'); this.image = $('source-image'); this.dialog = $('viewer'); this.canvas = $('viewport');
    this.view = defaultView(); this.frames = []; this.generation = 0; this.exports = new Map(); this.pendingExports = new Set(); this.pointers = new Map();
    this.resizeObserver = new ResizeObserver(() => this.applyAspect()); this.resizeObserver.observe($('stage'));
    $('close-viewer').onclick = () => this.close();
    this.dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    $('play').onclick = () => this.togglePlay();
    this.video.onplay = this.video.onpause = () => { $('play').textContent = this.video.paused ? '▶' : 'Ⅱ'; $('play').setAttribute('aria-label', this.video.paused ? 'Play' : 'Pause'); };
    this.video.onended = () => { if (this.recording) this.finishTake(false); if (this.replaying) this.stopReplay(); };
    this.video.onerror = () => { if (this.ready && !this.info?.image) { this.ready = false; this.loadingError('This preview could not be played. Try a current Chrome or Edge browser.'); } };
    $('seek').oninput = () => { if (this.ready && !this.recording) this.video.currentTime = Number($('seek').value); };
    $('mute').onclick = () => { this.video.muted = !this.video.muted; $('mute').textContent = this.video.muted ? 'Sound off' : 'Sound on'; $('mute').setAttribute('aria-label', this.video.muted ? 'Unmute audio' : 'Mute audio'); };
    for (const key of ['roll', 'fov']) $(key).oninput = () => this.changeView({ [key]: Number($(key).value) });
    $('reset-view').onclick = () => this.changeView(defaultView());
    $('fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stage').requestFullscreen(); } catch (e) { notice(e.message); } };
    $('aspect').onchange = () => { this.applyAspect(); this.saveDraft(); };
    $('quality').onchange = () => this.saveDraft();
    for (const id of ['cut-start', 'cut-end']) $(id).onchange = () => this.rangeChanged();
    $('whole-clip').onclick = () => { this.setRange(0, this.duration); this.rangeChanged(); };
    $('set-in').onclick = () => { $('cut-start').value = this.video.currentTime.toFixed(2); this.rangeChanged(); };
    $('set-out').onclick = () => { $('cut-end').value = Math.min(this.duration, this.video.currentTime).toFixed(2); this.rangeChanged(); };
    $('record').onclick = () => this.recording ? this.finishTake(true) : this.startTake();
    $('stop-take').onclick = () => this.recording ? this.finishTake(true) : this.stopReplay();
    $('replay-take').onclick = () => this.replaying ? this.stopReplay() : this.replay();
    $('clear-take').onclick = () => this.clearTake();
    $('export-cut').onclick = () => this.export();
    $('download-cut').onclick = () => { const item = this.exports.get(this.file?.id); if (item?.result) this.saveFile(item.result).catch(e => notice(e.message)); };
    $('cancel-export').onclick = async () => { const item = this.exports.get(this.file?.id); if (item) { try { await this.post(`/api/jobs/${item.job.id}/cancel`); } catch (e) { notice(e.message); } } };
    $('cancel-preview').onclick = async () => { if (this.prepareJob) await this.post(`/api/jobs/${this.prepareJob.id}/cancel`).catch(e => notice(e.message)); };
    $('retry-preview').onclick = () => this.open(this.file);
    this.canvas.addEventListener('pointerdown', event => { if (!this.ready || this.replaying) return; this.canvas.focus(); this.canvas.setPointerCapture(event.pointerId); this.pointers.set(event.pointerId, [event.clientX, event.clientY]); });
    this.canvas.addEventListener('pointermove', event => {
      const old = this.pointers.get(event.pointerId); if (!old || this.replaying) return;
      const others = [...this.pointers.entries()].filter(([id]) => id !== event.pointerId);
      if (others.length) {
        const other = others[0][1], before = Math.hypot(old[0] - other[0], old[1] - other[1]), after = Math.hypot(event.clientX - other[0], event.clientY - other[1]);
        if (before > 1 && after > 1) this.changeView({ fov: this.view.fov * before / after });
      } else this.changeView({ yaw: this.view.yaw - (event.clientX - old[0]) * this.view.fov / this.canvas.clientWidth, pitch: this.view.pitch + (event.clientY - old[1]) * this.view.fov / this.canvas.clientWidth });
      this.pointers.set(event.pointerId, [event.clientX, event.clientY]);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.canvas.addEventListener(type, event => this.pointers.delete(event.pointerId));
    this.canvas.addEventListener('wheel', event => { if (!this.ready || this.replaying) return; event.preventDefault(); this.changeView({ fov: this.view.fov + clamp(event.deltaY, -100, 100) * .04 }); }, { passive: false });
    this.dialog.addEventListener('keydown', event => {
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(event.target.tagName) || !this.ready || this.replaying) return;
      const key = event.key.toLowerCase(), changes = { arrowleft: { yaw: this.view.yaw - 3 }, arrowright: { yaw: this.view.yaw + 3 }, arrowup: { pitch: this.view.pitch + 3 }, arrowdown: { pitch: this.view.pitch - 3 }, '+': { fov: this.view.fov - 3 }, '=': { fov: this.view.fov - 3 }, '-': { fov: this.view.fov + 3 }, q: { roll: this.view.roll - 3 }, e: { roll: this.view.roll + 3 }, r: defaultView() };
      if (changes[key]) { event.preventDefault(); this.changeView(changes[key]); } else if (key === ' ') { event.preventDefault(); this.togglePlay(); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.recording) this.video.pause(); });
  }
  get duration() { return this.info?.duration || 0; }
  get range() { return { start: Number($('cut-start').value), end: Number($('cut-end').value) }; }
  setRange(start, end) { $('cut-start').value = start.toFixed(2); $('cut-end').value = end.toFixed(2); }
  changeView(patch) {
    if (this.replaying) return;
    Object.assign(this.view, patch); this.view.yaw = angle(this.view.yaw); this.view.pitch = clamp(this.view.pitch, -89, 89); this.view.roll = angle(this.view.roll); this.view.fov = clamp(this.view.fov, 30, 120);
    this.readout(); if (this.recording && this.video.paused) this.capture(true);
  }
  readout() {
    $('roll').value = this.view.roll; $('fov').value = this.view.fov;
    $('roll-value').textContent = `${Math.round(this.view.roll)}°`; $('fov-value').textContent = `${Math.round(this.view.fov)}°`;
    $('view-readout').textContent = `PAN ${Math.round(this.view.yaw)}°    TILT ${Math.round(this.view.pitch)}°`;
  }
  applyAspect() {
    const [w, h] = $('aspect').value.split(':').map(Number), stage = $('stage'), frame = $('frame');
    const width = Math.min(stage.clientWidth, stage.clientHeight * w / h);
    frame.style.width = `${width}px`; frame.style.height = `${width * h / w}px`;
  }
  async open(file) {
    if (!file) return;
    this.close(false); const generation = ++this.generation;
    this.file = file; this.info = null; this.ready = false; this.frames = []; this.view = defaultView(); this.prepareJob = null;
    $('aspect').value = '16:9'; $('quality').value = '1080'; this.applyAspect();
    $('viewer-title').textContent = file.name; $('viewer-meta').textContent = 'Original preserved · Local playback';
    $('viewer-loading').hidden = false; $('viewer-loading').classList.remove('failed'); $('loading-title').textContent = 'Preparing your perspective'; $('loading-detail').textContent = 'Creating a local playback preview. Originals stay untouched.';
    $('prepare-progress').hidden = false; $('prepare-progress').value = 0; $('retry-preview').hidden = true; $('cancel-preview').hidden = false;
    $('director-fields').disabled = true; $('play').disabled = true; $('seek').disabled = true; $('photo-note').hidden = true;
    this.dialog.classList.remove('photo-view'); this.dialog.showModal(); document.body.style.overflow = 'hidden'; notice(); this.controls(); this.renderExport();
    try {
      if (!this.renderer) this.renderer = new Panorama(this.canvas);
      const job = await this.post(`/api/media/${file.id}/prepare`); this.prepareJob = job;
      const info = await waitJob(job, state => { if (generation === this.generation) { $('loading-title').textContent = state.status === 'queued' ? 'Your preview is in line' : 'Preparing your perspective'; $('loading-detail').textContent = state.message; $('prepare-progress').value = state.progress; } });
      if (generation !== this.generation) return;
      this.info = info; this.view = defaultView(); this.renderer.source = null;
      const source = info.image ? this.image : this.video;
      // loadeddata/currentTime can precede presentation of the decoded frame.
      // Invalidate the texture when a frame actually arrives, including seeks.
      if (!info.image && source.requestVideoFrameCallback) {
        const presented = () => {
          if (generation !== this.generation) return;
          this.renderer.source = null;
          this.videoFrame = source.requestVideoFrameCallback(presented);
        };
        this.videoFrame = source.requestVideoFrameCallback(presented);
      }
      await new Promise((resolve, reject) => {
        const event = info.image ? 'load' : 'loadeddata';
        const done = () => { cleanup(); resolve(); }, failed = () => { cleanup(); reject(new Error('This browser could not open the preview. Try a current Chrome or Edge browser.')); };
        const timer = setTimeout(failed, 30000);
        const cleanup = () => { clearTimeout(timer); source.removeEventListener(event, done); source.removeEventListener('error', failed); };
        source.addEventListener(event, done); source.addEventListener('error', failed); source.src = this.mediaUrl(info.url); if (!info.image) source.load();
      });
      if (generation !== this.generation) return;
      this.ready = true; this.prepareJob = null;
      // Proxy duration is rounded to a video frame; trim against both timelines.
      if (!info.image) info.duration = Math.min(info.duration, this.video.duration);
      this.setRange(0, this.duration); $('cut-start').max = this.duration; $('cut-end').max = this.duration;
      $('seek').max = this.duration; $('seek').value = 0; $('time-current').textContent = '0:00'; $('time-total').textContent = timecode(this.duration);
      $('viewer-loading').hidden = true; $('photo-note').hidden = !info.image; this.dialog.classList.toggle('photo-view', info.image);
      $('stitch-note').hidden = !info.stitch; $('projection-label').textContent = info.projection === 'equirect' ? '360° VIEW' : 'STANDARD VIDEO';
      $('viewer-meta').textContent = `${info.image ? 'PHOTO' : timecode(info.duration)} · ${info.dual ? 'Dual-lens original' : info.width + ' × ' + info.height} · Original preserved`;
      $('director-fields').disabled = info.image; $('play').disabled = info.image; $('seek').disabled = info.image;
      this.loadDraft(); this.applyAspect(); this.readout(); this.controls(); this.tick();
    } catch (error) { if (generation === this.generation) { this.prepareJob = null; this.loadingError(error.message); } }
  }
  loadingError(message) { $('viewer-loading').hidden = false; $('viewer-loading').classList.add('failed'); $('loading-title').textContent = 'Preview unavailable'; $('loading-detail').textContent = message; $('prepare-progress').hidden = true; $('cancel-preview').hidden = true; $('retry-preview').hidden = false; }
  close(hide = true) {
    if (this.recording) this.finishTake(true);
    this.stopReplay(); this.video.pause(); this.ready = false; this.pointers.clear(); cancelAnimationFrame(this.animation);
    if (this.videoFrame !== undefined) this.video.cancelVideoFrameCallback?.(this.videoFrame);
    this.generation++; if (this.prepareJob && !['complete', 'failed', 'cancelled'].includes(this.prepareJob.status)) this.post(`/api/jobs/${this.prepareJob.id}/cancel`).catch(() => {});
    this.prepareJob = null; this.video.removeAttribute('src'); this.video.load(); this.image.removeAttribute('src');
    if (hide) { this.dialog.close(); document.body.style.overflow = ''; }
  }
  tick() {
    if (!this.ready || !this.dialog.open) return;
    const time = this.video.currentTime;
    if (!this.info.image) {
      if (this.recording) { this.capture(); if (time >= this.range.end || this.video.ended) this.finishTake(false); }
      if (this.replaying) { this.view = samplePath(this.frames, time); this.readout(); if (time >= this.range.end) this.stopReplay(); }
      $('seek').value = time; $('time-current').textContent = timecode(time);
    }
    try { this.renderer.draw(this.info.image ? this.image : this.video, this.info, this.view); }
    catch { this.ready = false; this.loadingError('The graphics context was interrupted. Close and reopen this clip to recover.'); return; }
    this.animation = requestAnimationFrame(() => this.tick());
  }
  async togglePlay() {
    if (!this.ready || this.info.image) return;
    try { if (this.video.paused) { if (this.video.currentTime >= this.duration) this.video.currentTime = this.recording ? this.range.start : 0; await this.video.play(); } else this.video.pause(); } catch (error) { notice(error.message); }
  }
  validRange() { const { start, end } = this.range; if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > this.duration + .01 || end - start < .1 || end - start > 21600) throw new Error('Choose a section within the clip, at least 0.1 seconds long (up to six hours).'); return { start, end }; }
  rangeChanged() { this.clearTake(); try { const range = this.validRange(); this.video.currentTime = range.start; notice(); } catch (e) { notice(e.message); } }
  clearTake() { this.stopReplay(); this.frames = []; this.saveDraft(); this.controls(); $('take-status').textContent = 'Your movements become the final frame.'; }
  controls() {
    const recording = !!this.recording, hasTake = this.frames.length > 0;
    this.dialog.classList.toggle('busy', recording);
    for (const id of ['cut-start', 'cut-end', 'whole-clip', 'set-in', 'set-out', 'aspect', 'quality']) $(id).disabled = recording;
    $('seek').disabled = recording || !this.ready || this.info?.image;
    $('record').classList.toggle('recording', recording);
    $('record').replaceChildren(); const dot = document.createElement('span'); dot.className = 'record-dot'; $('record').append(dot, recording ? 'Finish take' : hasTake ? 'Record a new take' : 'Record camera moves');
    $('take-actions').hidden = !hasTake || recording;
    const rendering = this.exports.get(this.file?.id); $('export-cut').disabled = !hasTake || recording || !!rendering?.running || this.pendingExports.has(this.file?.id);
    $('live-label').className = 'stage-label' + (recording ? ' recording' : ''); $('live-label').textContent = recording ? '● RECORDING MOVES' : this.replaying ? 'TAKE PREVIEW' : 'FREE LOOK';
    $('stop-take').hidden = !recording && !this.replaying;
    $('stop-take').textContent = recording ? 'Finish take' : 'Stop preview';
    for (const id of ['roll', 'fov', 'reset-view']) $(id).disabled = this.replaying;
  }
  async seekTo(time) {
    if (Math.abs(this.video.currentTime - time) < .002 && !this.video.seeking) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('The clip could not seek. Try reopening it.')); }, 15000);
      const done = () => { cleanup(); resolve(); }, cleanup = () => { clearTimeout(timer); this.video.removeEventListener('seeked', done); };
      this.video.addEventListener('seeked', done); this.video.currentTime = time;
    });
  }
  async startTake() {
    try {
      const { start } = this.validRange(); this.stopReplay(); this.video.pause(); notice();
      const generation = this.generation; $('record').disabled = true;
      await this.seekTo(start); if (generation !== this.generation) return;
      this.frames = []; this.recording = true; this.capture(true, start); this.controls();
      $('take-status').textContent = 'Recording your view. Finish early to use a shorter section.';
      await this.video.play();
      if (matchMedia('(max-width:800px)').matches) $('stage').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) { if (this.recording) this.finishTake(true); notice(e.message); }
    finally { $('record').disabled = false; }
  }
  capture(force = false, timestamp = this.video.currentTime) {
    const time = clamp(timestamp, this.range.start, this.range.end), last = this.frames.at(-1);
    if (!force && last && time - last.time < .095) return;
    const frame = { ...this.view, time };
    if (last && time <= last.time + .001) this.frames[this.frames.length - 1] = frame;
    else this.frames.push(frame);
  }
  finishTake(early) {
    if (!this.recording) return;
    const { start, end } = this.range, stop = early ? Math.min(this.video.currentTime, end) : end;
    this.video.pause(); this.capture(true, stop); this.recording = false;
    if (stop - start < .1) { this.frames = []; $('take-status').textContent = 'That take was too short. Record at least 0.1 seconds.'; }
    else { this.setRange(start, stop); $('take-status').textContent = `Take saved · ${(stop - start).toFixed(2)} seconds · ${this.frames.length} camera samples. Preview it or render your MP4.`; }
    this.saveDraft(); this.controls();
  }
  async replay() {
    try {
      this.video.pause(); this.view = samplePath(this.frames, this.range.start); const generation = this.generation;
      await this.seekTo(this.range.start); if (generation !== this.generation) return;
      this.replaying = true; $('replay-take').textContent = 'Ⅱ Stop preview'; this.controls(); await this.video.play();
      if (matchMedia('(max-width:800px)').matches) $('stage').scrollIntoView({ block: 'start', behavior: 'smooth' });
    } catch (e) { this.stopReplay(); notice(e.message); }
  }
  stopReplay() { if (this.replaying) { this.video.pause(); this.replaying = false; $('replay-take').textContent = '▶ Preview take'; this.controls(); } }
  saveDraft() {
    if (!this.file || !this.info || this.info.image) return;
    try { localStorage.setItem(`director:${this.file.id}`, JSON.stringify({ ...this.range, frames: this.frames, aspect: $('aspect').value, quality: $('quality').value })); } catch { /* A full browser store must not interrupt a take. */ }
  }
  loadDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(`director:${this.file.id}`));
      if (draft && draft.start >= 0 && draft.end <= this.duration + .01 && draft.end > draft.start && Array.isArray(draft.frames)) {
        this.setRange(draft.start, draft.end); this.frames = draft.frames;
        if (['16:9', '9:16', '1:1'].includes(draft.aspect)) $('aspect').value = draft.aspect;
        if (['720', '1080'].includes(draft.quality)) $('quality').value = draft.quality;
        $('take-status').textContent = this.frames.length ? 'Your last take is restored. Preview it or record a new one.' : 'Your movements become the final frame.';
      } else $('take-status').textContent = 'Your movements become the final frame.';
    } catch { this.frames = []; }
  }
  async export() {
    const file = this.file;
    if (!file || this.pendingExports.has(file.id) || this.exports.get(file.id)?.running) return;
    this.pendingExports.add(file.id);
    try {
      this.validRange(); notice(); this.video.pause(); $('export-cut').disabled = true;
      const job = await this.post(`/api/media/${file.id}/export`, { ...this.range, frames: this.frames, aspect: $('aspect').value, quality: $('quality').value });
      const item = { file, job, running: true }; this.exports.set(file.id, item); this.renderExport(); this.onExport(this.exports);
      try { item.result = await waitJob(job, state => { item.job = state; this.renderExport(); this.onExport(this.exports); }); }
      catch (error) { item.error = error.message; }
      item.running = false; this.renderExport(); this.onExport(this.exports);
    } catch (e) { notice(e.message); } finally { this.pendingExports.delete(file.id); this.controls(); }
  }
  renderExport() {
    const item = this.exports.get(this.file?.id); $('export-state').hidden = !item;
    if (!item) return;
    $('export-message').textContent = item.result ? `Your cut is ready · ${item.result.width} × ${item.result.height} · ${item.result.duration.toFixed(2)} seconds` : item.error || `${item.job.message} · ${Math.round(item.job.progress * 100)}%`;
    $('export-progress').hidden = !item.running; $('export-progress').value = item.job.progress;
    $('cancel-export').hidden = !item.running; $('download-cut').hidden = !item.result;
    this.controls();
  }
  async saveFile(result) {
    const url = this.mediaUrl(result.url);
    if (window.showSaveFilePicker) {
      let handle;
      try { handle = await window.showSaveFilePicker({ suggestedName: result.filename, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] }); }
      catch (error) { if (error.name === 'AbortError') return; throw error; }
      const response = await fetch(url); if (!response.ok) throw new Error('The cut is unavailable. Render it again.');
      const writable = await handle.createWritable();
      try { await response.body.pipeTo(writable); } catch (error) { await writable.abort().catch(() => {}); throw error; }
    } else { const link = document.createElement('a'); link.href = url; link.download = result.filename; document.body.append(link); link.click(); link.remove(); }
  }
}
