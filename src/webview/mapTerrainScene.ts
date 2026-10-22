/**
 * Worker-backed terrain/model scene for the map placement editor (mapPreviewWebview.ts): the textured tile
 * mesh, cliff faces and water built from the W3E grid, point markers, and an orbit camera.
 *
 * Callers speak map coordinates (world units, as stored in war3map.doo); internally the scene works
 * in tile units with the map centred on the origin, x to the east and z to the south.
 */

import { base64ToBytes } from './webviewUtils';
import { createModelWorker } from './modelThumbnailWorkerClient';

export interface TileTexture {
  id: string;
  label: string;
  dataUri?: string;
  extended: boolean;
  color: string;
}

export interface TerrainData {
  sceneWorkerUri: string;
  assetWorkerUri: string;
  w: number;
  h: number;
  cx: number;
  cy: number;
  min: number;
  max: number;
  tile: number;
  heights: string;
  water: string;
  ground: string;
  cliff: string;
  layer: string;
  flags: string;
  detail: string;
  waterMask: string;
  cliffToGround: number[];
  blightTexture: number;
  textures: TileTexture[];
}

/** One marker in map coordinates. `size` is in CSS pixels; `ring` draws a white outline. */
export interface MarkerPoint {
  x: number;
  y: number;
  color: number[];
  size: number;
  ring?: boolean;
  kind?: string;
  id?: string;
  label?: string;
  z?: number;
  owner?: number;
  modelPath?: string;
  replaceableId?: number;
  replaceableTexture?: string;
  angle?: number;
  scale?: number[];
}

export interface ScreenPoint { x: number; y: number; }

export interface TerrainLayers { terrain: boolean; cliffs: boolean; water: boolean; }

export interface TerrainScene {
  focus(x: number, y: number): void;
  topView(): void;
  render(): void;
  resize(): void;
  setExaggeration(exag: number): void;
  resetView(): void;
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoom(zoomIn: boolean): void;
  setMarkers(points: MarkerPoint[]): void;
  /** Client position of a marker drawn at map position (x, y). */
  markerScreenPosition(x: number, y: number): ScreenPoint | null;
  /** Client position of the terrain surface at map position (x, y). */
  groundScreenPosition(x: number, y: number): ScreenPoint | null;
  /** Map position of the terrain under a client position, or null when the ray misses the map. */
  groundAt(clientX: number, clientY: number): { x: number; y: number } | null;
}

/** Markers float this many tiles above the ground so they are not buried in slopes. */
const MARKER_LIFT = 0.6;
const FOV = 50 * Math.PI / 180;

