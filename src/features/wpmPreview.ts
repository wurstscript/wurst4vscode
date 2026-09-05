'use strict';

/** VS Code preview for WC3 war3map.wpm (pathing). Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseWpm, serializeWpm, WpmFile } from 'casc-ts/formats';
import { EditableBinaryDocument, EditableBinaryEditorProvider } from './preview/framework';
import { escapeHtml } from './webviewUtils';
export { WpmFile } from 'casc-ts/formats';

export interface WpmFlagDefinition {
    bit: number;
    label: string;
    description: string;
    color: [number, number, number];
    primary?: boolean;
}

/** The only WPM header version with a documented byte layout. */
export const WPM_KNOWN_VERSION = 0;

export const WPM_FLAG_DEFS: readonly WpmFlagDefinition[] = [
    { bit: 0x01, label: 'Reserved', description: 'Reserved bit; standard maps normally leave it clear.', color: [160, 160, 160] },
    { bit: 0x02, label: 'Unwalkable', description: 'Ground units cannot walk through this cell.', color: [255, 0, 0], primary: true },
    { bit: 0x04, label: 'Unflyable', description: 'Flying units cannot pass through this cell.', color: [0, 255, 0], primary: true },
    { bit: 0x08, label: 'Unbuildable', description: 'Buildings cannot be placed on this cell.', color: [0, 0, 255], primary: true },
    { bit: 0x10, label: 'No Peon Harvest', description: 'Peons cannot harvest resources from this cell.', color: [240, 170, 40] },
    { bit: 0x20, label: 'Blighted', description: 'The cell is marked as blight.', color: [190, 80, 0] },
    { bit: 0x40, label: 'No Water / Unfloatable', description: 'The WC3 pathing state for no water / unfloatable movement. It is commonly set on ordinary dry ground; terrain water is stored in W3E.', color: [120, 120, 120] },
    { bit: 0x80, label: 'Unamphibious', description: 'The WC3 pathing state for amphibious movement.', color: [180, 80, 220] },
];

function blendWpmColor(base: [number, number, number], overlay: [number, number, number]): [number, number, number] {
    return [(base[0] + overlay[0]) >> 1, (base[1] + overlay[1]) >> 1, (base[2] + overlay[2]) >> 1];
}

export function wpmCellRgb(flag: number): [number, number, number] {
    let rgb: [number, number, number] = [0, 0, 0];
    for (const definition of WPM_FLAG_DEFS) {
        if ((flag & definition.bit) === 0) continue;
        if (definition.primary) {
            rgb = [
                definition.bit === 0x02 ? definition.color[0] : rgb[0],
                definition.bit === 0x04 ? definition.color[1] : rgb[1],
                definition.bit === 0x08 ? definition.color[2] : rgb[2],
            ];
        } else {
            rgb = blendWpmColor(rgb, definition.color);
        }
    }
    return rgb;
}

export function wpmFlagLabels(flag: number): string[] {
    return WPM_FLAG_DEFS.filter((definition) => (flag & definition.bit) !== 0).map((definition) => definition.label);
}

export function wpmColorTable(): Array<[number, number, number]> {
    return Array.from({ length: 256 }, (_, flag) => wpmCellRgb(flag));
}

// ── HTML Rendering ────────────────────────────────────────────────────────────

