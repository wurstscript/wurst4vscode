/**
 * Raw-WebGL terrain scene for the map placement editor (mapPreviewWebview.ts): the textured tile
 * mesh, cliff faces and water built from the W3E grid, point markers, and an orbit camera.
 *
 * Callers speak map coordinates (world units, as stored in war3map.doo); internally the scene works
 * in tile units with the map centred on the origin, x to the east and z to the south.
 */

import { base64ToBytes } from './webviewUtils';

export interface TileTexture {
  id: string;
  label: string;
  dataUri?: string;
  extended: boolean;
  color: string;
}

export interface TerrainData {
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
}

export interface ScreenPoint { x: number; y: number; }

export interface TerrainLayers { terrain: boolean; cliffs: boolean; water: boolean; }

export interface TerrainScene {
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

export function createTerrainScene(canvas: HTMLCanvasElement, DATA: TerrainData, layers: () => TerrainLayers): TerrainScene | null {
  var w = DATA.w, h = DATA.h, tile = DATA.tile;
  var heights = new Int16Array(base64ToBytes(DATA.heights).buffer);
  var water = new Int16Array(base64ToBytes(DATA.water).buffer);
  var ground = base64ToBytes(DATA.ground);
  var cliff = base64ToBytes(DATA.cliff);
  var layer = base64ToBytes(DATA.layer);
  var flags = base64ToBytes(DATA.flags);
  var detail = base64ToBytes(DATA.detail);
  var waterMask = base64ToBytes(DATA.waterMask);
  var cxh = (w - 1) / 2, czh = (h - 1) / 2;
  var cellsX = Math.max(0, w - 1), cellsZ = Math.max(0, h - 1);
  function worldX(i) { return i - cxh; }
  function worldZ(j) { return czh - j; }

  var gl: WebGLRenderingContext = canvas.getContext('webgl2') as any;
  var isGL2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl');
  if (!gl) return null;
  var uintOK = isGL2 || !!gl.getExtension('OES_element_index_uint');
  var IndexArray: any = uintOK ? Uint32Array : Uint16Array;
  var indexType = uintOK ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

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
  function wT(i, j) { return water[idx(clamp(i,0,w-1), clamp(j,0,h-1))] / tile; }
  function rampAt(i, j) { return (flags[idx(clamp(i,0,w-1), clamp(j,0,h-1))] & 0x10) ? 1 : 0; }
  function waterAt(i, j) { return waterMask[idx(clamp(i,0,w-1), clamp(j,0,h-1))] ? 1 : 0; }
  function blightAt(i, j) { return (flags[idx(clamp(i,0,w-1), clamp(j,0,h-1))] & 0x20) ? 1 : 0; }
  function layerAt(i, j) { return layer[idx(clamp(i,0,w-1), clamp(j,0,h-1))]; }
  function detailAt(i, j) { return detail[idx(clamp(i,0,w-1), clamp(j,0,h-1))]; }
  function rawTileAt(i, j) {
    var k = idx(clamp(i,0,w-1), clamp(j,0,h-1));
    var t = ground[k];
    return t < Math.max(1, DATA.textures.length) ? t : 0;
  }
  function isExtendedTile(t) {
    return !!(DATA.textures[t] && DATA.textures[t].extended);
  }
  function get_tile_variation(ground_texture, variation) {
    if (isExtendedTile(ground_texture)) {
      if (variation <= 15) return 16 + variation;
      if (variation === 16) return 15;
      return 0;
    }
    return variation === 0 ? 0 : 15;
  }
  function cliffAt(i, j) {
    var k = idx(clamp(i,0,w-1), clamp(j,0,h-1));
    return cliff[k];
  }
  function cornerCliffAt(i, j) {
    if (i < 0 || j < 0 || i >= w - 1 || j >= h - 1) return 0;
    var bl = layerAt(i, j);
    return bl !== layerAt(i + 1, j) || bl !== layerAt(i, j + 1) || bl !== layerAt(i + 1, j + 1) ? 1 : 0;
  }
  function tileAt(i, j) {
    i = clamp(i, 0, w - 1); j = clamp(j, 0, h - 1);
    var aCliff = cornerCliffAt(i, j);
    if (i > 0) aCliff = aCliff || cornerCliffAt(i - 1, j);
    if (j > 0) aCliff = aCliff || cornerCliffAt(i, j - 1);
    if (i > 0 && j > 0) aCliff = aCliff || cornerCliffAt(i - 1, j - 1);
    if (aCliff && !rampAt(i, j)) {
      var texture = cliffAt(i, j);
      if (texture === 15) texture -= 14;
      var mapped = DATA.cliffToGround && DATA.cliffToGround[texture];
      return mapped >= 0 && mapped < DATA.textures.length ? mapped : rawTileAt(i, j);
    }
    if (blightAt(i, j) && DATA.blightTexture >= 0) return DATA.blightTexture;
    return rawTileAt(i, j);
  }
  function cellLayerAt(i, j) {
    return Math.round((layerAt(i,j) + layerAt(i+1,j) + layerAt(i,j+1) + layerAt(i+1,j+1)) / 4);
  }
  function cellRampAt(i, j) {
    return rampAt(i,j) || rampAt(i+1,j) || rampAt(i,j+1) || rampAt(i+1,j+1);
  }
  function cellWaterAt(i, j) {
    return waterAt(i,j) || waterAt(i+1,j) || waterAt(i,j+1) || waterAt(i+1,j+1);
  }
  function tileLayers(i, j) {
    var bl = tileAt(i, j);
    var br = tileAt(i + 1, j);
    var tr = tileAt(i + 1, j + 1);
    var tl = tileAt(i, j + 1);

    var unique = [bl, br, tr, tl];
    unique.sort(function (a, b) { return a - b; });
    var last = unique.length;
    for (var n = 1, write = 1; n < unique.length; n++) {
      if (unique[n] !== unique[n - 1]) unique[write++] = unique[n];
      last = write;
    }

    var result = [];
    result.push([unique[0], get_tile_variation(unique[0], detailAt(i, j) & 0x1f)]);
    for (var u = 1; u < last; u++) {
      var t = unique[u];
      var mask = 0;
      if (br === t) mask |= 1;
      if (bl === t) mask |= 2;
      if (tr === t) mask |= 4;
      if (tl === t) mask |= 8;
      if (mask !== 0) result.push([t, mask]);
      if (result.length >= 4) break;
    }
    return result;
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    var n = m ? parseInt(m[1], 16) : 0x608050;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  var atlasSize = 256;
  var atlasCount = Math.max(1, DATA.textures.length);
  var atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = atlasSize * atlasCount;
  atlasCanvas.height = atlasSize;
  var atlasCtx = atlasCanvas.getContext('2d');
  function drawFallbackTile(n) {
    var tex = DATA.textures[n] || { color: '#5c8050', id: '' };
    var rgb = hexToRgb(tex.color);
    var x0 = n * atlasSize;
    atlasCtx.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    atlasCtx.fillRect(x0, 0, atlasSize, atlasSize);
    for (var y = 0; y < atlasSize; y += 8) {
      for (var x = 0; x < atlasSize; x += 8) {
        var shade = ((x * 13 + y * 7 + n * 19) & 31) - 16;
        atlasCtx.fillStyle = 'rgba(' + clamp(rgb[0] + shade,0,255) + ',' + clamp(rgb[1] + shade,0,255) + ',' + clamp(rgb[2] + shade,0,255) + ',0.35)';
        atlasCtx.fillRect(x0 + x, y, 8, 8);
      }
    }
  }
  for (var ti = 0; ti < atlasCount; ti++) drawFallbackTile(ti);

  var atlasTex = gl.createTexture();
  function uploadAtlas() {
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }
  uploadAtlas();
  DATA.textures.forEach(function (tex, n) {
    if (!tex.dataUri) return;
    var img = new Image();
    img.onload = function () {
      atlasCtx.clearRect(n * atlasSize, 0, atlasSize, atlasSize);
      atlasCtx.drawImage(img, n * atlasSize, 0, atlasSize, atlasSize);
      uploadAtlas();
      render();
    };
    img.src = tex.dataUri;
  });

  function normalFor(i, j, exag) {
    var dyI = (hAt(i + 0.5, j) - hAt(i - 0.5, j)) * exag;
    var dyJ = (hAt(i, j + 0.5) - hAt(i, j - 0.5)) * exag;
    var nx = -dyI, ny = 2.0, nz = dyJ;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [nx / L, ny / L, nz / L];
  }

  var surfVertices = Math.max(1, cellsX * cellsZ * 4);
  var surfPositions = new Float32Array(surfVertices * 3);
  var surfNormals = new Float32Array(surfVertices * 3);
  var surfUvs = new Float32Array(surfVertices * 2);
  var surfTex0 = new Float32Array(surfVertices * 3);
  var surfTex1 = new Float32Array(surfVertices * 3);
  var surfTex2 = new Float32Array(surfVertices * 3);
  var surfTex3 = new Float32Array(surfVertices * 3);
  var surfRamps = new Float32Array(surfVertices);
  var surfLevels = new Float32Array(surfVertices);
  var surfIndices = new IndexArray(Math.max(0, cellsX * cellsZ * 6));
  var surfIndexCount = 0;

  var cliffEdges = [];
  for (var ej = 0; ej < cellsZ; ej++) {
    for (var ei = 1; ei < cellsX; ei++) {
      var ll = cellLayerAt(ei - 1, ej), lr = cellLayerAt(ei, ej);
      if (ll !== lr) cliffEdges.push([ei, ej, ei, ej + 1, cliffAt(ei, ej), cellRampAt(ei - 1, ej) || cellRampAt(ei, ej), Math.max(ll, lr), Math.min(ll, lr)]);
    }
  }
  for (var ej2 = 1; ej2 < cellsZ; ej2++) {
    for (var ei2 = 0; ei2 < cellsX; ei2++) {
      var ls = cellLayerAt(ei2, ej2 - 1), ln = cellLayerAt(ei2, ej2);
      if (ls !== ln) cliffEdges.push([ei2, ej2, ei2 + 1, ej2, cliffAt(ei2, ej2), cellRampAt(ei2, ej2 - 1) || cellRampAt(ei2, ej2), Math.max(ls, ln), Math.min(ls, ln)]);
    }
  }
  var cliffPositions = new Float32Array(Math.max(1, cliffEdges.length * 4 * 3));
  var cliffNormals = new Float32Array(Math.max(1, cliffEdges.length * 4 * 3));
  var cliffUvs = new Float32Array(Math.max(1, cliffEdges.length * 4 * 2));
  var cliffTex0 = new Float32Array(Math.max(1, cliffEdges.length * 4 * 3));
  var cliffTex1 = new Float32Array(Math.max(1, cliffEdges.length * 4 * 3));
  var cliffTex2 = new Float32Array(Math.max(1, cliffEdges.length * 4 * 3));
  var cliffTex3 = new Float32Array(Math.max(1, cliffEdges.length * 4 * 3));
  var cliffRamps = new Float32Array(Math.max(1, cliffEdges.length * 4));
  var cliffLevels = new Float32Array(Math.max(1, cliffEdges.length * 4));
  var cliffIndices = new IndexArray(Math.max(0, cliffEdges.length * 6));
  for (var ce = 0; ce < cliffEdges.length; ce++) {
    var cb = ce * 4, ii = ce * 6;
    cliffIndices[ii] = cb; cliffIndices[ii + 1] = cb + 1; cliffIndices[ii + 2] = cb + 2;
    cliffIndices[ii + 3] = cb + 1; cliffIndices[ii + 4] = cb + 3; cliffIndices[ii + 5] = cb + 2;
  }

  function writeV(arr, v, x, y, z) {
    arr[v * 3] = x; arr[v * 3 + 1] = y; arr[v * 3 + 2] = z;
  }
  function writeN(arr, v, n) {
    arr[v * 3] = n[0]; arr[v * 3 + 1] = n[1]; arr[v * 3 + 2] = n[2];
  }
  function writeUv(arr, v, u, vv) {
    arr[v * 2] = u; arr[v * 2 + 1] = vv;
  }
  function writeTex(arr, v, t, variant) {
    arr[v * 3] = t;
    arr[v * 3 + 1] = variant;
    arr[v * 3 + 2] = t >= 0 && isExtendedTile(t) ? 1 : 0;
  }

  var waterCells = [];
  for (var wj = 0; wj < cellsZ; wj++) for (var wi = 0; wi < cellsX; wi++) if (cellWaterAt(wi, wj)) waterCells.push([wi, wj]);
  var waterVerts = Math.max(1, waterCells.length * 4);
  var waterPositions = new Float32Array(waterVerts * 3);
  var waterDepths = new Float32Array(waterVerts);
  var waterIndices = new IndexArray(Math.max(0, waterCells.length * 6));
  for (var wc = 0; wc < waterCells.length; wc++) {
    var wb = wc * 4, wii = wc * 6;
    waterIndices[wii] = wb; waterIndices[wii + 1] = wb + 2; waterIndices[wii + 2] = wb + 1;
    waterIndices[wii + 3] = wb + 1; waterIndices[wii + 4] = wb + 2; waterIndices[wii + 5] = wb + 3;
  }

  function buildTerrain(exag) {
    surfIndexCount = 0;
    for (var j = 0; j < cellsZ; j++) {
      for (var i = 0; i < cellsX; i++) {
        var b = (j * cellsX + i) * 4;
        var tiles = tileLayers(i, j);
        var r = cellRampAt(i, j);
        var levelTint = Math.max(0, cellLayerAt(i, j) - 2) * 0.18;
        var corners = [[i,j,0,0],[i+1,j,1,0],[i,j+1,0,1],[i+1,j+1,1,1]];
        for (var c = 0; c < 4; c++) {
          var q = corners[c], v = b + c, n = normalFor(q[0], q[1], exag);
          writeV(surfPositions, v, worldX(q[0]), hT(q[0], q[1]) * exag, worldZ(q[1]));
          writeN(surfNormals, v, n);
          writeUv(surfUvs, v, q[2], q[3]);
          writeTex(surfTex0, v, tiles[0] ? tiles[0][0] : -1, tiles[0] ? tiles[0][1] : 0);
          writeTex(surfTex1, v, tiles[1] ? tiles[1][0] : -1, tiles[1] ? tiles[1][1] : 0);
          writeTex(surfTex2, v, tiles[2] ? tiles[2][0] : -1, tiles[2] ? tiles[2][1] : 0);
          writeTex(surfTex3, v, tiles[3] ? tiles[3][0] : -1, tiles[3] ? tiles[3][1] : 0);
          surfRamps[v] = r;
          surfLevels[v] = levelTint;
        }
        var si2 = surfIndexCount;
        surfIndices[si2] = b;
        surfIndices[si2 + 1] = b + 2;
        surfIndices[si2 + 2] = b + 1;
        surfIndices[si2 + 3] = b + 1;
        surfIndices[si2 + 4] = b + 2;
        surfIndices[si2 + 5] = b + 3;
        surfIndexCount += 6;
      }
    }

    for (var e = 0; e < cliffEdges.length; e++) {
      var edge = cliffEdges[e];
      var x1 = worldX(edge[0]), z1 = worldZ(edge[1]);
      var x2 = worldX(edge[2]), z2 = worldZ(edge[3]);
      var yhi = Math.max(hT(edge[0], edge[1]), hT(edge[2], edge[3])) * exag;
      var ylo = yhi - Math.max(0.35, Math.abs(edge[6] - edge[7])) * exag;
      var dx = x2 - x1, dz = z2 - z1;
      var len = Math.sqrt(dx * dx + dz * dz) || 1;
      var nrm = [dz / len, 0, -dx / len];
      var v0 = e * 4;
      writeV(cliffPositions, v0, x1, ylo, z1);
      writeV(cliffPositions, v0 + 1, x2, ylo, z2);
      writeV(cliffPositions, v0 + 2, x1, yhi, z1);
      writeV(cliffPositions, v0 + 3, x2, yhi, z2);
      for (var cv = 0; cv < 4; cv++) {
        writeN(cliffNormals, v0 + cv, nrm);
        writeTex(cliffTex0, v0 + cv, 0, 0);
        writeTex(cliffTex1, v0 + cv, -1, 0);
        writeTex(cliffTex2, v0 + cv, -1, 0);
        writeTex(cliffTex3, v0 + cv, -1, 0);
        cliffRamps[v0 + cv] = edge[5] ? 1 : 0;
        cliffLevels[v0 + cv] = 0.7;
      }
      writeUv(cliffUvs, v0, 0, 0); writeUv(cliffUvs, v0 + 1, 1, 0);
      writeUv(cliffUvs, v0 + 2, 0, 1); writeUv(cliffUvs, v0 + 3, 1, 1);
    }

    for (var wc2 = 0; wc2 < waterCells.length; wc2++) {
      var cell = waterCells[wc2], ii2 = cell[0], jj2 = cell[1], wb2 = wc2 * 4;
      var wh = (wT(ii2,jj2) + wT(ii2+1,jj2) + wT(ii2,jj2+1) + wT(ii2+1,jj2+1)) / 4;
      var th = (hT(ii2,jj2) + hT(ii2+1,jj2) + hT(ii2,jj2+1) + hT(ii2+1,jj2+1)) / 4;
      var wy = Math.max(wh, th + 0.025) * exag + 0.015;
      var depth = clamp((wh - th) * 0.8 + 0.35, 0.25, 0.85);
      writeV(waterPositions, wb2, worldX(ii2), wy, worldZ(jj2));
      writeV(waterPositions, wb2 + 1, worldX(ii2 + 1), wy, worldZ(jj2));
      writeV(waterPositions, wb2 + 2, worldX(ii2), wy, worldZ(jj2 + 1));
      writeV(waterPositions, wb2 + 3, worldX(ii2 + 1), wy, worldZ(jj2 + 1));
      waterDepths[wb2] = depth; waterDepths[wb2 + 1] = depth; waterDepths[wb2 + 2] = depth; waterDepths[wb2 + 3] = depth;
    }
  }

  function compile(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(p));
    return p;
  }
  var terrainProg = program(
    'attribute vec3 aPos; attribute vec3 aNormal; attribute vec2 aUv; attribute vec3 aTex0; attribute vec3 aTex1; attribute vec3 aTex2; attribute vec3 aTex3; attribute float aRamp; attribute float aLevel; uniform mat4 uMVP; varying vec3 vN; varying vec2 vUv; varying vec3 vTex0; varying vec3 vTex1; varying vec3 vTex2; varying vec3 vTex3; varying float vRamp; varying float vLevel; void main(){ vN=aNormal; vUv=aUv; vTex0=aTex0; vTex1=aTex1; vTex2=aTex2; vTex3=aTex3; vRamp=aRamp; vLevel=aLevel; gl_Position=uMVP*vec4(aPos,1.0); }',
    'precision mediump float; varying vec3 vN; varying vec2 vUv; varying vec3 vTex0; varying vec3 vTex1; varying vec3 vTex2; varying vec3 vTex3; varying float vRamp; varying float vLevel; uniform sampler2D uAtlas; uniform float uAtlasCount; uniform float uCliff; vec4 layer(vec3 tv){ if(tv.x < -0.5) return vec4(0.0); float raw=floor(tv.y+0.5); float ext=step(0.5,tv.z); float vi=mod(raw,16.0); float side=step(16.0,raw); float cols=mix(4.0,8.0,ext); float vx=mod(vi,4.0)+side*4.0*ext; float vy=floor(vi/4.0); vec2 uv=vec2(vUv.x,1.0-vUv.y); vec2 sub=(vec2(vx,vy)+clamp(uv,vec2(0.012),vec2(0.988)))/vec2(cols,4.0); return texture2D(uAtlas,vec2((tv.x+sub.x)/uAtlasCount,sub.y)); } void main(){ vec4 base=layer(vTex3); base=mix(layer(vTex2),base,base.a); base=mix(layer(vTex1),base,base.a); base=mix(layer(vTex0),base,base.a); vec3 L=normalize(vec3(0.45,1.0,0.35)); float dif=max(dot(normalize(vN),L),0.0); vec3 col=base.rgb*(0.48+0.66*dif); col=mix(col, vec3(0.98,0.68,0.28), vRamp*0.24); col=mix(col, vec3(0.50,0.40,0.26), clamp(vLevel,0.0,0.65)); col=mix(col, vec3(0.34,0.27,0.18), uCliff); float a=base.a; if (a < 0.004) discard; gl_FragColor=vec4(col, a); }'
  );
  var pointProg = program(
    'attribute vec3 aPos; attribute vec3 aColor; attribute float aSize; attribute float aRing; uniform mat4 uMVP; varying vec3 vColor; varying float vRing; void main(){ vColor=aColor; vRing=aRing; gl_Position=uMVP*vec4(aPos,1.0); gl_PointSize=aSize; }',
    'precision mediump float; varying vec3 vColor; varying float vRing; void main(){ float d=length(gl_PointCoord-vec2(0.5)); if(d>0.5) discard; gl_FragColor = (vRing > 0.5 && d > 0.34) ? vec4(1.0) : vec4(vColor,1.0); }'
  );
  var waterProg = program(
    'attribute vec3 aPos; attribute float aDepth; uniform mat4 uMVP; varying float vDepth; void main(){ vDepth=aDepth; gl_Position=uMVP*vec4(aPos,1.0); }',
    'precision mediump float; varying float vDepth; void main(){ vec3 shallow=vec3(0.18,0.58,0.67); vec3 deep=vec3(0.04,0.23,0.36); vec3 col=mix(shallow,deep,clamp(vDepth,0.0,1.0)); gl_FragColor=vec4(col,0.48); }'
  );

  var surfPosBuf = gl.createBuffer(), surfNormBuf = gl.createBuffer(), surfUvBuf = gl.createBuffer(), surfTex0Buf = gl.createBuffer(), surfTex1Buf = gl.createBuffer(), surfTex2Buf = gl.createBuffer(), surfTex3Buf = gl.createBuffer(), surfRampBuf = gl.createBuffer(), surfLevelBuf = gl.createBuffer(), surfIdxBuf = gl.createBuffer();
  var cliffPosBuf = gl.createBuffer(), cliffNormBuf = gl.createBuffer(), cliffUvBuf = gl.createBuffer(), cliffTex0Buf = gl.createBuffer(), cliffTex1Buf = gl.createBuffer(), cliffTex2Buf = gl.createBuffer(), cliffTex3Buf = gl.createBuffer(), cliffRampBuf = gl.createBuffer(), cliffLevelBuf = gl.createBuffer(), cliffIdxBuf = gl.createBuffer();
  var waterPosBuf = gl.createBuffer(), waterDepthBuf = gl.createBuffer(), waterIdxBuf = gl.createBuffer();
  var markerPosBuf = gl.createBuffer(), markerColBuf = gl.createBuffer(), markerSizeBuf = gl.createBuffer(), markerRingBuf = gl.createBuffer();

  function uploadMesh() {
    gl.bindBuffer(gl.ARRAY_BUFFER, surfPosBuf); gl.bufferData(gl.ARRAY_BUFFER, surfPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfNormBuf); gl.bufferData(gl.ARRAY_BUFFER, surfNormals, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfUvBuf); gl.bufferData(gl.ARRAY_BUFFER, surfUvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfTex0Buf); gl.bufferData(gl.ARRAY_BUFFER, surfTex0, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfTex1Buf); gl.bufferData(gl.ARRAY_BUFFER, surfTex1, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfTex2Buf); gl.bufferData(gl.ARRAY_BUFFER, surfTex2, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfTex3Buf); gl.bufferData(gl.ARRAY_BUFFER, surfTex3, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfRampBuf); gl.bufferData(gl.ARRAY_BUFFER, surfRamps, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, surfLevelBuf); gl.bufferData(gl.ARRAY_BUFFER, surfLevels, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, surfIdxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, surfIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffPosBuf); gl.bufferData(gl.ARRAY_BUFFER, cliffPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffNormBuf); gl.bufferData(gl.ARRAY_BUFFER, cliffNormals, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffUvBuf); gl.bufferData(gl.ARRAY_BUFFER, cliffUvs, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffTex0Buf); gl.bufferData(gl.ARRAY_BUFFER, cliffTex0, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffTex1Buf); gl.bufferData(gl.ARRAY_BUFFER, cliffTex1, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffTex2Buf); gl.bufferData(gl.ARRAY_BUFFER, cliffTex2, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffTex3Buf); gl.bufferData(gl.ARRAY_BUFFER, cliffTex3, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffRampBuf); gl.bufferData(gl.ARRAY_BUFFER, cliffRamps, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, cliffLevelBuf); gl.bufferData(gl.ARRAY_BUFFER, cliffLevels, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cliffIdxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cliffIndices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, waterPosBuf); gl.bufferData(gl.ARRAY_BUFFER, waterPositions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, waterDepthBuf); gl.bufferData(gl.ARRAY_BUFFER, waterDepths, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, waterIdxBuf); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, waterIndices, gl.STATIC_DRAW);
  }

