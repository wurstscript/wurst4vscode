'use strict';

/** VS Code preview for WC3 war3map.wpm (pathing). Parser lives in `casc-ts/formats`. */

import * as vscode from 'vscode';
import { parseWpm, serializeWpm, WpmFile } from 'casc-ts/formats';
import { showErrorWithLogs } from './diagnostics';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';
export { WpmFile } from 'casc-ts/formats';

// ── HTML Rendering ────────────────────────────────────────────────────────────

function buildWpmHtml(wpm: WpmFile, fileName: string, isDirty: boolean): string {
    const dataBase64 = wpm.data.toString('base64');

    // Color formula — must stay in sync with the ImageData loop in the <script>.
    // Primary flags use wc3libs RGB channels (UNWALK=R, UNFLY=G, UNBUILD=B).
    // Secondary flags (blight/water/unknown) use a 50% blend toward a strong
    // representative color so they remain distinguishable on top of any primary.
    function cellRgb(flag: number): [number, number, number] {
        let r = (flag & 0x02) ? 255 : 0;   // No Walk  → red channel
        let g = (flag & 0x04) ? 255 : 0;   // No Fly   → green channel
        let b = (flag & 0x08) ? 255 : 0;   // No Build → blue channel
        if (flag & 0x20) { r = (r + 190) >> 1; g = (g +  80) >> 1; b =  b        >> 1; } // Blight   → amber
        if (flag & 0x40) { r =  r        >> 1; g = (g + 140) >> 1; b = (b + 220) >> 1; } // No Water → teal
        if (flag & 0x80) { r = (r + 110) >> 1; g = (g + 110) >> 1; b = (b + 110) >> 1; } // Unknown  → gray
        return [r, g, b];
    }
    const swatchRgb = (flag: number) => { const [r,g,b] = cellRgb(flag); return `rgb(${r},${g},${b})`; };

    // Single-flag entries
    const singleFlags: Array<[number, string]> = [
        [0x02, 'No Walk'],
        [0x04, 'No Fly'],
        [0x08, 'No Build'],
        [0x20, 'Blight'],
        [0x40, 'No Water'],
        [0x80, 'Unknown'],
    ];
    // Common combination entries (combinations blend the same formula)
    const comboFlags: Array<[number, string]> = [
        [0x02 | 0x08, 'No Walk + No Build'],
        [0x02 | 0x04, 'No Walk + No Fly'],
        [0x04 | 0x08, 'No Fly + No Build'],
        [0x04 | 0x20, 'No Fly + Blight'],
        [0x04 | 0x40, 'No Fly + No Water'],
    ];

    const makeLegendItem = ([flag, label]: [number, string]) =>
        `<div class="item"><div class="color" style="background:${swatchRgb(flag)}"></div>${label}</div>`;

    const legendHtml = `
    <div class="legend-section">
      <div class="legend-heading">Single flags</div>
      <div class="legend-row">${singleFlags.map(makeLegendItem).join('')}</div>
    </div>
    <div class="legend-section">
      <div class="legend-heading">Common combinations &nbsp;<span class="legend-note">(hover any cell to see exact flags)</span></div>
      <div class="legend-row">${comboFlags.map(makeLegendItem).join('')}</div>
    </div>`;

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
  #viewport {
    flex: 1; overflow: hidden; position: relative;
    background: color-mix(in srgb, var(--bg) 60%, #000);
    cursor: crosshair;
  }
  #wpmCanvas { display: block; position: absolute; top: 0; left: 0; image-rendering: pixelated; }
  #tooltip {
    position: fixed; pointer-events: none;
    background: var(--panel); border: 1px solid var(--border);
    padding: 7px 10px; border-radius: 4px; font-size: 11px; display: none; z-index: 10;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4); line-height: 1.7;
  }
  footer {
    padding: 8px 12px 10px; border-top: 1px solid var(--border);
    background: var(--panel); flex-shrink: 0;
  }
  .editbar { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 10px; margin-bottom: 9px; }
  .editbar .tools { display: flex; gap: 2px; }
  .brush-flags { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 10px; }
  .brush-flags label { display: flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 11px; }
  .brush-flags input { margin: 0; }
  #brushValue { color: var(--muted); font: 11px var(--vscode-editor-font-family); min-width: 38px; }
  .edit-hint { color: var(--muted); font-size: 10px; margin-left: auto; }
  .legend-section { margin-bottom: 6px; }
  .legend-heading { font-size: 10px; color: var(--muted); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.05em; }
  .legend-note { font-size: 10px; color: var(--muted); text-transform: none; letter-spacing: 0; opacity: 0.75; }
  .legend-row { display: flex; flex-wrap: wrap; gap: 6px 18px; }
  .item { display: flex; align-items: center; font-size: 12px; }
  .color { width: 12px; height: 12px; border-radius: 2px; margin-right: 6px; border: 1px solid rgba(128,128,128,0.3); flex-shrink: 0; }