function buildWpmHtml(wpm: WpmFile, fileName: string, isDirty: boolean): string {
    const dataBase64 = wpm.data.toString('base64');

    const colorTable = wpmColorTable();
    const paletteFlagsHtml = WPM_FLAG_DEFS.map((definition) => {
        const [r, g, b] = wpmCellRgb(definition.bit);
        return `<label class="flag-card" title="${escapeHtml(definition.description)}"><input type="checkbox" data-brush-bit="${definition.bit}"${definition.bit === 0x02 || definition.bit === 0x08 ? ' checked' : ''}><span class="swatch" style="background:rgb(${r},${g},${b})"></span><span class="flag-copy"><strong>${escapeHtml(definition.label)}</strong><small>0x${definition.bit.toString(16).padStart(2, '0').toUpperCase()}</small></span></label>`;
    }).join('');

    const versionWarning = wpm.version === WPM_KNOWN_VERSION
        ? ''
        : `<span class="version-warning" title="Only WPM version 0 has a documented byte layout. The editor preserves this version and its bytes.">Unverified WPM v${wpm.version}</span>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>${escapeHtml(fileName)}</title>
<style>
  :root {
    --bg:       var(--vscode-editor-background);
    --panel:    var(--vscode-sideBar-background);
    --text:     var(--vscode-editor-foreground);
    --muted:    var(--vscode-descriptionForeground);
    --border:   var(--vscode-panel-border);
    --btn-bg:   var(--vscode-button-background);
    --btn-fg:   var(--vscode-button-foreground);
    --panel-strong: color-mix(in srgb, var(--panel) 84%, var(--bg));
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body {
    background: var(--bg); color: var(--text);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
    display: flex; flex-direction: column; height: 100vh;
  }
  header {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 12px; border-bottom: 1px solid var(--border);
    background: var(--panel); flex-shrink: 0; min-width: 0;
  }
  .title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { flex: 1; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .version-warning { color: var(--vscode-charts-orange); font-size: 11px; white-space: nowrap; }
  .sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex-shrink: 0; }
  .toolbar { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
  button {
    border: none; background: transparent; color: var(--muted);
    padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 12px;
  }
  button:hover { background: color-mix(in srgb, var(--btn-bg) 55%, transparent); color: var(--text); }
  button.active { background: var(--btn-bg); color: var(--btn-fg); }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .dirty { color: var(--vscode-charts-orange); font-size: 11px; }
  #zoomLabel { min-width: 56px; text-align: center; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  #workspace { display: flex; flex: 1; min-height: 0; }
  #viewport {
    flex: 1; min-width: 0; overflow: hidden; position: relative;
    background: color-mix(in srgb, var(--bg) 60%, #000);
    cursor: grab;
  }
  #wpmCanvas { display: block; position: absolute; top: 0; left: 0; image-rendering: pixelated; }
  #tooltip {
    position: fixed; pointer-events: none;
    background: var(--panel); border: 1px solid var(--border);
    padding: 7px 10px; border-radius: 4px; font-size: 11px; display: none; z-index: 10;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4); line-height: 1.7;
  }
  #palette {
    width: 238px; flex: 0 0 238px; padding: 12px 10px; overflow: auto;
    border-left: 1px solid var(--border); background: var(--panel); order: 2;
  }
  .palette-section { padding: 0 0 14px; margin-bottom: 12px; border-bottom: 1px solid var(--border); }
  .palette-section:last-child { border-bottom: 0; margin-bottom: 0; }
  .section-title { color: var(--muted); font-size: 10px; font-weight: 600; letter-spacing: .08em; margin: 0 0 8px; text-transform: uppercase; }
  .tools { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .tool { display: flex; align-items: center; gap: 7px; padding: 7px 8px; text-align: left; border: 1px solid transparent; }
  .tool .tool-icon { width: 18px; color: var(--muted); font-size: 15px; text-align: center; }
  .tool.active { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--btn-bg) 35%, transparent); color: var(--text); }
  .tool.active .tool-icon { color: var(--btn-fg); }
  .brush-size { display: flex; align-items: center; gap: 8px; }
  .brush-size input { flex: 1; min-width: 0; accent-color: var(--vscode-focusBorder); }
  .brush-size output { min-width: 35px; color: var(--text); font: 12px var(--vscode-editor-font-family); text-align: right; }
  .flag-grid { display: grid; gap: 4px; }
  .flag-card { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 4px; cursor: pointer; }
  .flag-card:hover { background: color-mix(in srgb, var(--btn-bg) 25%, transparent); }
  .flag-card input { margin: 0; accent-color: var(--vscode-focusBorder); }
  .swatch { width: 16px; height: 16px; border-radius: 4px; border: 1px solid rgba(255,255,255,.25); flex: 0 0 16px; }
  .flag-copy { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; min-width: 0; flex: 1; }
  .flag-copy strong { font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .flag-copy small { color: var(--muted); font: 10px var(--vscode-editor-font-family); }
  .brush-readout { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; padding: 7px 8px; border-radius: 4px; background: var(--panel-strong); }
  #brushValue { color: var(--text); font: 12px var(--vscode-editor-font-family); }
  #brushLabel { color: var(--muted); font-size: 11px; }
  .legend-list { display: grid; gap: 5px; }
  .legend-item { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 10px; }
  .legend-item .swatch { width: 12px; height: 12px; flex-basis: 12px; }
  .edit-hint { color: var(--muted); font-size: 10px; line-height: 1.45; }
  .edit-hint kbd { border: 1px solid var(--border); border-radius: 3px; padding: 1px 4px; color: var(--text); }
  @media (max-width: 680px) {
    #workspace { flex-direction: column; }
    #palette { width: 100%; flex-basis: auto; max-height: 270px; border-left: 0; border-top: 1px solid var(--border); }
    .flag-grid { grid-template-columns: 1fr 1fr; }
  }
</style>
</head>
<body>
  <header>
    <span class="title">${escapeHtml(fileName)}</span>
    <span class="meta">${wpm.width} × ${wpm.height} &nbsp;·&nbsp; WPM v${wpm.version}</span>
    ${versionWarning}
    <span id="dirtyBadge" class="dirty"${isDirty ? '' : ' hidden'}>Modified</span>
    <div class="toolbar">
      <button id="btnZoomOut" title="Zoom out">−</button>
      <span id="zoomLabel">–</span>
      <button id="btnZoomIn" title="Zoom in">+</button>
      <div class="sep"></div>
      <button id="btnZoomFit">Fit</button>
    </div>
  </header>

  <div id="workspace">
    <div id="viewport">
      <canvas id="wpmCanvas"></canvas>
    </div>
    <aside id="palette" aria-label="Pathing paint palette">
      <section class="palette-section">
        <h2 class="section-title">Tools</h2>
        <div class="tools">
          <button type="button" class="tool active" data-tool="pan" title="Drag to move around the map"><span class="tool-icon">✥</span>Pan</button>
          <button type="button" class="tool" data-tool="paint" title="Paint the selected flags"><span class="tool-icon">✎</span>Brush</button>
          <button type="button" class="tool" data-tool="line" title="Draw a straight line"><span class="tool-icon">╱</span>Line</button>
          <button type="button" class="tool" data-tool="fill" title="Fill connected cells with the selected flags"><span class="tool-icon">▧</span>Fill</button>
          <button type="button" class="tool" data-tool="erase" title="Clear all flags"><span class="tool-icon">⌫</span>Erase</button>
        </div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">Brush size</h2>
        <div class="brush-size"><input id="brushSize" type="range" min="1" max="32" value="1"><output id="brushSizeValue">1 × 1</output></div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">Pathing flags</h2>
        <div class="flag-grid">${paletteFlagsHtml}</div>
        <div class="brush-readout"><span id="brushLabel">Selected</span><span id="brushValue">0x0A</span></div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">How to paint</h2>
        <div class="edit-hint"><kbd>Alt</kbd>-click any cell to sample its complete byte. Drag with Brush; click-drag with Line; click with Fill. Each gesture is one undo step.</div>
      </section>
      <section class="palette-section">
        <h2 class="section-title">Cell colors</h2>
        <div class="legend-list">${WPM_FLAG_DEFS.map((definition) => {
            const [r, g, b] = wpmCellRgb(definition.bit);
            return `<div class="legend-item" title="${escapeHtml(definition.description)}"><span class="swatch" style="background:rgb(${r},${g},${b})"></span>${escapeHtml(definition.label)}</div>`;
        }).join('')}</div>
      </section>
    </aside>
  </div>
  <div id="tooltip"></div>

  <script>
    const api = acquireVsCodeApi();
    const W = ${wpm.width};
    const H = ${wpm.height};
    const raw = atob("${dataBase64}");
    const colorTable = ${JSON.stringify(colorTable)};
    const flagDefinitions = ${JSON.stringify(WPM_FLAG_DEFS.map(({ bit, label }) => ({ bit, label })))};
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);

    const canvas    = document.getElementById('wpmCanvas');
    const ctx       = canvas.getContext('2d');
    const viewport  = document.getElementById('viewport');
    const zoomLabel = document.getElementById('zoomLabel');

    // ── Render map into offscreen ImageData ────────────────────────────────────
    const offscreen = document.createElement('canvas');
    offscreen.width = W; offscreen.height = H;
    const offCtx = offscreen.getContext('2d');
    const img = offCtx.createImageData(W, H);
    const px  = img.data;
    function writePixel(index) {
        const dataY = Math.floor(index / W);
        const x = index % W;
        const dispY = H - 1 - dataY; // WC3 row 0 = bottom of map, flip for screen
        const flag = data[index];
        const i = (dispY * W + x) * 4;
        if (flag === 0) { px[i] = 0; px[i+1] = 0; px[i+2] = 0; px[i+3] = 0; return; }
        const [r, g, b] = colorTable[flag] || [0, 0, 0];
        px[i]=r; px[i+1]=g; px[i+2]=b; px[i+3]=230;
    }
    for (let index = 0; index < data.length; index++) writePixel(index);
    offCtx.putImageData(img, 0, 0);

    // ── Camera state ───────────────────────────────────────────────────────────
    // camX/camY: which offscreen pixel is at the screen centre (float)
    // zoom: screen pixels per map cell (float, stepless)
    const savedState = api.getState() || {};
    let camX = Number.isFinite(savedState.camX) ? savedState.camX : W / 2;
    let camY = Number.isFinite(savedState.camY) ? savedState.camY : H / 2;
    let zoom = Number.isFinite(savedState.zoom) ? savedState.zoom : 1;
    let tool = ['pan', 'paint', 'line', 'fill', 'erase'].includes(savedState.tool) ? savedState.tool : 'pan';
    let brushSize = Number.isInteger(savedState.brushSize) ? Math.max(1, Math.min(32, savedState.brushSize)) : 1;
    const MIN_ZOOM = 0.05, MAX_ZOOM = 64;

    function persistView() { api.setState({ camX, camY, zoom, tool, brushSize }); }

    function clampCam() {
      const vw = canvas.width, vh = canvas.height;
      camX = Math.max(0, Math.min(W, camX));
      camY = Math.max(0, Math.min(H, camY));
    }

    function fitToView() {
      const vw = canvas.width || viewport.clientWidth;
      const vh = canvas.height || viewport.clientHeight;
      zoom = Math.min(vw / W, vh / H);
      camX = W / 2; camY = H / 2;
    }

    // ── Draw ───────────────────────────────────────────────────────────────────
    // The display canvas is fixed to the viewport size — it NEVER resizes on zoom.
    // Zoom/pan = update camera, call draw() once. Draw = one drawImage (GPU blit).
    function draw() {
      const vw = canvas.width, vh = canvas.height;
      ctx.clearRect(0, 0, vw, vh);

      // Source rect in offscreen coords
      const srcX = camX - vw / (2 * zoom);
      const srcY = camY - vh / (2 * zoom);
      const srcW = vw / zoom;
      const srcH = vh / zoom;

      ctx.imageSmoothingEnabled = zoom < 1;
      ctx.drawImage(offscreen, srcX, srcY, srcW, srcH, 0, 0, vw, vh);

      // Grid — only when cells are large enough to see individually
      if (zoom >= 6) {
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const x0 = Math.ceil(srcX), x1 = Math.floor(srcX + srcW) + 1;
        const y0 = Math.ceil(srcY), y1 = Math.floor(srcY + srcH) + 1;
        for (let cx = x0; cx <= x1; cx++) {
          const sx = Math.round((cx - srcX) * zoom) + 0.5;
          ctx.moveTo(sx, 0); ctx.lineTo(sx, vh);
        }
        for (let cy = y0; cy <= y1; cy++) {
          const sy = Math.round((cy - srcY) * zoom) + 0.5;
          ctx.moveTo(0, sy); ctx.lineTo(vw, sy);
        }
        ctx.stroke();
      }

      if (lineStart && lineCurrent && tool === 'line') {
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = brushColor();
        lineCells(lineStart.x, lineStart.y, lineCurrent.x, lineCurrent.y, (x, y) => paintBrushPreview(x, y));
        ctx.globalAlpha = 1;
      }

      zoomLabel.textContent = zoom >= 1
        ? zoom.toFixed(zoom < 10 ? 1 : 0) + ' px/cell'
        : (zoom * 100).toFixed(0) + '%';
    }

    let dirtyMinX = W, dirtyMinY = H, dirtyMaxX = -1, dirtyMaxY = -1;
    function refreshCell(index) {
      writePixel(index);
      const x = index % W, y = Math.floor(index / W);
      dirtyMinX = Math.min(dirtyMinX, x);
      dirtyMaxX = Math.max(dirtyMaxX, x);
      dirtyMinY = Math.min(dirtyMinY, y);
      dirtyMaxY = Math.max(dirtyMaxY, y);
    }

    function flushImage() {
      if (dirtyMaxX < dirtyMinX || dirtyMaxY < dirtyMinY) return;
      offCtx.putImageData(img, 0, 0, dirtyMinX, H - 1 - dirtyMaxY,
        dirtyMaxX - dirtyMinX + 1, dirtyMaxY - dirtyMinY + 1);
      dirtyMinX = W; dirtyMinY = H; dirtyMaxX = -1; dirtyMaxY = -1;
    }

    let rafId = null;
    function scheduleDraw() {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = null; draw(); });
    }

    // ── Resize: canvas always matches viewport, never zoom-driven ─────────────
    function resizeCanvas() {
      canvas.width  = viewport.clientWidth;
      canvas.height = viewport.clientHeight;
      scheduleDraw();
    }
    new ResizeObserver(resizeCanvas).observe(viewport);

    // ── Wheel: smooth stepless zoom pinned to cursor ───────────────────────────
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const vw = canvas.width, vh = canvas.height;

      // Map coord under cursor before zoom
      const mapX = camX + (sx - vw / 2) / zoom;
      const mapY = camY + (sy - vh / 2) / zoom;

      zoom *= Math.pow(1.12, e.deltaY < 0 ? 1 : -1);
      zoom  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

      // Restore cursor's map coord to same screen position
      camX = mapX - (sx - vw / 2) / zoom;
      camY = mapY - (sy - vh / 2) / zoom;
      clampCam();
      persistView();
      scheduleDraw();
    }, { passive: false });

    // ── Pan and cell editing ───────────────────────────────────────────────────
    let dragging = false, editing = false, dragSX = 0, dragSY = 0, dragCamX = 0, dragCamY = 0;
    let gestureChanges = new Map(), lastEditX = -1, lastEditY = -1;
    let gestureRuns = null;
    let lineStart = null, lineCurrent = null;

    function eventCell(e) {
      const rect = viewport.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const offX = Math.floor(camX + (sx - canvas.width / 2) / zoom);
      const offY = Math.floor(camY + (sy - canvas.height / 2) / zoom);
      const dataY = H - 1 - offY;
      if (offX < 0 || offX >= W || dataY < 0 || dataY >= H) return null;
      return { x: offX, y: dataY, index: dataY * W + offX };
    }

    function brushValue() {
      let value = 0;
      document.querySelectorAll('[data-brush-bit]:checked').forEach((input) => { value |= Number(input.dataset.brushBit); });
      return value;
    }

    function updateBrushValue() {
      document.getElementById('brushValue').textContent = '0x' + brushValue().toString(16).padStart(2, '0').toUpperCase();
    }

    function pickBrush(value) {
      document.querySelectorAll('[data-brush-bit]').forEach((input) => { input.checked = (value & Number(input.dataset.brushBit)) !== 0; });
      updateBrushValue();
      setTool('paint');
    }

    function brushColor() {
      const [r, g, b] = colorTable[tool === 'erase' ? 0 : brushValue()] || [255, 255, 255];
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }

    function lineCells(fromX, fromY, toX, toY, visit) {
      const dx = Math.abs(toX - fromX), sx = fromX < toX ? 1 : -1;
      const dy = -Math.abs(toY - fromY), sy = fromY < toY ? 1 : -1;
      let x = fromX, y = fromY, err = dx + dy;
      while (true) {
        visit(x, y);
        if (x === toX && y === toY) break;
        const twice = 2 * err;
        if (twice >= dy) { err += dy; x += sx; }
        if (twice <= dx) { err += dx; y += sy; }
      }
    }

    function brushCells(x, y, visit) {
      const radius = Math.floor(brushSize / 2);
      for (let dy = -radius; dy < brushSize - radius; dy++) {
        for (let dx = -radius; dx < brushSize - radius; dx++) visit(x + dx, y + dy);
      }
    }

    function paintCell(x, y, next) {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const index = y * W + x;
      if (!gestureChanges.has(index)) gestureChanges.set(index, data[index]);
      data[index] = next;
      refreshCell(index);
    }

    function paintBrush(x, y) {
      const next = tool === 'erase' ? 0 : brushValue();
      brushCells(x, y, (cellX, cellY) => paintCell(cellX, cellY, next));
    }

    function paintBrushPreview(x, y) {
      const srcX = camX - canvas.width / (2 * zoom);
      const srcY = camY - canvas.height / (2 * zoom);
      brushCells(x, y, (cellX, cellY) => {
        const offX = cellX, offY = H - 1 - cellY;
        const sx = (offX - srcX) * zoom, sy = (offY - srcY) * zoom;
        if (offX >= 0 && offX < W && cellY >= 0 && cellY < H) ctx.fillRect(sx, sy, zoom, zoom);
      });
    }

    function paintLine(fromX, fromY, toX, toY) {
      lineCells(fromX, fromY, toX, toY, paintBrush);
      flushImage();
      scheduleDraw();
    }

    function fillFrom(startIndex) {
      const replacement = tool === 'erase' ? 0 : brushValue();
      const source = data[startIndex];
      if (source === replacement) return [];
      const visited = new Uint8Array(data.length);
      const changed = new Uint8Array(data.length);
      const stack = [startIndex];
      visited[startIndex] = 1;
      const enqueue = (index) => {
        if (!visited[index] && data[index] === source) {
          visited[index] = 1;
          stack.push(index);
        }
      };
      while (stack.length) {
        const index = stack.pop();
        const x = index % W, y = Math.floor(index / W);
        data[index] = replacement;
        refreshCell(index);
        changed[index] = 1;
        if (x > 0) enqueue(index - 1);
        if (x + 1 < W) enqueue(index + 1);
        if (y > 0) enqueue(index - W);
        if (y + 1 < H) enqueue(index + W);
      }
      flushImage();
      scheduleDraw();
      const runs = [];
      for (let index = 0; index < changed.length;) {
        if (!changed[index]) { index++; continue; }
        const start = index;
        while (index < changed.length && changed[index]) index++;
        runs.push({ start, length: index - start, value: replacement });
      }
      return runs;
    }

    function finishEdit() {
      if (!editing) return;
      editing = false;
      const runs = gestureRuns;
      const changes = [];
      gestureChanges.forEach((before, index) => {
        const value = data[index];
        if (value !== before) changes.push({ index, value });
      });
      gestureChanges = new Map();
      gestureRuns = null;
      if (runs) api.postMessage({ type: 'editRuns', runs });
      else if (changes.length) api.postMessage({ type: 'editCells', changes });
    }

    viewport.addEventListener('pointerdown', (e) => {
      const cell = eventCell(e);
      if (e.button === 0 && e.altKey && cell) { pickBrush(data[cell.index]); return; }
      if (tool !== 'pan' && e.button === 0 && cell) {
        editing = true; gestureChanges = new Map(); gestureRuns = null; lastEditX = cell.x; lastEditY = cell.y;
        viewport.setPointerCapture(e.pointerId);
        if (tool === 'line') {
          lineStart = cell; lineCurrent = cell; scheduleDraw();
        } else if (tool === 'fill') {
          gestureRuns = fillFrom(cell.index); finishEdit();
        } else {
          paintBrush(cell.x, cell.y); flushImage(); scheduleDraw();
        }
        return;
      }
      if (e.button !== 0 && e.button !== 1) return;
      dragging = true;
      dragSX = e.clientX; dragSY = e.clientY;
      dragCamX = camX;    dragCamY = camY;
      viewport.setPointerCapture(e.pointerId);
      viewport.style.cursor = 'grabbing';
    });
    viewport.addEventListener('pointermove', (e) => {
      if (editing) {
        const cell = eventCell(e);
        if (cell && tool === 'line') {
          lineCurrent = cell; scheduleDraw();
        } else if (cell && (cell.x !== lastEditX || cell.y !== lastEditY)) {
          paintLine(lastEditX, lastEditY, cell.x, cell.y);
          lastEditX = cell.x; lastEditY = cell.y;
        }
        return;
      }
      if (!dragging) return;
      camX = dragCamX - (e.clientX - dragSX) / zoom;
      camY = dragCamY - (e.clientY - dragSY) / zoom;
      clampCam();
      scheduleDraw();
    });
    const endDrag = () => {
      if (editing && tool === 'line' && lineStart && lineCurrent) {
        lineCells(lineStart.x, lineStart.y, lineCurrent.x, lineCurrent.y, paintBrush);
        flushImage();
        lineStart = null; lineCurrent = null;
        scheduleDraw();
      }
      finishEdit();
      dragging = false;
      persistView();
      viewport.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
    };
    viewport.addEventListener('pointerup',     endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    // ── Toolbar buttons ────────────────────────────────────────────────────────
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      zoom = Math.min(MAX_ZOOM, zoom * 1.5); persistView(); scheduleDraw();
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      zoom = Math.max(MIN_ZOOM, zoom / 1.5); persistView(); scheduleDraw();
    });
    document.getElementById('btnZoomFit').addEventListener('click', () => {
      fitToView(); persistView(); scheduleDraw();
    });

    function setTool(next) {
      tool = next;
      if (tool !== 'line') { lineStart = null; lineCurrent = null; }
      document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
      viewport.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
      persistView();
    }
    document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
    document.querySelectorAll('[data-brush-bit]').forEach((input) => input.addEventListener('change', updateBrushValue));
    const brushSizeInput = document.getElementById('brushSize');
    const brushSizeValue = document.getElementById('brushSizeValue');
    brushSizeInput.value = String(brushSize);
    function updateBrushSize() {
      brushSize = Number(brushSizeInput.value);
      brushSizeValue.textContent = brushSize + ' × ' + brushSize;
      persistView();
      scheduleDraw();
    }
    brushSizeInput.addEventListener('input', updateBrushSize);

    // ── Tooltip ────────────────────────────────────────────────────────────────
    const tooltip = document.getElementById('tooltip');
    viewport.addEventListener('mousemove', (e) => {
      if (dragging) { tooltip.style.display = 'none'; return; }
      const rect = viewport.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const vw = canvas.width, vh = canvas.height;
      const offX = Math.floor(camX + (sx - vw / 2) / zoom);
      const offY = Math.floor(camY + (sy - vh / 2) / zoom);
      const dataX = offX, dataY = H - 1 - offY;
      if (dataX >= 0 && dataX < W && dataY >= 0 && dataY < H) {
        const flag = data[dataY * W + dataX];
        const parts = flagDefinitions.filter((definition) => flag & definition.bit).map((definition) => definition.label);
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 16) + 'px';
        tooltip.style.top  = (e.clientY + 16) + 'px';
        tooltip.innerHTML = \`<strong>(\${dataX}, \${dataY})</strong>&ensp;0x\${flag.toString(16).padStart(2,'0').toUpperCase()}<br>\${parts.join(', ') || 'Walkable'}\`;
      } else {
        tooltip.style.display = 'none';
      }
    });
    viewport.addEventListener('mouseleave', () => tooltip.style.display = 'none');

    function applyChanges(changes) {
      changes.forEach((change) => {
        if (Number.isInteger(change.index) && change.index >= 0 && change.index < data.length) {
          data[change.index] = change.value & 0xff;
          refreshCell(change.index);
        }
      });
      flushImage();
      scheduleDraw();
    }

    function applyRuns(runs) {
      runs.forEach((run) => {
        if (!Number.isInteger(run.start) || !Number.isInteger(run.length) || !Number.isInteger(run.value) ||
            run.start < 0 || run.length < 1 || run.start + run.length > data.length) return;
        for (let index = run.start; index < run.start + run.length; index++) {
          data[index] = run.value & 0xff;
          refreshCell(index);
        }
      });
      flushImage();
      scheduleDraw();
    }

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'applyCells' && Array.isArray(message.changes)) {
        applyChanges(message.changes);
      } else if (message.type === 'applyRuns' && Array.isArray(message.runs)) {
        applyRuns(message.runs);
      } else if (message.type === 'dirtyStateChanged') {
        document.getElementById('dirtyBadge').hidden = !message.isDirty;
      }
    });

    // Init: size canvas then fit map
    resizeCanvas();
    if (!Number.isFinite(savedState.zoom)) fitToView();
    setTool(tool);
    updateBrushValue();
    updateBrushSize();
    draw();
  </script>
</body>
</html>`;
}