export function createTerrainScene(canvas: HTMLCanvasElement, DATA: TerrainData, layers: () => TerrainLayers,
  api: { postMessage(message: unknown): void }): TerrainScene | null {
  if (!canvas.transferControlToOffscreen) return null;
  const w = DATA.w, h = DATA.h, tile = DATA.tile, cxh = (w - 1) / 2, czh = (h - 1) / 2;
  const heights = new Int16Array(base64ToBytes(DATA.heights).buffer);
  const worldX = (i: number) => i - cxh, worldZ = (j: number) => czh - j;
  const gridI = (x: number) => (x - DATA.cx) / tile, gridJ = (y: number) => (y - DATA.cy) / tile;
  let markers: MarkerPoint[] = [], dirtyMarkers = true, revision = 0;
  let scene: Worker, assets: Worker, disposed = false;
  const selectionRing = document.getElementById('mp-selection-ring');
  function idx(i, j) { return j * w + i; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function hT(i, j) { return heights[idx(clamp(i,0,w-1), clamp(j,0,h-1))] / tile; }
  function hAt(i, j) {
    var x0 = Math.floor(i), z0 = Math.floor(j);
    var x1 = x0 + 1, z1 = z0 + 1;
    var tx = i - x0, tz = j - z0;
    x0 = clamp(x0, 0, w - 1);
    x1 = clamp(x1, 0, w - 1);
    z0 = clamp(z0, 0, h - 1);
    z1 = clamp(z1, 0, h - 1);
    tx = clamp(tx, 0, 1); tz = clamp(tz, 0, 1);
    var h00 = hT(x0, z0);
    var h10 = hT(x1, z0);
    var h01 = hT(x0, z1);
    var h11 = hT(x1, z1);
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  }
  function mul(a, b) {
    var o = new Float32Array(16);
    for (var r = 0; r < 4; r++) for (var c2 = 0; c2 < 4; c2++) {
      o[c2 * 4 + r] = a[r] * b[c2 * 4] + a[4 + r] * b[c2 * 4 + 1] + a[8 + r] * b[c2 * 4 + 2] + a[12 + r] * b[c2 * 4 + 3];
    }
    return o;
  }
  function perspective(fovy, asp, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    var o = new Float32Array(16);
    o[0] = f / asp; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf;
    return o;
  }
  /** Right/up/back axes of the camera looking from `eye` at `ctr` (the lookAt basis). */
  function cameraBasis(eye, ctr) {
    var zx = eye[0]-ctr[0], zy = eye[1]-ctr[1], zz = eye[2]-ctr[2];
    var zl = Math.sqrt(zx*zx+zy*zy+zz*zz)||1; zx/=zl; zy/=zl; zz/=zl;
    var xx = zz, xy = 0, xz = -zx; // up (0,1,0) × back
    var xl = Math.sqrt(xx*xx+xy*xy+xz*xz)||1; xx/=xl; xy/=xl; xz/=xl;
    var yx = zy*xz-zz*xy, yy = zz*xx-zx*xz, yz = zx*xy-zy*xx;
    return { right: [xx, xy, xz], up: [yx, yy, yz], back: [zx, zy, zz] };
  }
  function lookAt(eye, ctr) {
    var b = cameraBasis(eye, ctr), x = b.right, y = b.up, z = b.back;
    var o = new Float32Array(16);
    o[0]=x[0]; o[1]=y[0]; o[2]=z[0]; o[3]=0;
    o[4]=x[1]; o[5]=y[1]; o[6]=z[1]; o[7]=0;
    o[8]=x[2]; o[9]=y[2]; o[10]=z[2]; o[11]=0;
    o[12]=-(x[0]*eye[0]+x[1]*eye[1]+x[2]*eye[2]);
    o[13]=-(y[0]*eye[0]+y[1]*eye[1]+y[2]*eye[2]);
    o[14]=-(z[0]*eye[0]+z[1]*eye[1]+z[2]*eye[2]);
    o[15]=1;
    return o;
  }

  var exag = 1;
  var yaw, pitch, dist, target, lastMvp;
  function midY() { return ((DATA.min + DATA.max) / 2 / tile) * exag; }
  function resetView() {
    yaw = 0.7; pitch = 0.85;
    dist = Math.max(w, h) * 1.15 + 20;
    target = [0, midY(), 0];
  }
  resetView();

  function eyePos() {
    return [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
  }
  function aspect() { return canvas.clientWidth / Math.max(1, canvas.clientHeight); }
  function farPlane() { return dist * 4 + Math.max(w, h) * 4 + 1000; }
  function viewProj() {
    var proj = perspective(FOV, aspect(), 0.5, farPlane());
    return mul(proj, lookAt(eyePos(), target));
  }

  function render() {
    lastMvp = viewProj();
    const rect = canvas.getBoundingClientRect();
    if (scene) {
      scene.postMessage({ type: 'view', state: {
        yaw, pitch, dist, target, exag, width: Math.max(1, Math.round(rect.width * devicePixelRatio)),
        height: Math.max(1, Math.round(rect.height * devicePixelRatio)), dpr: devicePixelRatio,
        toggles: { ...layers(), units: true, doodads: true, sloc: true },
        ...(dirtyMarkers ? { markers: sceneMarkers(), visible: markers.map((_, i) => i) } : {}),
        selected: markers.findIndex(m => m.ring), revision: ++revision,
        xray: (document.getElementById('mp-xray') as HTMLInputElement).checked,
        models: (document.getElementById('mp-models') as HTMLInputElement).checked,
        animate: (document.getElementById('mp-animate') as HTMLInputElement).checked, paused: document.hidden,
      } });
      dirtyMarkers = false;
    }
    const selected = markers.find(m => m.ring), at = selected && markerScreenPosition(selected.x, selected.y);
    selectionRing.hidden = !at || at.x < rect.left || at.x > rect.right || at.y < rect.top || at.y > rect.bottom;
    if (!selectionRing.hidden) { selectionRing.style.left = at.x + 'px'; selectionRing.style.top = at.y + 'px'; }
  }
  function sceneMarkers() {
    return markers.map(m => ({ ...m, k: m.kind === 'doodad' ? 'doodad' : m.kind === 'start' ? 'start' : 'unit',
      z: m.z ?? hAt(gridI(m.x), gridJ(m.y)) * tile, id: m.id || '', label: m.label || '' }));
  }
  function resize() { render(); }
  function project(pos): ScreenPoint | null {
    var x = pos[0], y = pos[1], z = pos[2], m = lastMvp || viewProj();
    var cx = m[0]*x + m[4]*y + m[8]*z + m[12];
    var cy = m[1]*x + m[5]*y + m[9]*z + m[13];
    var cw = m[3]*x + m[7]*y + m[11]*z + m[15];
    if (cw <= 0) return null;
    var rect = canvas.getBoundingClientRect();
    return { x: rect.left + (cx / cw * 0.5 + 0.5) * rect.width, y: rect.top + (-cy / cw * 0.5 + 0.5) * rect.height };
  }

  /** Scene-space terrain height under scene point (sx, sz), or NaN off the map. */
  function surfaceAt(sx, sz) {
    var gi = sx + cxh, gj = czh - sz;
    if (gi < 0 || gj < 0 || gi > w - 1 || gj > h - 1) return NaN;
    return hAt(gi, gj) * exag;
  }

  function groundAt(clientX: number, clientY: number) {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    var nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    var ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    var eye = eyePos();
    var basis = cameraBasis(eye, target);
    var t = Math.tan(FOV / 2);
    var dir = [0, 1, 2].map(function (k) { return -basis.back[k] + nx * t * aspect() * basis.right[k] + ny * t * basis.up[k]; });
    var dl = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]) || 1;
    dir = dir.map(function (v) { return v / dl; });

    // Only march where the ray is between the lowest and highest terrain point.
    var lo = DATA.min / tile * exag - 1, hi = DATA.max / tile * exag + 1;
    var tStart = 0, tEnd = farPlane();
    if (Math.abs(dir[1]) > 1e-6) {
      var tLo = (lo - eye[1]) / dir[1], tHi = (hi - eye[1]) / dir[1];
      tStart = Math.max(0, Math.min(tLo, tHi));
      tEnd = Math.min(tEnd, Math.max(tLo, tHi));
    } else if (eye[1] < lo || eye[1] > hi) {
      return null;
    }
    var step = 0.25;
    var prevT = tStart, prevAbove = true;
    for (var s = tStart; s <= tEnd + step; s += step) {
      var px = eye[0] + dir[0] * s, py = eye[1] + dir[1] * s, pz = eye[2] + dir[2] * s;
      var hgt = surfaceAt(px, pz);
      if (isNaN(hgt)) { prevAbove = true; prevT = s; continue; }
      var above = py > hgt;
      if (!above && prevAbove && s > tStart) {
        var a = prevT, b = s;
        for (var k = 0; k < 24; k++) {
          var mid = (a + b) / 2;
          var mh = surfaceAt(eye[0] + dir[0] * mid, eye[2] + dir[2] * mid);
          if (!isNaN(mh) && eye[1] + dir[1] * mid > mh) a = mid; else b = mid;
        }
        var hx = eye[0] + dir[0] * b, hz = eye[2] + dir[2] * b;
        return { x: DATA.cx + (hx + cxh) * tile, y: DATA.cy + (czh - hz) * tile };
      }
      prevAbove = above;
      prevT = s;
    }
    return null;
  }


  function markerScreenPosition(x: number, y: number) {
    const gi = gridI(x), gj = gridJ(y);
    return project([worldX(gi), hAt(gi, gj) * exag + MARKER_LIFT, worldZ(gj)]);
  }
  window.addEventListener('message', ({ data: message }) => {
    if (!assets) return;
    if (message.type === 'mdxModel') assets.postMessage({ ...message, type: 'parse' });
    else if (message.type === 'mdxModelMissing') scene.postMessage(message);
    else if (message.type === 'mdxTexture') assets.postMessage({ ...message, type: 'decode' });
    else if (message.type === 'modelThumbTexturesComplete') assets.postMessage({ ...message, type: 'decodeComplete' });
  });
  void Promise.all([
    createModelWorker(DATA.sceneWorkerUri, 'wurst-map-scene').then(worker => { scene = worker; if (disposed) worker.terminate(); return worker; }),
    createModelWorker(DATA.assetWorkerUri, 'wurst-map-assets').then(worker => { assets = worker; if (disposed) worker.terminate(); return worker; }),
  ]).then(workers => {
    if (disposed) { workers.forEach(worker => worker.terminate()); return; }
    [scene, assets] = workers;
    const channel = new MessageChannel();
    scene.postMessage({ type: 'assetPort', port: channel.port1 }, [channel.port1]);
    assets.postMessage({ type: 'scenePort', port: channel.port2 }, [channel.port2]);
    scene.onmessage = ({ data: message }) => {
      if (message.type === 'loadMapModel' || message.type === 'loadMapTextures') api.postMessage(message);
      else if (message.type === 'modelStatus') document.getElementById('mp-model-status').textContent = message.text;
      else if (message.type === 'sceneFrame') { canvas.dataset.ready = 'true'; canvas.dataset.frame = message.revision; }
      else if (message.type === 'sceneError') showError(message.error);
    };
    assets.onerror = () => scene.postMessage({ type: 'assetWorkerFailed' });
    const offscreen = canvas.transferControlToOffscreen();
    scene.postMessage({ type: 'init', canvas: offscreen, data: { ...DATA, markers: sceneMarkers() } }, [offscreen]);
    dirtyMarkers = true; render();
  }).catch(error => { disposed = true; scene?.terminate(); assets?.terminate(); showError(error.message); });
  function showError(message: string) {
    const error = document.getElementById('mp-err'); error.textContent = message; error.style.display = 'grid';
  }
  for (const id of ['mp-models', 'mp-animate', 'mp-xray']) document.getElementById(id).addEventListener('change', render);
  document.addEventListener('visibilitychange', render);
  window.addEventListener('pagehide', () => { disposed = true; scene?.terminate(); assets?.terminate(); });
  return {
    focus(x, y) { target = [worldX(gridI(x)), hAt(gridI(x), gridJ(y)) * exag + MARKER_LIFT, worldZ(gridJ(y))]; dist = 12; render(); },
    topView() { pitch = 1.5; yaw = 0; render(); },
    render,
    resize,
    setExaggeration(value) {
      exag = value || 1;
      target[1] = midY();
      render();
    },
    resetView() { resetView(); render(); },
    orbit(dx, dy) {
      yaw -= dx * 0.006; pitch += dy * 0.006;
      if (pitch > 1.5) pitch = 1.5; else if (pitch < 0.05) pitch = 0.05;
      render();
    },
    pan(dx, dy) {
      var fx = -Math.cos(pitch) * Math.sin(yaw), fy = -Math.sin(pitch), fz = -Math.cos(pitch) * Math.cos(yaw);
      var rx = -fz, rz = fx; var rl = Math.sqrt(rx*rx+rz*rz)||1; rx/=rl; rz/=rl;
      var ux = -fx*fy, uy = fx*fx+fz*fz, uz = -fz*fy; var ul = Math.sqrt(ux*ux+uy*uy+uz*uz)||1; ux/=ul; uy/=ul; uz/=ul;
      var ps = dist * 0.0018;
      target[0] += (-rx * dx + ux * dy) * ps;
      target[1] += (uy * dy) * ps;
      target[2] += (-rz * dx + uz * dy) * ps;
      render();
    },
    zoom(zoomIn) {
      dist *= zoomIn ? 1 / 1.12 : 1.12;
      if (dist < 3) dist = 3; else if (dist > 8000) dist = 8000;
      render();
    },
    setMarkers(points) {
      markers = points;
      dirtyMarkers = true;
      render();
    },
    markerScreenPosition,
    groundScreenPosition(x, y) {
      var gi = gridI(x), gj = gridJ(y);
      return project([worldX(gi), hAt(gi, gj) * exag, worldZ(gj)]);
    },
    groundAt,
  };
}
