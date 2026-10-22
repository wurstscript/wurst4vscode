import { ModelRenderer } from 'war3-model';
import type { TextureSource, parseMDX } from 'war3-model';
import { mat4, vec3, quat } from 'gl-matrix';
import { normalizeAssetPath } from './assetPathUtils';

type ParsedModel = ReturnType<typeof parseMDX>;
type Asset = { path: string; state: 'queued' | 'loading' | 'ready' | 'missing'; renderer?: ModelRenderer; radius: number;
  animated?: boolean; lastUpdate?: number };
type Texture = { source?: TextureSource; gpu?: Map<number, WebGLTexture>; missing?: boolean };

// Inspect animation tracks once, outside the frame loop. Authored sequence intervals alone
// do not imply motion: many static props still contain a long Stand sequence.
function hasMotion(model: ParsedModel, sequence: number): boolean {
  if (model.ParticleEmitters?.length || model.ParticleEmitters2?.length || model.RibbonEmitters?.length) return true;
  const pending: any[] = [model];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) continue;
    const frames = value.Frames || value.Keys?.map(key => key.Frame);
    if (frames) {
      const global = Number.isInteger(value.GlobalSeqId) && value.GlobalSeqId >= 0;
      const [from, to] = global ? [0, model.GlobalSequences?.[value.GlobalSeqId] || 0] : model.Sequences[sequence].Interval;
      let first = -1;
      for (let i = 0; i < frames.length; i++) {
        if (frames[i] < from || frames[i] > to) continue;
        if (first < 0) { first = i; continue; }
        // Cubic tangents can produce motion even between identical endpoint values.
        if (!value.Values || value.LineType > 1) return true;
        const width = value.VectorSize || value.Values.length / frames.length;
        for (let j = 0; j < width; j++) if (value.Values[i * width + j] !== value.Values[first * width + j]) return true;
      }
      continue;
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'Keys' && child && typeof child === 'object') pending.push(child);
  }
  return false;
}

/** One renderer per unique model, shared by all its placements in this map's GL context. */
export class MapModels {
  private assets = new Map<string, Asset>();
  private references = new Set<string>();
  private textures = new Map<string, Texture>();
  private active: Asset;
  private parsed: ParsedModel;
  private pending = new Set<string>();
  private state: any;
  private mvp: Float32Array;
  private pumpTimer: ReturnType<typeof setTimeout>;
  private lastMove = 0;
  private cameraKey = '';
  private waitingForDecode = false;
  private mv = mat4.create();
  private transform = mat4.create();
  private view = mat4.create();
  private projection = mat4.create();
  private inverse = mat4.create();
  private eye = vec3.create();
  private camera = vec3.create();
  private cameraRotation = quat.create();
  private drawn = new Set<any>();
  private warmTarget: WebGLFramebuffer;
  private warmMatrix = mat4.create();
  private animationCursor = 0;
  private lastAnimation = 0;