// ── Editable document ─────────────────────────────────────────────────────────

class WpmDocument extends EditableBinaryDocument<WpmFile> {}

interface WpmRequestedRun {
    start: number;
    length: number;
    value: number;
}

interface WpmRunChange extends WpmRequestedRun {
    before: number;
    after: number;
}

interface WpmEditMessage {
    type?: string;
    changes?: Array<{ index?: number; value?: number }>;
    runs?: Array<{ start?: number; length?: number; value?: number }>;
}

function compactWpmRuns(changes: Array<{ index: number; value: number }>): WpmRequestedRun[] {
    const sorted = changes.slice().sort((a, b) => a.index - b.index);
    const runs: WpmRequestedRun[] = [];
    for (const change of sorted) {
        const previous = runs[runs.length - 1];
        if (previous && previous.start + previous.length === change.index && previous.value === change.value) {
            previous.length++;
        } else {
            runs.push({ start: change.index, length: 1, value: change.value });
        }
    }
    return runs;
}

function collectWpmCellRequests(changes: Array<{ index?: number; value?: number }>, dataLength: number): Map<number, number> {
    const requested = new Map<number, number>();
    for (const change of changes) {
        if (Number.isInteger(change.index) && Number.isInteger(change.value) &&
            (change.index as number) >= 0 && (change.index as number) < dataLength &&
            (change.value as number) >= 0 && (change.value as number) <= 0xff) {
            requested.set(change.index as number, change.value as number);
        }
    }
    return requested;
}

