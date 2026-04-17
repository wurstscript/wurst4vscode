'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

// ── Binary Reader ─────────────────────────────────────────────────────────────

class BinReader {
    private pos = 0;
    constructor(private readonly buf: Buffer) {}

    get offset(): number { return this.pos; }
    get remaining(): number { return this.buf.length - this.pos; }
    get eof(): boolean { return this.pos >= this.buf.length; }

    readI32(): number {
        if (this.remaining < 4) throw new Error(`Buffer underflow: need i32`);
        const v = this.buf.readInt32LE(this.pos);
        this.pos += 4;
        return v;
    }

    readU8(): number {
        if (this.remaining < 1) throw new Error(`Buffer underflow: need u8`);
        return this.buf[this.pos++];
    }

    readId(): string {
        if (this.remaining < 4) throw new Error(`Buffer underflow: need id`);
        const b = this.buf.slice(this.pos, this.pos + 4);
        this.pos += 4;
        return String.fromCharCode(b[0], b[1], b[2], b[3]);
    }
}

// ── WPM Parser ────────────────────────────────────────────────────────────────

export interface WpmFile {
    version: number;
    width: number;
    height: number;
    data: Buffer;
    error?: string;
}

export function parseWpm(data: Buffer): WpmFile {
    const r = new BinReader(data);
    try {
        const magic = r.readId();
        if (magic !== 'MP3W') {
            throw new Error(`Unexpected magic "${magic}", expected "MP3W"`);
        }
        const version = r.readI32();
        const width = r.readI32();
        const height = r.readI32();

        const expectedSize = width * height;
        if (r.remaining < expectedSize) {
            throw new Error(`Buffer too small: expected ${expectedSize} bytes, got ${r.remaining}`);
        }

        return {
            version,
            width,
            height,
            data: data.slice(r.offset, r.offset + expectedSize)
        };
    } catch (e) {
        return {
            version: 0, width: 0, height: 0, data: Buffer.alloc(0),
            error: e instanceof Error ? e.message : String(e)
        };
    }
}

// ── HTML Rendering ────────────────────────────────────────────────────────────

function buildWpmHtml(wpm: WpmFile, fileName: string): string {
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
    <span class="title">${fileName}</span>
    <span class="meta">${wpm.width} × ${wpm.height} &nbsp;·&nbsp; v${wpm.version}</span>
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
    ${legendHtml}
  </footer>

  <script>
    const W = ${wpm.width};
    const H = ${wpm.height};
    const raw = atob("${dataBase64}");
    const data = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);

    const canvas    = document.getElementById('wpmCanvas');
    const ctx       = canvas.getContext('2d');
    const viewport  = document.getElementById('viewport');
    const zoomLabel = document.getElementById('zoomLabel');

    // ── Render map into offscreen ImageData once ───────────────────────────────
    // Direct pixel writes — vastly faster than fillRect per cell.
    // After this, the offscreen canvas is treated as a static image.
    const offscreen = document.createElement('canvas');
    offscreen.width = W; offscreen.height = H;
    const offCtx = offscreen.getContext('2d');
    const img = offCtx.createImageData(W, H);
    const px  = img.data;
    for (let dataY = 0; dataY < H; dataY++) {
      const dispY = H - 1 - dataY; // WC3 row 0 = bottom of map, flip for screen
      for (let x = 0; x < W; x++) {
        const flag = data[dataY * W + x];
        const i = (dispY * W + x) * 4;
        if (flag === 0) { px[i+3] = 0; continue; }
        let r = (flag & 0x02) ? 255 : 0;   // No Walk  → red
        let g = (flag & 0x04) ? 255 : 0;   // No Fly   → green
        let b = (flag & 0x08) ? 255 : 0;   // No Build → blue
        if (flag & 0x20) { r = (r+190)>>1; g = (g+ 80)>>1; b =  b      >>1; } // Blight   → amber blend
        if (flag & 0x40) { r =  r      >>1; g = (g+140)>>1; b = (b+220)>>1; } // No Water → teal blend
        if (flag & 0x80) { r = (r+110)>>1; g = (g+110)>>1; b = (b+110)>>1; } // Unknown  → gray blend
        px[i]=r; px[i+1]=g; px[i+2]=b; px[i+3]=230;
      }
    }
    offCtx.putImageData(img, 0, 0);

    // ── Camera state ───────────────────────────────────────────────────────────
    // camX/camY: which offscreen pixel is at the screen centre (float)
    // zoom: screen pixels per map cell (float, stepless)
    let camX = W / 2, camY = H / 2, zoom = 1;
    const MIN_ZOOM = 0.05, MAX_ZOOM = 64;

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
      scheduleDraw();
    }, { passive: false });

    // ── Drag to pan ────────────────────────────────────────────────────────────
    let dragging = false, dragSX = 0, dragSY = 0, dragCamX = 0, dragCamY = 0;
    viewport.addEventListener('pointerdown', (e) => {
      dragging = true;
      dragSX = e.clientX; dragSY = e.clientY;
      dragCamX = camX;    dragCamY = camY;
      viewport.setPointerCapture(e.pointerId);
      viewport.style.cursor = 'grabbing';
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      camX = dragCamX - (e.clientX - dragSX) / zoom;
      camY = dragCamY - (e.clientY - dragSY) / zoom;
      clampCam();
      scheduleDraw();
    });
    const endDrag = () => { dragging = false; viewport.style.cursor = 'crosshair'; };
    viewport.addEventListener('pointerup',     endDrag);
    viewport.addEventListener('pointercancel', endDrag);

    // ── Toolbar buttons ────────────────────────────────────────────────────────
    document.getElementById('btnZoomIn').addEventListener('click', () => {
      zoom = Math.min(MAX_ZOOM, zoom * 1.5); scheduleDraw();
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      zoom = Math.max(MIN_ZOOM, zoom / 1.5); scheduleDraw();
    });
    document.getElementById('btnZoomFit').addEventListener('click', () => {
      fitToView(); scheduleDraw();
    });

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

    // Init: size canvas then fit map
    resizeCanvas();
    fitToView();
    draw();
  </script>
</body>
</html>`;
}

// ── VSCode Custom Editor ──────────────────────────────────────────────────────

class WpmDocument implements vscode.CustomDocument {
    constructor(
        readonly uri: vscode.Uri,
        readonly html: string,
    ) {}
    dispose(): void {}
}

export class WpmEditorProvider implements vscode.CustomReadonlyEditorProvider<WpmDocument> {
    static readonly VIEW_TYPE = 'wurst.wpmPreview';

    async openCustomDocument(uri: vscode.Uri): Promise<WpmDocument> {
        const data = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const parsed = parseWpm(data);

        if (parsed.error) {
            return new WpmDocument(uri, `<div style="color:red;padding:20px;">Failed to parse WPM: ${parsed.error}</div>`);
        }

        const html = buildWpmHtml(parsed, path.basename(uri.fsPath));
        return new WpmDocument(uri, html);
    }

    resolveCustomEditor(doc: WpmDocument, panel: vscode.WebviewPanel): void {
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };
        panel.webview.html = doc.html;
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerWpmPreview(_context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        vscode.window.registerCustomEditorProvider(
            WpmEditorProvider.VIEW_TYPE,
            new WpmEditorProvider(),
            {
                supportsMultipleEditorsPerDocument: true,
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            },
        ),
    ];
}
