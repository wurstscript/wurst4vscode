import { base64ToBytes } from './webviewUtils';
import { MapModels } from './mapSceneModels';
const scope: any = self;
let update: (state: any) => void;
let receive: (message: any) => void;
scope.onmessage = event => {
  if (event.data.type === 'assetPort') event.data.port.onmessage = event => receive?.(event.data);
  else if (event.data.type === 'init') initScene(event.data.data, event.data.canvas);
  else if (event.data.type === 'view') update?.(event.data.state);
  else receive?.(event.data);
};
scope.postMessage({ type: 'ready' });
function initScene(DATA: any, canvas: OffscreenCanvas) {
 try {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
  if (!gl) throw new Error('WebGL2 is required for the map scene.');
  const w = DATA.w, h = DATA.h, tile = DATA.tile, cxh = (w - 1) / 2, czh = (h - 1) / 2;
  const heights = new Int16Array(base64ToBytes(DATA.heights).buffer), water = new Int16Array(base64ToBytes(DATA.water).buffer);
  const ground = base64ToBytes(DATA.ground), cliff = base64ToBytes(DATA.cliff), layer = base64ToBytes(DATA.layer);
  const flags = base64ToBytes(DATA.flags), detail = base64ToBytes(DATA.detail), waterMask = base64ToBytes(DATA.waterMask);
  const cellsX = Math.max(0, w - 1), cellsZ = Math.max(0, h - 1), IndexArray = Uint32Array, indexType = gl.UNSIGNED_INT;
  function worldX(i) { return i - cxh; } function worldZ(j) { return czh - j; }
  const toggles: Record<string, {checked: boolean}> = Object.fromEntries(['terrain','cliffs','water','doodads','units','sloc'].map(key => [key, {checked:true}]));
  const xray = { checked: false };
  let exag = 1, yaw = 0.7, pitch = 0.85, dist = Math.max(w, h) * 1.15 + 20, target = [0, 0, 0], lastMvp: Float32Array;
  let state: any = { models: true, visible: DATA.markers.map((_, i) => i), paused: false, dpr: 1 };
  let scheduled = false;
  let animationTimer: ReturnType<typeof setTimeout>;
  let reportedRevision: number;
  function scheduleRender() {
    clearTimeout(animationTimer); animationTimer = undefined;
    if (scheduled || state.paused) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; render(); }, 0);
  }
  const models = new MapModels(gl, DATA, hAt, scheduleRender, message => scope.postMessage(message));
  receive = message => models.receive(message);
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

    var layers = [];
    layers.push([unique[0], get_tile_variation(unique[0], detailAt(i, j) & 0x1f)]);
    for (var u = 1; u < last; u++) {
      var t = unique[u];
      var mask = 0;
      if (br === t) mask |= 1;
      if (bl === t) mask |= 2;
      if (tr === t) mask |= 4;
      if (tl === t) mask |= 8;
      if (mask !== 0) layers.push([t, mask]);
      if (layers.length >= 4) break;
    }
    return layers;
  }

  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    var n = m ? parseInt(m[1], 16) : 0x608050;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  var atlasSize = 256;
  var atlasCount = Math.max(1, DATA.textures.length);
  var atlasCanvas = new OffscreenCanvas(atlasSize * atlasCount, atlasSize);
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
    gl.activeTexture(gl.TEXTURE0);
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
    void fetch(tex.dataUri).then(response => response.blob()).then(createImageBitmap).then(img => {
      atlasCtx.clearRect(n * atlasSize, 0, atlasSize, atlasSize);
      atlasCtx.drawImage(img, n * atlasSize, 0, atlasSize, atlasSize);
      img.close(); uploadAtlas(); scheduleRender();
    }).catch(() => {});
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

  var PLAYER = [[1,0.01,0.01],[0,0.26,1],[0.11,0.9,0.73],[0.33,0,0.5],[1,0.99,0],[1,0.54,0.06],[0.13,0.75,0],[0.9,0.36,0.69],[0.58,0.59,0.59],[0.49,0.75,0.95],[0.06,0.38,0.27],[0.31,0.16,0.02]];
  var dprNow = 1;
  DATA.playerColors = PLAYER;
  function makeGroup(kind, list) {
    var n = list.length;
    var basePos = new Float32Array(Math.max(1, n * 3));
    var pos = new Float32Array(Math.max(1, n * 3));
    var col = new Float32Array(Math.max(1, n * 3));
    var size = new Float32Array(Math.max(1, n));
    for (var m = 0; m < n; m++) {
      var it = list[m];
      var gi = (it.x - DATA.cx) / tile;
      var gj = (it.y - DATA.cy) / tile;
      basePos[m * 3] = worldX(gi);
      basePos[m * 3 + 1] = hAt(gi, gj);
      basePos[m * 3 + 2] = worldZ(gj);
      var rgb;
      if (kind === 'doodad') { rgb = [0.36, 0.83, 0.36]; size[m] = 4; }
      else if (kind === 'start') { rgb = [0.3, 0.8, 1.0]; size[m] = 13; }
      else { rgb = PLAYER[it.owner] || [1, 0.7, 0.3]; size[m] = 7; }
      rgb = it.color || rgb; size[m] = it.size || size[m];
      col[m * 3] = rgb[0]; col[m * 3 + 1] = rgb[1]; col[m * 3 + 2] = rgb[2];
    }
    return { kind: kind, items: list, n: n, basePos: basePos, pos: pos, col: col, size: size,
      indices: new Uint32Array(Math.max(1, n)), iBuf: gl.createBuffer(), pBuf: gl.createBuffer(), cBuf: gl.createBuffer(), sBuf: gl.createBuffer() };
  }
  var doodads = DATA.markers.filter(function (m) { return m.k === 'doodad'; });
  var units = DATA.markers.filter(function (m) { return m.k === 'unit'; });
  var starts = DATA.markers.filter(function (m) { return m.k === 'start'; });
  var gDood = makeGroup('doodad', doodads);
  var gUnit = makeGroup('unit', units);
  var gSloc = makeGroup('start', starts);
  var groups: [ReturnType<typeof makeGroup>, {checked: boolean}][] = [[gDood, toggles.doodads], [gUnit, toggles.units], [gSloc, toggles.sloc]];

  function liftMarkers(exag) {
    var all = [gDood, gUnit, gSloc];
    for (var a = 0; a < all.length; a++) {
      var g = all[a];
      for (var m = 0; m < g.n; m++) {
        g.pos[m * 3] = g.basePos[m * 3];
        g.pos[m * 3 + 1] = g.basePos[m * 3 + 1] * exag + 0.6;
        g.pos[m * 3 + 2] = g.basePos[m * 3 + 2];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, g.pBuf); gl.bufferData(gl.ARRAY_BUFFER, g.pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.cBuf); gl.bufferData(gl.ARRAY_BUFFER, g.col, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, g.sBuf); gl.bufferData(gl.ARRAY_BUFFER, g.size.map(size => size * state.dpr), gl.STATIC_DRAW);
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
    'attribute vec3 aPos; attribute vec3 aColor; attribute float aSize; uniform mat4 uMVP; varying vec3 vColor; void main(){ vColor=aColor; gl_Position=uMVP*vec4(aPos,1.0); gl_PointSize=aSize; }',
    'precision mediump float; varying vec3 vColor; void main(){ vec2 d=gl_PointCoord-vec2(0.5); if(dot(d,d)>0.25) discard; gl_FragColor=vec4(vColor,1.0); }'
  );
  var waterProg = program(
    'attribute vec3 aPos; attribute float aDepth; uniform mat4 uMVP; varying float vDepth; void main(){ vDepth=aDepth; gl_Position=uMVP*vec4(aPos,1.0); }',
    'precision mediump float; varying float vDepth; void main(){ vec3 shallow=vec3(0.18,0.58,0.67); vec3 deep=vec3(0.04,0.23,0.36); vec3 col=mix(shallow,deep,clamp(vDepth,0.0,1.0)); gl_FragColor=vec4(col,0.48); }'
  );

  var surfPosBuf = gl.createBuffer(), surfNormBuf = gl.createBuffer(), surfUvBuf = gl.createBuffer(), surfTex0Buf = gl.createBuffer(), surfTex1Buf = gl.createBuffer(), surfTex2Buf = gl.createBuffer(), surfTex3Buf = gl.createBuffer(), surfRampBuf = gl.createBuffer(), surfLevelBuf = gl.createBuffer(), surfIdxBuf = gl.createBuffer();
  var cliffPosBuf = gl.createBuffer(), cliffNormBuf = gl.createBuffer(), cliffUvBuf = gl.createBuffer(), cliffTex0Buf = gl.createBuffer(), cliffTex1Buf = gl.createBuffer(), cliffTex2Buf = gl.createBuffer(), cliffTex3Buf = gl.createBuffer(), cliffRampBuf = gl.createBuffer(), cliffLevelBuf = gl.createBuffer(), cliffIdxBuf = gl.createBuffer();
  var waterPosBuf = gl.createBuffer(), waterDepthBuf = gl.createBuffer(), waterIdxBuf = gl.createBuffer();

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
  function lookAt(eye, ctr, up) {
    var zx = eye[0]-ctr[0], zy = eye[1]-ctr[1], zz = eye[2]-ctr[2];
    var zl = Math.sqrt(zx*zx+zy*zy+zz*zz)||1; zx/=zl; zy/=zl; zz/=zl;
    var xx = up[1]*zz-up[2]*zy, xy = up[2]*zx-up[0]*zz, xz = up[0]*zy-up[1]*zx;
    var xl = Math.sqrt(xx*xx+xy*xy+xz*xz)||1; xx/=xl; xy/=xl; xz/=xl;
    var yx = zy*xz-zz*xy, yy = zz*xx-zx*xz, yz = zx*xy-zy*xx;
    var o = new Float32Array(16);
    o[0]=xx; o[1]=yx; o[2]=zx; o[3]=0;
    o[4]=xy; o[5]=yy; o[6]=zy; o[7]=0;
    o[8]=xz; o[9]=yz; o[10]=zz; o[11]=0;
    o[12]=-(xx*eye[0]+xy*eye[1]+xz*eye[2]);
    o[13]=-(yx*eye[0]+yy*eye[1]+yz*eye[2]);
    o[14]=-(zx*eye[0]+zy*eye[1]+zz*eye[2]);
    o[15]=1;
    return o;
  }


  function viewProj() {
    const proj = perspective(50 * Math.PI / 180, canvas.width / Math.max(1, canvas.height), 0.5, dist * 4 + Math.max(w, h) * 4 + 1000);
    return mul(proj, lookAt([target[0] + dist * Math.cos(pitch) * Math.sin(yaw), target[1] + dist * Math.sin(pitch), target[2] + dist * Math.cos(pitch) * Math.cos(yaw)], target, [0,1,0]));
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
    if (state.paused) return;
    const started = performance.now();
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.035, 0.047, 0.059, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    lastMvp = viewProj();
    gl.depthFunc(gl.LEQUAL);

    if (toggles.terrain.checked) drawTerrainMesh(surfPosBuf, surfNormBuf, surfUvBuf, surfTex0Buf, surfTex1Buf, surfTex2Buf, surfTex3Buf, surfRampBuf, surfLevelBuf, surfIdxBuf, surfIndexCount, 0.0);
    if (toggles.cliffs.checked) drawTerrainMesh(cliffPosBuf, cliffNormBuf, cliffUvBuf, cliffTex0Buf, cliffTex1Buf, cliffTex2Buf, cliffTex3Buf, cliffRampBuf, cliffLevelBuf, cliffIdxBuf, cliffIndices.length, 1.0);
    const animating = models.draw(lastMvp, exag, state);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    if (toggles.water.checked) drawWater();
    gl.depthFunc(gl.LESS);
    gl.disable(gl.BLEND);

    gl.useProgram(pointProg);
    if (xray.checked) gl.disable(gl.DEPTH_TEST);
    gl.uniformMatrix4fv(gl.getUniformLocation(pointProg, 'uMVP'), false, lastMvp);
    for (var gp = 0; gp < groups.length; gp++) {
      var grp = groups[gp][0], tog = groups[gp][1];
      if (!tog.checked || grp.n === 0) continue;
      bindAttr(pointProg, 'aPos', grp.pBuf, 3);
      bindAttr(pointProg, 'aColor', grp.cBuf, 3);
      bindAttr(pointProg, 'aSize', grp.sBuf, 1);
      let count = 0;
      for (var i = 0; i < grp.n; i++) if (!models.wasDrawn(grp.items[i])) grp.indices[count++] = i;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, grp.iBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grp.indices.subarray(0, count), gl.DYNAMIC_DRAW);
      gl.drawElements(gl.POINTS, count, gl.UNSIGNED_INT, 0);
    }
    gl.enable(gl.DEPTH_TEST);
    // Animation stays entirely in this worker; only acknowledge new UI view revisions.
    if (reportedRevision !== state.revision) {
      reportedRevision = state.revision;
      scope.postMessage({ type: 'sceneFrame', revision: state.revision });
    }
    if (animating) animationTimer = setTimeout(() => {
      animationTimer = undefined; scheduleRender();
    }, Math.max(1, Math.ceil(1000 / 30 - (performance.now() - started))));
  }

  let visibleKey = '';
  update = next => {
    const markersChanged = !!next.markers;
    if (markersChanged) { DATA.markers = next.markers; models.setMarkers(next.markers); }
    const previousExag = exag;
    const previousDpr = state.dpr;
    next.visible ??= state.visible;
    state = next; ({yaw, pitch, dist, target, exag} = next);
    if (canvas.width !== next.width) canvas.width = next.width;
    if (canvas.height !== next.height) canvas.height = next.height;
    for (const key of Object.keys(toggles)) toggles[key].checked = next.toggles[key];
    xray.checked = next.xray;
    if (previousExag !== exag) { buildTerrain(exag); uploadMesh(); }
    const key = next.visible.join(',');
    const visibilityChanged = markersChanged || visibleKey !== key;
    if (visibilityChanged) {
      visibleKey = key;
      for (const group of [gDood, gUnit, gSloc]) { gl.deleteBuffer(group.iBuf); gl.deleteBuffer(group.pBuf); gl.deleteBuffer(group.cBuf); gl.deleteBuffer(group.sBuf); }
      const list = next.visible.map(i => DATA.markers[i]);
      gDood = makeGroup('doodad', list.filter(m => m.k === 'doodad'));
      gUnit = makeGroup('unit', list.filter(m => m.k === 'unit'));
      gSloc = makeGroup('start', list.filter(m => m.k === 'start'));
      groups = [[gDood,toggles.doodads],[gUnit,toggles.units],[gSloc,toggles.sloc]];
    }
    if (visibilityChanged || previousExag !== exag || previousDpr !== state.dpr) liftMarkers(exag);
    models.setView(next, viewProj());
    scheduleRender();
  };
  buildTerrain(exag); uploadMesh(); liftMarkers(exag);
 } catch (error) { scope.postMessage({ type: 'sceneError', error: String(error) }); }
}