function collectWpmRunRequests(runs: Array<{ start?: number; length?: number; value?: number }>, dataLength: number): WpmRequestedRun[] {
    const requested: WpmRequestedRun[] = [];
    for (const run of runs) {
        const valid = Number.isInteger(run.start) && Number.isInteger(run.length) && Number.isInteger(run.value) &&
            (run.start as number) >= 0 && (run.length as number) >= 1 &&
            (run.start as number) + (run.length as number) <= dataLength &&
            (run.value as number) >= 0 && (run.value as number) <= 0xff;
        if (valid) requested.push({ start: run.start as number, length: run.length as number, value: run.value as number });
    }
    return requested.sort((a, b) => a.start - b.start);
}

function collectWpmRequests(message: WpmEditMessage, dataLength: number): WpmRequestedRun[] {
    if (message.type === 'editCells' && Array.isArray(message.changes)) {
        const requested = collectWpmCellRequests(message.changes, dataLength);
        return compactWpmRuns(Array.from(requested, ([index, value]) => ({ index, value })));
    }
    if (message.type === 'editRuns' && Array.isArray(message.runs)) {
        return collectWpmRunRequests(message.runs, dataLength);
    }
    return [];
}

function buildWpmRunChanges(data: Buffer, requested: WpmRequestedRun[]): WpmRunChange[] {
    const changes: WpmRunChange[] = [];
    for (const run of requested) {
        let start = run.start;
        let before = data[start];
        let length = 1;
        for (let offset = 1; offset < run.length; offset++) {
            const nextBefore = data[run.start + offset];
            if (nextBefore === before) {
                length++;
                continue;
            }
            if (before !== run.value) changes.push({ start, length, value: run.value, before, after: run.value });
            start = run.start + offset;
            before = nextBefore;
            length = 1;
        }
        if (before !== run.value) changes.push({ start, length, value: run.value, before, after: run.value });
    }
    return changes;
}