  // ── Markers ───────────────────────────────────────────────────────────────
  var markers: MarkerPoint[] = [];
  var markerCount = 0;
  function gridI(x) { return (x - DATA.cx) / tile; }
  function gridJ(y) { return (y - DATA.cy) / tile; }
  function markerPos(x, y) {
    var gi = gridI(x), gj = gridJ(y);
    return [worldX(gi), hAt(gi, gj) * exag + MARKER_LIFT, worldZ(gj)];
  }
  function uploadMarkers() {
    var dpr = window.devicePixelRatio || 1;
    var n = markers.length;
    var pos = new Float32Array(Math.max(1, n * 3));
    var col = new Float32Array(Math.max(1, n * 3));
    var size = new Float32Array(Math.max(1, n));
    var ring = new Float32Array(Math.max(1, n));
    for (var m = 0; m < n; m++) {
      var p = markerPos(markers[m].x, markers[m].y);
      pos[m * 3] = p[0]; pos[m * 3 + 1] = p[1]; pos[m * 3 + 2] = p[2];
      var c = markers[m].color;
      col[m * 3] = c[0]; col[m * 3 + 1] = c[1]; col[m * 3 + 2] = c[2];
      size[m] = markers[m].size * dpr;
      ring[m] = markers[m].ring ? 1 : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, markerPosBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, markerColBuf); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, markerSizeBuf); gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, markerRingBuf); gl.bufferData(gl.ARRAY_BUFFER, ring, gl.DYNAMIC_DRAW);
    markerCount = n;
  }

  // ── Camera ────────────────────────────────────────────────────────────────
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
  function aspect() { return canvas.width / Math.max(1, canvas.height); }
  function farPlane() { return dist * 4 + Math.max(w, h) * 4 + 1000; }
  function viewProj() {
    var proj = perspective(FOV, aspect(), 0.5, farPlane());
    return mul(proj, lookAt(eyePos(), target));
  }
  function bindAttr(prog, name, buf, size) {
    var loc = gl.getAttribLocation(prog, name);
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  function drawTerrainMesh(pos, norm, uv, tex0, tex1, tex2, tex3, ramp, levelBuf, idxBuf, idxCount, cliffMix) {
    if (idxCount === 0) return;
    gl.useProgram(terrainProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(terrainProg, 'uMVP'), false, lastMvp);
    gl.uniform1f(gl.getUniformLocation(terrainProg, 'uAtlasCount'), atlasCount);
    gl.uniform1f(gl.getUniformLocation(terrainProg, 'uCliff'), cliffMix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(gl.getUniformLocation(terrainProg, 'uAtlas'), 0);
    bindAttr(terrainProg, 'aPos', pos, 3);
    bindAttr(terrainProg, 'aNormal', norm, 3);
    bindAttr(terrainProg, 'aUv', uv, 2);
    bindAttr(terrainProg, 'aTex0', tex0, 3);
    bindAttr(terrainProg, 'aTex1', tex1, 3);
    bindAttr(terrainProg, 'aTex2', tex2, 3);
    bindAttr(terrainProg, 'aTex3', tex3, 3);
    bindAttr(terrainProg, 'aRamp', ramp, 1);
    bindAttr(terrainProg, 'aLevel', levelBuf, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.drawElements(gl.TRIANGLES, idxCount, indexType, 0);
  }
  function drawWater() {
    if (waterIndices.length === 0) return;
    gl.useProgram(waterProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(waterProg, 'uMVP'), false, lastMvp);
    bindAttr(waterProg, 'aPos', waterPosBuf, 3);
    bindAttr(waterProg, 'aDepth', waterDepthBuf, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, waterIdxBuf);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawElements(gl.TRIANGLES, waterIndices.length, indexType, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  function render() {
    var visible = layers();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.035, 0.047, 0.059, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    lastMvp = viewProj();
    gl.depthFunc(gl.LEQUAL);

    if (visible.terrain) drawTerrainMesh(surfPosBuf, surfNormBuf, surfUvBuf, surfTex0Buf, surfTex1Buf, surfTex2Buf, surfTex3Buf, surfRampBuf, surfLevelBuf, surfIdxBuf, surfIndexCount, 0.0);
    if (visible.cliffs) drawTerrainMesh(cliffPosBuf, cliffNormBuf, cliffUvBuf, cliffTex0Buf, cliffTex1Buf, cliffTex2Buf, cliffTex3Buf, cliffRampBuf, cliffLevelBuf, cliffIdxBuf, cliffIndices.length, 1.0);
    if (visible.water) drawWater();
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);

    if (markerCount === 0) return;
    gl.useProgram(pointProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(pointProg, 'uMVP'), false, lastMvp);
    bindAttr(pointProg, 'aPos', markerPosBuf, 3);
    bindAttr(pointProg, 'aColor', markerColBuf, 3);
    bindAttr(pointProg, 'aSize', markerSizeBuf, 1);
    bindAttr(pointProg, 'aRing', markerRingBuf, 1);
    gl.drawArrays(gl.POINTS, 0, markerCount);
  }

  function resize() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    render();
  }

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

  function rebuild() {
    buildTerrain(exag); uploadMesh(); uploadMarkers();
  }
  rebuild();

  return {
    render,
    resize,
    setExaggeration(value) {
      exag = value || 1;
      target[1] = midY();
      rebuild();
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
      uploadMarkers();
      render();
    },
    markerScreenPosition(x, y) { return project(markerPos(x, y)); },
    groundScreenPosition(x, y) {
      var gi = gridI(x), gj = gridJ(y);
      return project([worldX(gi), hAt(gi, gj) * exag, worldZ(gj)]);
    },
    groundAt,
  };
}