</style>
</head>
<body>
  <header>
    <span class="title">${escapeHtml(fileName)}</span>
    <span class="meta">${wpm.width} × ${wpm.height} &nbsp;·&nbsp; v${wpm.version}</span>
    <span id="dirtyBadge" class="dirty"${isDirty ? '' : ' hidden'}>Modified</span>
    <div class="toolbar">
      <button id="btnZoomOut" title="Zoom out">−</button>
      <span id="zoomLabel">–</span>
      <button id="btnZoomIn" title="Zoom in">+</button>
      <div class="sep"></div>
      <button id="btnZoomFit">Fit</button>
    </div>
  </header>

  <div id="viewport">
    <canvas id="wpmCanvas"></canvas>
  </div>
  <div id="tooltip"></div>

  <footer>
    <div class="editbar">
      <div class="tools">
        <button type="button" data-tool="pan" class="active" title="Drag to move around the map">Pan</button>
        <button type="button" data-tool="paint" title="Add or replace pathing flags">Paint</button>
        <button type="button" data-tool="erase" title="Delete pathing flags from cells">Erase</button>
      </div>
      <div class="sep"></div>
      <div class="brush-flags" title="Flags written by the Paint tool">
        <label title="Reserved bit 0x01"><input type="checkbox" data-brush-bit="1"> 0x01</label>
        <label><input type="checkbox" data-brush-bit="2" checked> No Walk</label>
        <label><input type="checkbox" data-brush-bit="4"> No Fly</label>
        <label><input type="checkbox" data-brush-bit="8" checked> No Build</label>
        <label title="Reserved bit 0x10"><input type="checkbox" data-brush-bit="16"> 0x10</label>
        <label><input type="checkbox" data-brush-bit="32"> Blight</label>
        <label><input type="checkbox" data-brush-bit="64"> No Water</label>
        <label><input type="checkbox" data-brush-bit="128"> Unknown</label>
        <span id="brushValue">0x0A</span>
      </div>
      <span class="edit-hint">Each drag is one undo step · Alt+click picks a cell</span>
    </div>
    ${legendHtml}
  </footer>

  <script>
    const api = acquireVsCodeApi();
    const W = ${wpm.width};
    const H = ${wpm.height};
    const raw = atob("${dataBase64}");
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
        let r = (flag & 0x02) ? 255 : 0;   // No Walk  → red
        let g = (flag & 0x04) ? 255 : 0;   // No Fly   → green
        let b = (flag & 0x08) ? 255 : 0;   // No Build → blue
        if (flag & 0x20) { r = (r+190)>>1; g = (g+ 80)>>1; b =  b      >>1; } // Blight   → amber blend
        if (flag & 0x40) { r =  r      >>1; g = (g+140)>>1; b = (b+220)>>1; } // No Water → teal blend
        if (flag & 0x80) { r = (r+110)>>1; g = (g+110)>>1; b = (b+110)>>1; } // Unknown  → gray blend
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
    let tool = ['pan', 'paint', 'erase'].includes(savedState.tool) ? savedState.tool : 'pan';
    const MIN_ZOOM = 0.05, MAX_ZOOM = 64;

    function persistView() { api.setState({ camX, camY, zoom, tool }); }

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

      zoomLabel.textContent = zoom >= 1
        ? zoom.toFixed(zoom < 10 ? 1 : 0) + ' px/cell'
        : (zoom * 100).toFixed(0) + '%';
    }

    function refreshCell(index) {
      writePixel(index);
      const dataY = Math.floor(index / W);
      const dispY = H - 1 - dataY;
      offCtx.putImageData(img, 0, 0, index % W, dispY, 1, 1);
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

    function editCell(x, y) {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const index = y * W + x;
      const next = tool === 'erase' ? 0 : brushValue();
      if (!gestureChanges.has(index)) gestureChanges.set(index, data[index]);
      data[index] = next;
      refreshCell(index);
    }

    function editLine(fromX, fromY, toX, toY) {
      const dx = Math.abs(toX - fromX), sx = fromX < toX ? 1 : -1;
      const dy = -Math.abs(toY - fromY), sy = fromY < toY ? 1 : -1;
      let x = fromX, y = fromY, err = dx + dy;
      while (true) {
        editCell(x, y);
        if (x === toX && y === toY) break;
        const twice = 2 * err;
        if (twice >= dy) { err += dy; x += sx; }
        if (twice <= dx) { err += dx; y += sy; }
      }
      scheduleDraw();
    }

    function finishEdit() {
      if (!editing) return;
      editing = false;
      const changes = [];
      gestureChanges.forEach((before, index) => {
        const value = data[index];
        if (value !== before) changes.push({ index, value });
      });
      gestureChanges = new Map();
      if (changes.length) api.postMessage({ type: 'editCells', changes });
    }

    viewport.addEventListener('pointerdown', (e) => {
      const cell = eventCell(e);
      if (e.button === 0 && e.altKey && cell) { pickBrush(data[cell.index]); return; }
      if (tool !== 'pan' && e.button === 0 && cell) {
        editing = true; gestureChanges = new Map(); lastEditX = cell.x; lastEditY = cell.y;
        viewport.setPointerCapture(e.pointerId);
        editCell(cell.x, cell.y); scheduleDraw();
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
        if (cell && (cell.x !== lastEditX || cell.y !== lastEditY)) {
          editLine(lastEditX, lastEditY, cell.x, cell.y);
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
    const endDrag = () => { finishEdit(); dragging = false; persistView(); viewport.style.cursor = tool === 'pan' ? 'grab' : 'crosshair'; };
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
      document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
      viewport.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
      persistView();
    }
    document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
    document.querySelectorAll('[data-brush-bit]').forEach((input) => input.addEventListener('change', updateBrushValue));

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
        const parts = [];
        if (flag & 0x01) parts.push('Unused (0x01)');
        if (flag & 0x02) parts.push('No Walk');
        if (flag & 0x04) parts.push('No Fly');
        if (flag & 0x08) parts.push('No Build');
        if (flag & 0x10) parts.push('Unused (0x10)');
        if (flag & 0x20) parts.push('Blight');
        if (flag & 0x40) parts.push('No Water');
        if (flag & 0x80) parts.push('Unknown');
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 16) + 'px';
        tooltip.style.top  = (e.clientY + 16) + 'px';
        tooltip.innerHTML = \`<strong>(\${dataX}, \${dataY})</strong>&ensp;0x\${flag.toString(16).padStart(2,'0').toUpperCase()}<br>\${parts.join(', ') || 'Walkable'}\`;
      } else {
        tooltip.style.display = 'none';
      }
    });
    viewport.addEventListener('mouseleave', () => tooltip.style.display = 'none');

    window.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.type === 'applyCells' && Array.isArray(message.changes)) {
        message.changes.forEach((change) => {
          if (Number.isInteger(change.index) && change.index >= 0 && change.index < data.length) {
            data[change.index] = change.value & 0xff;
            refreshCell(change.index);
          }
        });
        scheduleDraw();
      } else if (message.type === 'dirtyStateChanged') {
        document.getElementById('dirtyBadge').hidden = !message.isDirty;
      }
    });

    // Init: size canvas then fit map
    resizeCanvas();
    if (!Number.isFinite(savedState.zoom)) fitToView();
    setTool(tool);
    updateBrushValue();
    draw();
  </script>
</body>
</html>`;
}

// ── Editable document ─────────────────────────────────────────────────────────

class WpmDocument implements vscode.CustomDocument {
    currentRevision = 0;
    savedRevision = 0;
    nextRevision = 1;
    webview?: vscode.Webview;

    constructor(readonly uri: vscode.Uri, public file: WpmFile) {}

    dispose(): void {}
}

interface WpmCellChange {
    index: number;
    before: number;
    after: number;
}

class WpmEditorProvider implements vscode.CustomEditorProvider<WpmDocument> {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<WpmDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChange.event;

    async openCustomDocument(uri: vscode.Uri, openContext: vscode.CustomDocumentOpenContext): Promise<WpmDocument> {
        const source = openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
        const doc = new WpmDocument(uri, parseWpm(Buffer.from(await vscode.workspace.fs.readFile(source))));
        if (openContext.backupId) {
            doc.currentRevision = 1;
            doc.nextRevision = 2;
        }
        return doc;
    }

    async resolveCustomEditor(doc: WpmDocument, panel: vscode.WebviewPanel): Promise<void> {
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        doc.webview = panel.webview;
        panel.onDidDispose(() => { if (doc.webview === panel.webview) doc.webview = undefined; });
        panel.webview.onDidReceiveMessage((message) => this.handleMessage(message, doc));
        this.render(doc, panel.webview);
    }

    private render(doc: WpmDocument, webview: vscode.Webview): void {
        const fileName = doc.uri.path.slice(doc.uri.path.lastIndexOf('/') + 1);
        webview.html = doc.file.error
            ? buildPage({
                csp: "default-src 'none'; style-src 'unsafe-inline';",
                title: escapeHtml(fileName),
                body: `<div class="wv-state">
  <span>Failed to parse WPM</span>
  <span class="err">${escapeHtml(doc.file.error)}</span>
</div>`,
            })
            : buildWpmHtml(doc.file, fileName, doc.currentRevision !== doc.savedRevision);
    }

    private handleMessage(message: unknown, doc: WpmDocument): void {
        if (!message || typeof message !== 'object') return;
        const msg = message as { type?: string; changes?: Array<{ index?: number; value?: number }> };
        if (msg.type !== 'editCells' || !Array.isArray(msg.changes)) return;

        const requested = new Map<number, number>();
        for (const change of msg.changes) {
            if (Number.isInteger(change.index) && Number.isInteger(change.value) &&
                (change.index as number) >= 0 && (change.index as number) < doc.file.data.length &&
                (change.value as number) >= 0 && (change.value as number) <= 0xff) {
                requested.set(change.index as number, change.value as number);
            }
        }
        const changes: WpmCellChange[] = [];
        requested.forEach((after, index) => {
            const before = doc.file.data[index];
            if (after !== before) changes.push({ index, before, after });
        });
        if (!changes.length) return;

        const beforeRevision = doc.currentRevision;
        const afterRevision = doc.nextRevision++;
        this.applyCells(doc, changes, false);
        doc.currentRevision = afterRevision;
        this.postDirtyState(doc);
        this._onDidChange.fire({
            document: doc,
            label: `${changes.every((change) => change.after === 0) ? 'Erase' : 'Paint'} ${changes.length} pathing cell${changes.length === 1 ? '' : 's'}`,
            undo: () => {
                this.applyCells(doc, changes, true);
                doc.currentRevision = beforeRevision;
                this.postDirtyState(doc);
            },
            redo: () => {
                this.applyCells(doc, changes, false);
                doc.currentRevision = afterRevision;
                this.postDirtyState(doc);
            },
        });
    }

    private applyCells(doc: WpmDocument, changes: WpmCellChange[], useBefore: boolean): void {
        const patches = changes.map((change) => {
            const value = useBefore ? change.before : change.after;
            doc.file.data[change.index] = value;
            return { index: change.index, value };
        });
        void doc.webview?.postMessage({ type: 'applyCells', changes: patches });
    }

    private postDirtyState(doc: WpmDocument): void {
        void doc.webview?.postMessage({ type: 'dirtyStateChanged', isDirty: doc.currentRevision !== doc.savedRevision });
    }

    async saveCustomDocument(doc: WpmDocument): Promise<void> {
        try {
            await this.writeWpm(doc, doc.uri);
            doc.savedRevision = doc.currentRevision;
            this.postDirtyState(doc);
        } catch (err) {
            void showErrorWithLogs(`Pathing map not saved: ${err instanceof Error ? err.message : String(err)}`, err);
            throw err;
        }
    }

    async saveCustomDocumentAs(doc: WpmDocument, target: vscode.Uri): Promise<void> {
        await vscode.workspace.fs.writeFile(target, serializeValidatedWpm(doc.file, target.path));
    }

    private async writeWpm(doc: WpmDocument, uri: vscode.Uri): Promise<void> {
        const bytes = serializeValidatedWpm(doc.file, uri.path);
        try {
            const existing = Buffer.from(await vscode.workspace.fs.readFile(uri));
            if (existing.equals(bytes)) return;
        } catch { /* missing → write */ }
        await vscode.workspace.fs.writeFile(uri, bytes);
    }

    async revertCustomDocument(doc: WpmDocument): Promise<void> {
        doc.file = parseWpm(Buffer.from(await vscode.workspace.fs.readFile(doc.uri)));
        doc.currentRevision = 0;
        doc.savedRevision = 0;
        doc.nextRevision = 1;
        if (doc.webview) this.render(doc, doc.webview);
    }

    async backupCustomDocument(doc: WpmDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        await vscode.workspace.fs.writeFile(context.destination, serializeValidatedWpm(doc.file, doc.uri.path));
        return {
            id: context.destination.toString(),
            delete: () => vscode.workspace.fs.delete(context.destination).then(() => undefined, () => undefined),
        };
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