function wpmRunCellCount(changes: WpmRunChange[]): number {
    return changes.reduce((total, change) => total + change.length, 0);
}

/** Write one direction of a run change into the grid and mirror it to the webview canvas. */
function applyWpmRuns(doc: WpmDocument, changes: WpmRunChange[], useBefore: boolean): void {
    const patches: WpmRequestedRun[] = [];
    for (const change of changes) {
        const value = useBefore ? change.before : change.after;
        for (let index = change.start; index < change.start + change.length; index++) doc.file.data[index] = value;
        patches.push({ start: change.start, length: change.length, value });
    }
    void doc.webview?.postMessage({ type: 'applyRuns', runs: patches });
}

function handleWpmMessage(message: unknown, doc: WpmDocument, provider: WpmEditorProvider): void {
    if (!message || typeof message !== 'object') return;
    const requested = collectWpmRequests(message as WpmEditMessage, doc.file.data.length);
    if (!requested.length) return;
    const changes = buildWpmRunChanges(doc.file.data, requested);
    if (!changes.length) return;
    const changedCells = wpmRunCellCount(changes);
    const verb = changes.every((change) => change.after === 0) ? 'Erase' : 'Paint';
    provider.pushEdit(doc, `${verb} ${changedCells} pathing cell${changedCells === 1 ? '' : 's'}`, {
        apply: () => applyWpmRuns(doc, changes, false),
        revert: () => applyWpmRuns(doc, changes, true),
    });
}