  constructor(private gl: WebGL2RenderingContext, private data: any, private heightAt: (x: number, y: number) => number,
    private redraw: () => void, private post: (message: any) => void) {
    this.setMarkers(data.markers);
  }
  setMarkers(markers: any[]): void {
    this.data.markers = markers;
    this.references = new Set(markers.filter(item => item.modelPath).map(item => normalizeAssetPath(item.modelPath)));
    for (const item of markers) if (item.modelPath && !this.assets.has(normalizeAssetPath(item.modelPath))) {
      this.assets.set(normalizeAssetPath(item.modelPath), { path: item.modelPath, state: 'queued', radius: 2 });
    }
    this.status();
  }
  wasDrawn(item: any): boolean { return this.drawn.has(item); }
  setView(state: any, mvp: Float32Array): void {
    const playing = state.animate && state.models && !state.paused;
    const wasPlaying = this.state?.animate && this.state.models && !this.state.paused;
    if (!!playing !== !!wasPlaying) {
      this.lastAnimation = 0;
      for (const asset of this.assets.values()) asset.lastUpdate = undefined;
    }
    this.state = state; this.mvp = mvp;
    const key = [state.yaw, state.pitch, state.dist, ...state.target].join(',');
    if (key !== this.cameraKey) { this.cameraKey = key; this.lastMove = performance.now(); }
    this.schedule();
  }
  private schedule(): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => { this.pumpTimer = undefined; void this.pump(); }, 16);
  }
  private status(): void {
    let ready = 0, missing = 0;
    for (const key of this.references) {
      const entry = this.assets.get(key);
      if (entry?.state === 'ready') ready++;
      if (entry?.state === 'missing') missing++;
    }
    this.post({ type: 'modelStatus', text: `${ready}/${this.references.size} models${missing ? ` · ${missing} unavailable` : ''}` });
  }
  private async pump(): Promise<void> {
    if (!this.state || this.state.paused || !this.state.models) return;
    if (this.active) {
      if (!this.parsed || this.pending.size || this.waitingForDecode) return;
      if (!this.references.has(normalizeAssetPath(this.active.path))) {
        this.active.state = 'queued'; this.active = undefined; this.parsed = undefined;
        this.status(); this.schedule(); return;
      }
      // Parsing and decoding happen in the asset worker. Avoid starting GL preparation mid-drag.
      if (performance.now() - this.lastMove < 80) { this.schedule(); return; }
      const asset = this.active, model = this.parsed;
      this.parsed = undefined;
      try {
        const renderer = new ModelRenderer(model);
        asset.renderer = renderer;
        renderer.setEnvironmentMapProcessingEnabled(false);
        renderer.setTextureSizeLimit(256);
        renderer.initGL(this.gl);
        renderer.setLightingOptions({ ambient: 0.75, diffuse: 0.4 });
        let sequence = model.Sequences.findIndex(s => /^stand(?:\s|$)/i.test(s.Name));
        if (sequence < 0) sequence = model.Sequences.findIndex(s => !s.NonLooping && !/death|decay|birth/i.test(s.Name));
        renderer.setPose(Math.max(0, sequence), 1);
        asset.animated = hasMotion(model, Math.max(0, sequence));
        for (const texture of model.Textures) {
          const shared = this.textures.get(normalizeAssetPath(texture.Image));
          const gpu = shared?.gpu?.get(texture.Flags || 0);
          if (gpu) renderer.adoptTexture(texture.Image, gpu);
        }
        let uploadTurn = Promise.resolve();
        await renderer.loadTextures(texture => {
          const turn = uploadTurn.then(() => {
            if (!this.references.has(normalizeAssetPath(asset.path))) throw new Error('Placement removed');
            const source = this.textures.get(normalizeAssetPath(texture.Image))?.source;
            if (!source) throw new Error('Texture unavailable');
            return source;
          });
          // Yield between uploads so a texture-heavy model cannot monopolize scene input.
          uploadTurn = turn.then(() => undefined, () => undefined).then(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
          return turn;
        }, { allowMissingTextures: true });
        if (!this.references.has(normalizeAssetPath(asset.path))) throw new Error('Placement removed');
        await this.prepare(renderer);
        // Cache the uploaded object too: another model using this texture borrows it directly.
        for (const texture of model.Textures) {
          const shared = this.textures.get(normalizeAssetPath(texture.Image));
          const gpu = renderer.getTexture(texture.Image);
          if (shared && gpu) {
            shared.gpu ??= new Map();
            if (!shared.gpu.has(texture.Flags || 0)) shared.gpu.set(texture.Flags || 0, gpu);
            shared.source = undefined;
          }
        }
        asset.radius = Math.max(0.1, (model.Info.BoundsRadius || 256) / this.data.tile);
        asset.state = 'ready';
      } catch {
        asset.renderer?.destroy(); asset.renderer = undefined;
        asset.state = this.references.has(normalizeAssetPath(asset.path)) ? 'missing' : 'queued';
      }
      this.active = undefined; this.status(); this.redraw(); this.schedule();
      return;
    }
    // Recalculate priorities after every completed asset, so camera movement can change the queue.
    let next: Asset;
    for (const index of [this.state.selected, ...this.state.visible]) {
      const item = this.data.markers[index];
      const asset = item && this.assets.get(normalizeAssetPath(item.modelPath || ''));
      if (asset?.state === 'queued' && this.inView(item, 3)) { next = asset; break; }
    }
    next ||= [...this.assets.values()].find(asset => asset.state === 'queued' && this.references.has(normalizeAssetPath(asset.path)));
    if (!next) return;
    this.active = next; next.state = 'loading';
    this.post({ type: 'loadMapModel', path: next.path });
    this.status();
  }
  private async prepare(renderer: ModelRenderer): Promise<void> {
    const gl = this.gl;
    if (!this.warmTarget) {
      this.warmTarget = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.warmTarget);
      const color = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, color);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1, 1);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.warmTarget);
    let prepared: Promise<void>;
    try {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Model preparation target unavailable');
      gl.viewport(0, 0, 1, 1); gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // allowMissingTextures skips renderAsync's initial texture await (every reply has already
      // settled), so its draw happens inside this framebuffer before it awaits the GPU fence.
      prepared = renderer.renderAsync(this.warmMatrix, this.warmMatrix, { allowMissingTextures: true, useEnvironmentMap: false });
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.state.width, this.state.height);
    }
    await prepared;
  }
  receive(message: any): void {
    if (message.type === 'mdxModelMissing' || message.type === 'modelFailed') {
      if (message.path !== this.active?.path) return;
      this.active.state = 'missing'; this.active = undefined; this.parsed = undefined;
      this.status(); this.redraw(); this.schedule();
    } else if (message.type === 'parsedModel') {
      if (message.path !== this.active?.path) return;
      if (!this.references.has(normalizeAssetPath(message.path))) {
        this.active.state = 'queued'; this.active = undefined;
        this.status(); this.schedule(); return;
      }
      this.parsed = message.model;
      this.pending.clear();
      const paths = [];
      for (const texture of this.parsed.Textures) {
        if (!texture.Image) continue;
        const key = normalizeAssetPath(texture.Image);
        const cached = this.textures.get(key);
        if (cached?.source || cached?.missing || cached?.gpu?.has(texture.Flags || 0) || this.pending.has(key)) continue;
        this.pending.add(key); paths.push(texture.Image);
      }
      this.waitingForDecode = paths.length > 0;
      if (paths.length) this.post({ type: 'loadMapTextures', path: this.active.path, paths });
      else this.schedule();
    } else if (message.type === 'decodedTexture') {
      if (message.thumbKey !== this.active?.path) return;
      const key = normalizeAssetPath(message.path);
      if (!this.pending.delete(key)) return;
      this.textures.set(key, { ...this.textures.get(key), source: message.source, missing: !!message.error });
      // Wait for the ordered terminal reply before retiring a removed asset or retrying it.
    } else if (message.type === 'decodedTexturesComplete') {
      if (message.thumbKey !== this.active?.path) return;
      // This message travels through the decode worker, behind every individual texture reply.
      for (const key of this.pending) this.textures.set(key, { missing: true });
      this.pending.clear(); this.waitingForDecode = false; this.schedule();
    } else if (message.type === 'assetWorkerFailed') {
      for (const asset of this.assets.values()) if (asset.state !== 'ready') asset.state = 'missing';
      this.active = undefined; this.parsed = undefined; this.pending.clear();
      this.status(); this.redraw();
    }
  }
  private position(item: any): number[] {
    const x = (item.x - this.data.cx) / this.data.tile, y = (item.y - this.data.cy) / this.data.tile;
    return [x - (this.data.w - 1) / 2, (Number.isFinite(item.z) ? item.z / this.data.tile : this.heightAt(x, y)) * this.state.exag,
      (this.data.h - 1) / 2 - y];
  }
  private inView(item: any, radius: number): boolean {
    const [x, y, z] = this.position(item), m = this.mvp;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const margin = radius * Math.max(Math.abs(m[0]), Math.abs(m[5]), 1);
    if (w < -margin) return false;
    return [0, 1, 2].every(i => Math.abs(m[i] * x + m[4 + i] * y + m[8 + i] * z + m[12 + i]) <= w + margin);
  }
  private advance(assets: Asset[], now: number): void {
    if (!assets.length || now - this.lastAnimation < 1000 / 30) return;
    this.lastAnimation = now;
    const start = performance.now();
    // Round-robin unique visible models, with a soft 4 ms CPU budget. Each update is
    // indivisible, but expensive crowds cannot force every skeleton to update together.
    this.animationCursor %= assets.length;
    for (let count = 0; count < assets.length; count++) {
      const asset = assets[this.animationCursor];
      this.animationCursor = (this.animationCursor + 1) % assets.length;
      try {
        asset.renderer.update(Math.min(100, asset.lastUpdate === undefined ? 1000 / 30 : now - asset.lastUpdate));
        asset.lastUpdate = now;
      } catch { asset.state = 'missing'; this.status(); }
      if (performance.now() - start >= 4) break;
    }
  }
  draw(mvp: Float32Array, exaggeration: number, state: any): boolean {
    this.drawn.clear();
    if (!state.models || state.paused) return false;
    vec3.set(this.eye, state.target[0] + state.dist * Math.cos(state.pitch) * Math.sin(state.yaw),
      state.target[1] + state.dist * Math.sin(state.pitch), state.target[2] + state.dist * Math.cos(state.pitch) * Math.cos(state.yaw));
    mat4.lookAt(this.view, this.eye, state.target, [0, 1, 0]);
    mat4.invert(this.inverse, this.view);
    mat4.multiply(this.projection, mvp as mat4, this.inverse);
    const placements = [];
    const animated = new Set<Asset>();
    for (const index of state.visible) {
      const item = this.data.markers[index], asset = this.assets.get(normalizeAssetPath(item.modelPath || ''));
      if (asset?.state !== 'ready') continue;
      const scale = item.scale || [1, 1, 1];
      if (scale.some(value => !Number.isFinite(value) || value === 0)) continue;
      if (!this.inView(item, asset.radius * Math.max(...scale) * exaggeration)) continue;
      const [x, y, z] = this.position(item);
      const clipW = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
      // At overview scale, subpixel models cost many draw calls without contributing detail.
      // Keep their markers until zooming brings the actual geometry into view.
      if (asset.radius * Math.max(...scale) * state.height / Math.max(0.01, clipW) < 1.5 && index !== state.selected) continue;
      placements.push({ item, asset, scale, x, y, z });
      if (state.animate && asset.animated) animated.add(asset);
    }
    this.advance([...animated], performance.now());
    for (const { item, asset, scale, x, y, z } of placements) {
      if (asset.state !== 'ready') continue;
      const angle = item.angle || 0, c = Math.cos(angle), s = Math.sin(angle), t = this.data.tile, matrix = this.transform;
      mat4.set(matrix, c * scale[0] / t, 0, -s * scale[0] / t, 0,
        -s * scale[1] / t, 0, -c * scale[1] / t, 0,
        0, scale[2] * exaggeration / t, 0, 0, x, y, z, 1);
      mat4.multiply(this.mv, this.view, matrix);
      const renderer = asset.renderer;
      const color = item.color || this.data.playerColors?.[item.owner] || [1, 0.7, 0.3];
      renderer.setTeamColor(color as vec3);
      mat4.invert(this.inverse, matrix);
      vec3.transformMat4(this.camera, this.eye, this.inverse);
      mat4.invert(this.inverse, this.mv);
      mat4.getRotation(this.cameraRotation, this.inverse);
      quat.normalize(this.cameraRotation, this.cameraRotation);
      renderer.setCamera(this.camera, this.cameraRotation);
      renderer.setLightPosition(this.camera);
      try {
        renderer.render(this.mv, this.projection, { useEnvironmentMap: false });
        this.drawn.add(item);
      } catch {
        asset.state = 'missing'; this.status(); this.redraw();
      }
    }
    return animated.size > 0;
  }
}