class WpmEditorProvider extends EditableBinaryEditorProvider<WpmFile, WpmDocument> {
    constructor() {
        super({
            label: 'pathing map',
            parse: parseWpm,
            serialize: serializeValidatedWpm,
            createDocument: (uri, file) => new WpmDocument(uri, file),
            render: (doc) => buildWpmHtml(doc.file, doc.fileName, doc.isDirty),
            // The canvas is patched incrementally through `applyRuns`; only the badge needs the state.
            postState: (doc) => { void doc.webview?.postMessage({ type: 'dirtyStateChanged', isDirty: doc.isDirty }); },
            handleMessage: handleWpmMessage,
        });
    }
}

/** Safety gate: never write a WPM that does not reproduce the complete edited grid. */
function serializeValidatedWpm(file: WpmFile, name: string): Buffer {
    if (file.error) throw new Error(`Refusing to save ${name}: the source file did not parse (${file.error}).`);
    const bytes = serializeWpm(file);
    const reparsed = parseWpm(bytes);
    if (reparsed.error) throw new Error(`Refusing to save ${name}: serialized data did not re-parse (${reparsed.error}).`);
    if (reparsed.version !== file.version || reparsed.width !== file.width || reparsed.height !== file.height ||
        !reparsed.data.equals(file.data) || !reparsed.tail?.equals(file.tail ?? Buffer.alloc(0))) {
        throw new Error(`Refusing to save ${name}: round-trip verification failed.`);
    }
    return bytes;
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerWpmPreview(_context: vscode.ExtensionContext): vscode.Disposable[] {
    return [vscode.window.registerCustomEditorProvider(
        'wurst.wpmPreview',
        new WpmEditorProvider(),
        { supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true } },
    )];
}
