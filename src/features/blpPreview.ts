'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

const BLP_VIEW_TYPE = 'wurst.blpPreview';
const CONTENT_JPEG = 0;
const CONTENT_DIRECT = 1;
const MAX_DIMENSION = 65535;
const DDS_MAGIC = 0x20534444;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

type BlpDocument = vscode.CustomDocument;

type DecodedRasterImage =
    | {
          kind: 'raster';
          mode: 'rgba';
          width: number;
          height: number;
          rgbaBase64: string;
          warnings: string[];
          description: string;
      }
    | {
          kind: 'raster';
          mode: 'jpeg';
          width: number;
          height: number;
          jpegBase64: string;
          warnings: string[];
          description: string;
      };

type MdxSequenceInfo = {
    name: string;
    intervalStart: number;
    intervalEnd: number;
    looping: boolean;
};

type DecodedMdxModel = {
    kind: 'model';
    modelName: string;
    nodesCount: number;
    geosetsCount: number;
    trianglesCount: number;
    sequences: MdxSequenceInfo[];
    positionsBase64: string;
    normalsBase64: string;
    indicesBase64: string;
    warnings: string[];
    description: string;
};

type DecodedBlpImage = DecodedRasterImage | DecodedMdxModel;

class ByteReader {
    private pos = 0;

    constructor(private readonly bytes: Uint8Array) {}

    readChar4(): string {
        const chunk = this.readStrict(4, 'magic');
        return String.fromCharCode(chunk[0], chunk[1], chunk[2], chunk[3]);
    }

    readU8(name: string): number {
        return this.readStrict(1, name)[0];
    }

    readI32LE(name: string): number {
        const chunk = this.readStrict(4, name);
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        return view.getInt32(0, true);
    }

    readPadded(size: number, _fieldName: string): Uint8Array {
        const safeSize = Math.max(0, size);
        const available = Math.min(safeSize, this.remaining());
        const out = new Uint8Array(safeSize);
        const read = this.read(available);
        out.set(read, 0);
        return out;
    }

    read(size: number): Uint8Array {
        const safeSize = Math.max(0, size);
        const available = Math.min(safeSize, this.remaining());
        const out = new Uint8Array(available);
        out.set(this.bytes.subarray(this.pos, this.pos + available), 0);
        this.pos += available;
        return out;
    }

    remaining(): number {
        return this.bytes.length - this.pos;
    }

    size(): number {
        return this.bytes.length;
    }

    copy(offset: number, size: number): Uint8Array {
        if (offset < 0 || size <= 0 || offset >= this.bytes.length) {
            return new Uint8Array(0);
        }
        const available = Math.min(size, this.bytes.length - offset);
        return this.bytes.slice(offset, offset + available);
    }

    private readStrict(size: number, fieldName: string): Uint8Array {
        if (size < 0 || this.remaining() < size) {
            throw new Error(`${fieldName} is truncated`);
        }
        return this.read(size);
    }
}

export function registerBlpPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new BlpPreviewProvider();
    return vscode.window.registerCustomEditorProvider(BLP_VIEW_TYPE, provider, {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: true,
    });
}

class BlpPreviewProvider implements vscode.CustomReadonlyEditorProvider<BlpDocument> {
    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<BlpDocument> {
        return {
            uri,
            dispose: () => {},
        };
    }

    async resolveCustomEditor(
        document: BlpDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
        };

        const getFileName = () => path.basename(document.uri.fsPath || document.uri.path);
        webviewPanel.webview.html = this.buildHtml(webviewPanel.webview, getFileName());
        let requestId = 0;
        let webviewReady = false;
        let pendingRender = true;
        const dbg = (msg: string) => console.log(`[wurst-preview] ${msg}`);
        dbg(`resolve editor for ${document.uri.toString()}`);

        const render = async () => {
            const id = ++requestId;
            const fileName = getFileName();
            dbg(`render start #${id} for ${fileName}`);
            await webviewPanel.webview.postMessage({ type: 'loading', fileName });
            try {
                const bytes = await vscode.workspace.fs.readFile(document.uri);
                dbg(`read ${bytes.byteLength} bytes for ${fileName}`);
                const decoded = decodePreview(bytes, document.uri);
                if (id !== requestId) return;
                await webviewPanel.webview.postMessage({ type: 'image', fileName, decoded });
                dbg(`posted image payload for ${fileName}`);
            } catch (error) {
                if (id !== requestId) return;
                const message = error instanceof Error ? error.message : String(error);
                await webviewPanel.webview.postMessage({ type: 'error', fileName, message });
                dbg(`render error for ${fileName}: ${message}`);
            }
        };

        const requestRender = () => {
            if (!webviewReady) {
                pendingRender = true;
                dbg(`render queued until webview ready`);
                return;
            }
            void render();
        };
        requestRender();
        setTimeout(() => {
            if (!webviewReady) {
                dbg(`webview did not send ready within 3000ms`);
                void webviewPanel.webview.postMessage({
                    type: 'error',
                    fileName: getFileName(),
                    message: 'Webview script did not initialize (no ready handshake). Open Developer Tools for details.',
                });
            }
        }, 3000);

        const filePath = document.uri.fsPath;
        if (document.uri.scheme === 'file' && filePath) {
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(path.dirname(filePath), path.basename(filePath))
            );
            const rerender = () => requestRender();
            watcher.onDidChange(rerender);
            watcher.onDidCreate(rerender);
            webviewPanel.onDidDispose(() => watcher.dispose());
        }

        webviewPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
            if (typeof msg !== 'object' || !msg) return;
            const type = (msg as { type?: string }).type;
            if (type === 'ready') {
                webviewReady = true;
                dbg(`webview ready`);
                if (pendingRender) {
                    pendingRender = false;
                    await render();
                }
                return;
            }
            if (type === 'debug') {
                const message = (msg as { message?: string }).message ?? '';
                dbg(`webview: ${message}`);
                return;
            }
            if (type === 'refresh') {
                dbg(`refresh requested by webview`);
                requestRender();
            }
        });
    }

    private buildHtml(webview: vscode.Webview, initialFileName: string): string {
        const nonce = makeNonce();
        const fileName = escapeHtml(initialFileName);
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} blob: data:`,
            `script-src 'nonce-${nonce}'`,
            "style-src 'unsafe-inline'",
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(fileName)}</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --panel: var(--vscode-sideBar-background);
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --warn: var(--vscode-editorWarning-foreground);
      --border: var(--vscode-panel-border);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --cb-a: color-mix(in srgb, var(--vscode-editorWidget-background) 65%, transparent);
      --cb-b: color-mix(in srgb, var(--vscode-editorWidget-border) 55%, transparent);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      display: grid;
      grid-template-rows: auto 1fr;
      min-height: 100vh;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
      position: sticky;
      top: 0;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta strong {
      color: var(--text);
      font-size: 13px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
      min-width: 0;
    }
    button {
      border: 1px solid transparent;
      background: var(--btn-bg);
      color: var(--btn-fg);
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: var(--btn-hover); }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .zoom-label {
      min-width: 52px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    main {
      display: grid;
      place-items: center;
      padding: 18px;
      gap: 12px;
      width: 100%;
      min-width: 0;
    }
    .viewport {
      position: relative;
      width: min(100%, 1000px);
      max-width: 100%;
      height: min(72vh, calc(100vh - 180px));
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: repeating-conic-gradient(var(--cb-a) 0% 25%, var(--cb-b) 0% 50%) 50% / 20px 20px;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .gizmo {
      position: absolute;
      right: 8px;
      bottom: 8px;
      width: 92px;
      height: 92px;
      border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel) 65%, transparent);
      pointer-events: none;
    }
    .viewport.dragging { cursor: grabbing; }
    .stage {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      will-change: transform;
      transition: opacity 130ms ease;
    }
    canvas {
      display: block;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .stage-canvas {
      position: static;
      width: auto;
      height: auto;
    }
    .warnings {
      max-width: min(980px, calc(100vw - 40px));
      color: var(--warn);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .debuglog {
      max-width: min(980px, calc(100vw - 40px));
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
      white-space: pre-wrap;
      max-height: 160px;
      overflow: auto;
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: 6px;
      padding: 8px;
      background: color-mix(in srgb, var(--panel) 70%, transparent);
      display: none;
    }
    .debuglog.visible {
      display: block;
    }
    .model-panel {
      width: min(100%, 1000px);
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel) 75%, transparent);
      padding: 10px;
      display: none;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      font-size: 12px;
    }
    .model-panel.visible {
      display: grid;
    }
    .model-meta strong {
      color: var(--text);
      font-size: 13px;
    }
    .model-anim {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .model-anim select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      padding: 4px 6px;
      min-width: 220px;
    }
    .loading-overlay {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      gap: 10px;
      background: color-mix(in srgb, var(--bg) 60%, transparent);
      opacity: 0;
      pointer-events: none;
      transition: opacity 130ms ease;
    }
    .loading-overlay.visible {
      opacity: 1;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid color-mix(in srgb, var(--text) 25%, transparent);
      border-top-color: var(--text);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    .loading-text {
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
    .loading-stage {
      opacity: 0.4;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @media (max-width: 760px) {
      header {
        grid-template-columns: 1fr;
      }
      .meta {
        white-space: normal;
      }
      .toolbar {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <header>
    <div class="meta">
      <strong id="fileName">${fileName}</strong><br/>
      <span id="fileMeta">Loading...</span>
    </div>
    <div class="toolbar">
      <button id="zoomOutBtn" type="button" title="Zoom out">-</button>
      <button id="zoomInBtn" type="button" title="Zoom in">+</button>
      <button id="zoomResetBtn" type="button" title="Reset zoom to 100%">100%</button>
      <button id="fitBtn" type="button" title="Fit image to viewport">Fit</button>
      <button id="renderModeBtn" type="button" title="Model render mode">Mode: Fill</button>
      <span id="zoomLabel" class="zoom-label">100%</span>
      <button id="refreshBtn" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <div id="viewport" class="viewport">
      <div id="stage" class="stage">
        <canvas id="canvas2d" class="stage-canvas" width="1" height="1"></canvas>
        <canvas id="canvas3d" class="stage-canvas" width="1" height="1" style="display:none;"></canvas>
      </div>
      <canvas id="gizmo" class="gizmo" width="92" height="92"></canvas>
      <div id="loadingOverlay" class="loading-overlay visible">
        <div class="spinner"></div>
        <div id="loadingText" class="loading-text">Loading image...</div>
      </div>
    </div>
    <div id="modelPanel" class="model-panel">
      <div id="modelMeta" class="model-meta"></div>
      <div class="model-anim">
        <label for="animSelect">Animation</label>
        <select id="animSelect"></select>
      </div>
    </div>
    <div id="warnings" class="warnings"></div>
    <div id="debugLog" class="debuglog"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentData = null;
    let modelState = null;
    const debugLines = [];
    const debugLimit = 120;

    function debug(msg) {
      const now = new Date();
      const ts = now.toISOString().slice(11, 19);
      const line = '[' + ts + '] ' + msg;
      debugLines.push(line);
      if (debugLines.length > debugLimit) debugLines.shift();
      const el = document.getElementById('debugLog');
      el.textContent = debugLines.join('\\n');
      el.classList.add('visible');
      try { vscode.postMessage({ type: 'debug', message: line }); } catch {}
    }

    function base64ToBytes(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    function bytesToFloat32(base64) {
      const bytes = base64ToBytes(base64);
      return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    }

    function bytesToUint32(base64) {
      const bytes = base64ToBytes(base64);
      return new Uint32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    }

    function showWarnings(messages) {
      const el = document.getElementById('warnings');
      if (!messages || !messages.length) {
        el.textContent = '';
        debug('warnings cleared');
        return;
      }
      el.textContent = messages.map((w) => '- ' + w).join('\\n');
      debug('warnings: ' + messages.length);
    }

    function setLoading(isLoading, text) {
      const overlay = document.getElementById('loadingOverlay');
      const loadingText = document.getElementById('loadingText');
      if (text) loadingText.textContent = text;
      if (isLoading) {
        overlay.classList.add('visible');
        stage.classList.add('loading-stage');
        debug('loading on: ' + (text || ''));
      } else {
        overlay.classList.remove('visible');
        stage.classList.remove('loading-stage');
        debug('loading off');
      }
    }

    function setMeta(fileName, metaText) {
      document.getElementById('fileName').textContent = fileName;
      document.getElementById('fileMeta').textContent = metaText;
      debug('meta: ' + fileName + ' | ' + metaText);
    }

    function setModelPanelVisible(visible) {
      const panel = document.getElementById('modelPanel');
      if (visible) panel.classList.add('visible');
      else panel.classList.remove('visible');
    }

    function buildModelState(data) {
      const rawPositions = bytesToFloat32(data.positionsBase64);
      const rawNormals = bytesToFloat32(data.normalsBase64);
      const indices = bytesToUint32(data.indicesBase64);
      const bounds = {
        minX: Infinity, minY: Infinity, minZ: Infinity,
        maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
      };
      for (let i = 0; i + 2 < rawPositions.length; i += 3) {
        const x = rawPositions[i], y = rawPositions[i + 1], z = rawPositions[i + 2];
        if (x < bounds.minX) bounds.minX = x;
        if (y < bounds.minY) bounds.minY = y;
        if (z < bounds.minZ) bounds.minZ = z;
        if (x > bounds.maxX) bounds.maxX = x;
        if (y > bounds.maxY) bounds.maxY = y;
        if (z > bounds.maxZ) bounds.maxZ = z;
      }
      const cx = isFinite(bounds.minX) ? (bounds.minX + bounds.maxX) * 0.5 : 0;
      const cy = isFinite(bounds.minY) ? (bounds.minY + bounds.maxY) * 0.5 : 0;
      const cz = isFinite(bounds.minZ) ? (bounds.minZ + bounds.maxZ) * 0.5 : 0;
      const sx = isFinite(bounds.minX) ? (bounds.maxX - bounds.minX) : 1;
      const sy = isFinite(bounds.minY) ? (bounds.maxY - bounds.minY) : 1;
      const sz = isFinite(bounds.minZ) ? (bounds.maxZ - bounds.minZ) : 1;
      const radius = Math.max(1e-4, Math.max(sx, Math.max(sy, sz)) * 0.5);
      const positions = new Float32Array(rawPositions.length);
      for (let i = 0; i + 2 < rawPositions.length; i += 3) {
        const srcX = (rawPositions[i] - cx) / radius;
        const srcY = (rawPositions[i + 1] - cy) / radius;
        const srcZ = (rawPositions[i + 2] - cz) / radius;
        // MDX Z-up to viewer Y-up.
        positions[i] = srcX;
        positions[i + 1] = srcZ;
        positions[i + 2] = srcY;
      }

      const normals = new Float32Array(positions.length);
      if (rawNormals.length >= normals.length) {
        for (let i = 0; i + 2 < normals.length; i += 3) {
          const nx = rawNormals[i];
          const ny = rawNormals[i + 1];
          const nz = rawNormals[i + 2];
          normals[i] = nx;
          normals[i + 1] = nz;
          normals[i + 2] = ny;
        }
      } else {
        // Fallback: derive averaged vertex normals from indices.
        for (let i = 0; i + 2 < indices.length; i += 3) {
          const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
          if (ic + 2 >= positions.length || ib + 2 >= positions.length || ia + 2 >= positions.length) continue;
          const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
          const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
          const cxv = positions[ic], cyv = positions[ic + 1], czv = positions[ic + 2];
          const ux = bx - ax, uy = by - ay, uz = bz - az;
          const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
          const nx = uy * vz - uz * vy;
          const ny = uz * vx - ux * vz;
          const nz = ux * vy - uy * vx;
          normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
          normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
          normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
        }
      }
      for (let i = 0; i + 2 < normals.length; i += 3) {
        const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        normals[i] = nx / nlen; normals[i + 1] = ny / nlen; normals[i + 2] = nz / nlen;
      }

      return {
        positions,
        normals,
        indices,
        version: Date.now() + Math.random(),
        yaw: Math.PI * 0.5,
        pitch: -0.52,
        distance: 3.2,
      };
    }

    const glState = {
      gl: null,
      modelProgram: null,
      gridProgram: null,
      modelPosBuffer: null,
      modelNrmBuffer: null,
      modelIdxBuffer: null,
      wireIdxBuffer: null,
      gridBuffer: null,
      modelIndexCount: 0,
      wireIndexCount: 0,
      gridVertexCount: 0,
      uploadedVersion: null,
    };

    function createProgram(gl, vsSource, fsSource) {
      const compile = (type, source) => {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          const log = gl.getShaderInfoLog(shader) || 'shader compile failed';
          gl.deleteShader(shader);
          throw new Error(log);
        }
        return shader;
      };
      const vs = compile(gl.VERTEX_SHADER, vsSource);
      const fs = compile(gl.FRAGMENT_SHADER, fsSource);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) || 'program link failed';
        gl.deleteProgram(program);
        throw new Error(log);
      }
      return program;
    }

    function ensureGl(canvas, state) {
      let gl = glState.gl;
      if (!gl) {
        gl = canvas.getContext('webgl2', { antialias: true, alpha: true, depth: true });
        if (!gl) {
          debug('webgl2 context unavailable');
          return null;
        }
        debug('webgl2 context created');
        glState.gl = gl;
        const modelVs = '#version 300 es\\n'
          + 'precision highp float;\\n'
          + 'in vec3 aPos;\\n'
          + 'in vec3 aNormal;\\n'
          + 'uniform mat4 uProj;\\n'
          + 'uniform mat4 uView;\\n'
          + 'out vec3 vNormal;\\n'
          + 'out vec3 vWorld;\\n'
          + 'void main() {\\n'
          + '  vec4 w = vec4(aPos, 1.0);\\n'
          + '  vWorld = w.xyz;\\n'
          + '  vNormal = normalize(aNormal);\\n'
          + '  gl_Position = uProj * uView * w;\\n'
          + '}\\n';
        const modelFs = '#version 300 es\\n'
          + 'precision highp float;\\n'
          + 'in vec3 vNormal;\\n'
          + 'in vec3 vWorld;\\n'
          + 'uniform vec3 uLightDir;\\n'
          + 'out vec4 outColor;\\n'
          + 'void main() {\\n'
          + '  float ndotl = dot(normalize(vNormal), normalize(uLightDir));\\n'
          + '  float h = ndotl * 0.5 + 0.5;\\n'
          + '  float halfLambert = h * h;\\n'
          + '  float light = 0.2 + 0.8 * halfLambert;\\n'
          + '  vec3 base = vec3(0.50, 0.57, 0.64);\\n'
          + '  vec3 warm = vec3(0.13, 0.09, 0.04);\\n'
          + '  vec3 col = base * light + warm * light * 0.25;\\n'
          + '  outColor = vec4(col, 1.0);\\n'
          + '}\\n';
        const gridVs = '#version 300 es\\n'
          + 'precision highp float;\\n'
          + 'in vec3 aPos;\\n'
          + 'uniform mat4 uProj;\\n'
          + 'uniform mat4 uView;\\n'
          + 'void main() { gl_Position = uProj * uView * vec4(aPos, 1.0); }\\n';
        const gridFs = '#version 300 es\\n'
          + 'precision highp float;\\n'
          + 'uniform vec4 uColor;\\n'
          + 'out vec4 outColor;\\n'
          + 'void main() { outColor = uColor; }\\n';
        glState.modelProgram = createProgram(gl, modelVs, modelFs);
        glState.gridProgram = createProgram(gl, gridVs, gridFs);
        glState.modelPosBuffer = gl.createBuffer();
        glState.modelNrmBuffer = gl.createBuffer();
        glState.modelIdxBuffer = gl.createBuffer();
        glState.wireIdxBuffer = gl.createBuffer();
        glState.gridBuffer = gl.createBuffer();

        const grid = [];
        const half = 1.6;
        const step = 0.2;
        for (let g = -half; g <= half + 1e-6; g += step) {
          grid.push(-half, 0, g, half, 0, g);
          grid.push(g, 0, -half, g, 0, half);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.gridBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(grid), gl.STATIC_DRAW);
        glState.gridVertexCount = grid.length / 3;
      }

      if (glState.uploadedVersion !== state.version) {
        debug('upload mesh buffers version=' + state.version);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.modelPosBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, state.positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.modelNrmBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, state.normals, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glState.modelIdxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, state.indices, gl.STATIC_DRAW);
        glState.modelIndexCount = state.indices.length;

        const edges = [];
        const seen = new Set();
        for (let i = 0; i + 2 < state.indices.length; i += 3) {
          const tri = [state.indices[i], state.indices[i + 1], state.indices[i + 2]];
          for (let e = 0; e < 3; e++) {
            const a = tri[e];
            const b = tri[(e + 1) % 3];
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            const key = lo + ':' + hi;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push(lo, hi);
          }
        }
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glState.wireIdxBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(edges), gl.STATIC_DRAW);
        glState.wireIndexCount = edges.length;
        glState.uploadedVersion = state.version;
      }

      return gl;
    }

    function mat4Perspective(fovY, aspect, near, far) {
      const f = 1 / Math.tan(fovY / 2);
      const nf = 1 / (near - far);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, (2 * far * near) * nf, 0,
      ]);
    }

    function mat4LookAt(ex, ey, ez, tx, ty, tz, ux, uy, uz) {
      let z0 = ex - tx;
      let z1 = ey - ty;
      let z2 = ez - tz;
      let len = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
      if (len === 0) {
        z2 = 1;
      } else {
        z0 /= len;
        z1 /= len;
        z2 /= len;
      }

      let x0 = uy * z2 - uz * z1;
      let x1 = uz * z0 - ux * z2;
      let x2 = ux * z1 - uy * z0;
      len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
      if (len !== 0) {
        x0 /= len;
        x1 /= len;
        x2 /= len;
      }

      const y0 = z1 * x2 - z2 * x1;
      const y1 = z2 * x0 - z0 * x2;
      const y2 = z0 * x1 - z1 * x0;

      return new Float32Array([
        x0, y0, z0, 0,
        x1, y1, z1, 0,
        x2, y2, z2, 0,
        -(x0 * ex + x1 * ey + x2 * ez),
        -(y0 * ex + y1 * ey + y2 * ez),
        -(z0 * ex + z1 * ey + z2 * ez),
        1,
      ]);
    }

    function renderModel(canvas, state) {
      const gl = ensureGl(canvas, state);
      if (!gl) throw new Error('WebGL2 is unavailable in this webview environment.');
      const width = Math.max(2, viewport.clientWidth);
      const height = Math.max(2, viewport.clientHeight);
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const cp = Math.cos(state.pitch);
      const eyeX = Math.sin(state.yaw) * cp * state.distance;
      const eyeY = Math.sin(-state.pitch) * state.distance;
      const eyeZ = Math.cos(state.yaw) * cp * state.distance;
      const proj = mat4Perspective(50 * Math.PI / 180, width / height, 0.03, 80);
      const view = mat4LookAt(eyeX, eyeY, eyeZ, 0, 0, 0, 0, 1, 0);

      // Grid
      gl.useProgram(glState.gridProgram);
      let loc = gl.getAttribLocation(glState.gridProgram, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, glState.gridBuffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(gl.getUniformLocation(glState.gridProgram, 'uProj'), false, proj);
      gl.uniformMatrix4fv(gl.getUniformLocation(glState.gridProgram, 'uView'), false, view);
      gl.uniform4f(gl.getUniformLocation(glState.gridProgram, 'uColor'), 0.50, 0.56, 0.64, 0.32);
      gl.drawArrays(gl.LINES, 0, glState.gridVertexCount);

      // Solid model
      if (modelRenderMode === 'fill' || modelRenderMode === 'both') {
        gl.useProgram(glState.modelProgram);
        const aPos = gl.getAttribLocation(glState.modelProgram, 'aPos');
        const aNrm = gl.getAttribLocation(glState.modelProgram, 'aNormal');
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.modelPosBuffer);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.modelNrmBuffer);
        gl.enableVertexAttribArray(aNrm);
        gl.vertexAttribPointer(aNrm, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glState.modelIdxBuffer);
        gl.uniformMatrix4fv(gl.getUniformLocation(glState.modelProgram, 'uProj'), false, proj);
        gl.uniformMatrix4fv(gl.getUniformLocation(glState.modelProgram, 'uView'), false, view);
        gl.uniform3f(gl.getUniformLocation(glState.modelProgram, 'uLightDir'), 0.12, 0.98, 0.18);
        gl.drawElements(gl.TRIANGLES, glState.modelIndexCount, gl.UNSIGNED_INT, 0);
      }

      // Wire overlay
      if (modelRenderMode === 'wire' || modelRenderMode === 'both') {
        gl.useProgram(glState.gridProgram);
        const aPos = gl.getAttribLocation(glState.gridProgram, 'aPos');
        gl.bindBuffer(gl.ARRAY_BUFFER, glState.modelPosBuffer);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glState.wireIdxBuffer);
        gl.uniformMatrix4fv(gl.getUniformLocation(glState.gridProgram, 'uProj'), false, proj);
        gl.uniformMatrix4fv(gl.getUniformLocation(glState.gridProgram, 'uView'), false, view);
        if (modelRenderMode === 'both') gl.uniform4f(gl.getUniformLocation(glState.gridProgram, 'uColor'), 0.16, 0.20, 0.24, 0.40);
        else gl.uniform4f(gl.getUniformLocation(glState.gridProgram, 'uColor'), 0.28, 0.34, 0.40, 0.95);
        gl.drawElements(gl.LINES, glState.wireIndexCount, gl.UNSIGNED_INT, 0);
      }

      renderGizmo(state);
      debug('gl viewport=' + width + 'x' + height + ' idx=' + glState.modelIndexCount + ' wire=' + glState.wireIndexCount);
      debug('model rendered');
    }

    function renderGizmo(state) {
      const gizmo = document.getElementById('gizmo');
      const g = gizmo.getContext('2d', { alpha: true });
      const w = gizmo.width;
      const h = gizmo.height;
      const cx = w * 0.5;
      const cy = h * 0.5;
      g.clearRect(0, 0, w, h);

      const cosY = Math.cos(state.yaw), sinY = Math.sin(state.yaw);
      const cosX = Math.cos(state.pitch), sinX = Math.sin(state.pitch);
      const axes = [
        { name: 'X', color: '#e35d6a', v: [1, 0, 0] },
        { name: 'Y', color: '#68c07a', v: [0, 1, 0] },
        { name: 'Z', color: '#5ca0e3', v: [0, 0, 1] },
      ];

      function rot(vx, vy, vz) {
        const x1 = vx * cosY + vz * sinY;
        const z1 = -vx * sinY + vz * cosY;
        const y1 = vy * cosX - z1 * sinX;
        const z2 = vy * sinX + z1 * cosX;
        return [x1, y1, z2];
      }

      axes.sort((a, b) => rot(a.v[0], a.v[1], a.v[2])[2] - rot(b.v[0], b.v[1], b.v[2])[2]);
      for (const axis of axes) {
        const r = rot(axis.v[0], axis.v[1], axis.v[2]);
        const sx = cx + r[0] * 24;
        const sy = cy - r[1] * 24;
        g.strokeStyle = axis.color;
        g.fillStyle = axis.color;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(sx, sy);
        g.stroke();
        g.font = '11px sans-serif';
        g.fillText(axis.name, sx + 3, sy - 3);
      }
      g.fillStyle = '#888b';
      g.beginPath();
      g.arc(cx, cy, 3, 0, Math.PI * 2);
      g.fill();
    }

    async function renderCurrent() {
      if (!currentData) return;
      const data = currentData;
      debug('renderCurrent kind=' + data.kind);
      const canvas2d = document.getElementById('canvas2d');
      const canvas3d = document.getElementById('canvas3d');
      if (data.kind === 'model') {
        modelState = buildModelState(data);
        canvas3d.style.display = '';
        canvas2d.style.display = 'none';
        setModelPanelVisible(true);
        stage.style.transform = 'translate(0px, 0px) scale(1)';
        const meta = document.getElementById('modelMeta');
        meta.innerHTML = '<strong>' + data.modelName + '</strong><br/>' +
          'Geosets: ' + data.geosetsCount + ' | Nodes: ' + data.nodesCount + ' | Triangles: ' + data.trianglesCount;
        const animSelect = document.getElementById('animSelect');
        animSelect.innerHTML = '';
        if (data.sequences.length === 0) {
          const opt = document.createElement('option');
          opt.textContent = 'No animations';
          animSelect.appendChild(opt);
        } else {
          for (const seq of data.sequences) {
            const opt = document.createElement('option');
            opt.textContent = seq.name + ' [' + seq.intervalStart + '-' + seq.intervalEnd + ']' + (seq.looping ? ' (loop)' : '');
            animSelect.appendChild(opt);
          }
        }
        renderModel(canvas3d, modelState);
        showWarnings(data.warnings);
        return;
      }

      modelState = null;
      canvas3d.style.display = 'none';
      canvas2d.style.display = '';
      setModelPanelVisible(false);
      const canvas = canvas2d;
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) {
        throw new Error('2D canvas context is unavailable.');
      }
      debug('2d context ready');
      canvas.width = data.width;
      canvas.height = data.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (data.mode === 'rgba') {
        const rgba = base64ToBytes(data.rgbaBase64);
        const image = new ImageData(new Uint8ClampedArray(rgba.buffer), data.width, data.height);
        ctx.putImageData(image, 0, 0);
      } else {
        const jpegBytes = base64ToBytes(data.jpegBase64);
        const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
        const objectUrl = URL.createObjectURL(blob);
        const image = await createImageBitmap(blob);
        try {
          ctx.drawImage(image, 0, 0, data.width, data.height);
          // Match Java ImageIO raster channel interpretation used by wc3libs:
          // BLP JPEG payloads are treated as BGR, then mapped to RGB.
          const img = ctx.getImageData(0, 0, data.width, data.height);
          const px = img.data;
          for (let i = 0; i < px.length; i += 4) {
            const r = px[i];
            px[i] = px[i + 2];
            px[i + 2] = r;
          }
          ctx.putImageData(img, 0, 0);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      }

      showWarnings(data.warnings);
      debug('raster rendered');
    }

    const viewport = document.getElementById('viewport');
    const stage = document.getElementById('stage');
    const zoomLabel = document.getElementById('zoomLabel');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomResetBtn = document.getElementById('zoomResetBtn');
    const fitBtn = document.getElementById('fitBtn');
    const renderModeBtn = document.getElementById('renderModeBtn');

    let zoom = 1;
    let tx = 0;
    let ty = 0;
    let dragActive = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragTx = 0;
    let dragTy = 0;
    let modelRenderMode = 'fill'; // both | fill | wire

    function updateRenderModeUi() {
      if (modelRenderMode === 'fill') renderModeBtn.textContent = 'Mode: Fill';
      else if (modelRenderMode === 'wire') renderModeBtn.textContent = 'Mode: Wire';
      else renderModeBtn.textContent = 'Mode: Both';
    }

    function clampZoom(value) {
      return Math.min(64, Math.max(0.05, value));
    }

    function applyTransform() {
      stage.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + zoom + ')';
      zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }

    function zoomAt(factor, clientX, clientY) {
      const rect = viewport.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;

      const nextZoom = clampZoom(zoom * factor);
      if (nextZoom === zoom) return;

      const imageX = (px - tx) / zoom;
      const imageY = (py - ty) / zoom;
      zoom = nextZoom;
      tx = px - imageX * zoom;
      ty = py - imageY * zoom;
      applyTransform();
    }

    function zoomByStep(direction) {
      const factor = direction > 0 ? 1.2 : 1 / 1.2;
      const rect = viewport.getBoundingClientRect();
      zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    function centerImage() {
      if (currentData && currentData.kind === 'model') {
        stage.style.transform = 'translate(0px, 0px) scale(1)';
        zoomLabel.textContent = '3D';
        return;
      }
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      const w = currentData ? currentData.width : 1;
      const h = currentData ? currentData.height : 1;
      tx = (vw - w * zoom) / 2;
      ty = (vh - h * zoom) / 2;
      applyTransform();
    }

    function fitToView() {
      if (!currentData || currentData.kind === 'model') return;
      const vw = Math.max(1, viewport.clientWidth);
      const vh = Math.max(1, viewport.clientHeight);
      zoom = Math.min(vw / currentData.width, vh / currentData.height);
      zoom = clampZoom(zoom);
      centerImage();
    }

    viewport.addEventListener('pointerdown', (ev) => {
      dragActive = true;
      dragStartX = ev.clientX;
      dragStartY = ev.clientY;
      dragTx = tx;
      dragTy = ty;
      viewport.classList.add('dragging');
      viewport.setPointerCapture(ev.pointerId);
    });

    viewport.addEventListener('pointermove', (ev) => {
      if (!dragActive) return;
      if (modelState) {
        const dx = ev.clientX - dragStartX;
        const dy = ev.clientY - dragStartY;
        dragStartX = ev.clientX;
        dragStartY = ev.clientY;
        modelState.yaw += dx * 0.008;
        modelState.pitch += dy * 0.008;
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
        return;
      }
      tx = dragTx + (ev.clientX - dragStartX);
      ty = dragTy + (ev.clientY - dragStartY);
      applyTransform();
    });

    function stopDrag(ev) {
      if (!dragActive) return;
      dragActive = false;
      viewport.classList.remove('dragging');
      try {
        viewport.releasePointerCapture(ev.pointerId);
      } catch {}
    }

    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointercancel', stopDrag);
    viewport.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (modelState) {
        const zoomFactor = ev.deltaY < 0 ? 0.9 : 1.1;
        modelState.distance = Math.max(0.2, Math.min(200, modelState.distance * zoomFactor));
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
        return;
      }
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(factor, ev.clientX, ev.clientY);
    }, { passive: false });

    zoomInBtn.addEventListener('click', () => {
      if (modelState) {
        modelState.distance = Math.max(0.2, modelState.distance * 0.88);
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
        return;
      }
      zoomByStep(1);
    });
    zoomOutBtn.addEventListener('click', () => {
      if (modelState) {
        modelState.distance = Math.min(200, modelState.distance * 1.12);
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
        return;
      }
      zoomByStep(-1);
    });
    zoomResetBtn.addEventListener('click', () => {
      if (modelState) {
        modelState.yaw = Math.PI * 0.5;
        modelState.pitch = -0.52;
        modelState.distance = 3.2;
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
        return;
      }
      zoom = 1;
      centerImage();
    });
    fitBtn.addEventListener('click', fitToView);
    window.addEventListener('resize', () => {
      if (modelState) {
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
      } else {
        centerImage();
      }
    });

    renderModeBtn.addEventListener('click', () => {
      if (modelRenderMode === 'both') modelRenderMode = 'fill';
      else if (modelRenderMode === 'fill') modelRenderMode = 'wire';
      else modelRenderMode = 'both';
      updateRenderModeUi();
      if (modelState) {
        const canvas = document.getElementById('canvas3d');
        renderModel(canvas, modelState);
      }
    });

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    window.addEventListener('message', async (event) => {
      const msg = event.data || {};
      debug('message: ' + (msg.type || 'unknown'));
      if (msg.type === 'loading') {
        setMeta(msg.fileName || 'Image', 'Loading...');
        setLoading(true, 'Loading image...');
        return;
      }
      if (msg.type === 'error') {
        setMeta(msg.fileName || 'Image', 'Failed to load');
        showWarnings([msg.message || 'Unknown error']);
        setLoading(false);
        return;
      }
      if (msg.type === 'image') {
        currentData = msg.decoded;
        if (currentData.kind === 'model') {
          setMeta(msg.fileName || 'Model', currentData.description + ' | geosets: ' + currentData.geosetsCount + ', tris: ' + currentData.trianglesCount);
        } else {
          setMeta(msg.fileName || 'Image', currentData.description + ' | ' + currentData.width + ' x ' + currentData.height);
        }
        try {
          await renderCurrent();
          if (!modelState) {
            zoom = 1;
            centerImage();
          } else {
            zoomLabel.textContent = '3D';
          }
          setLoading(false);
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          showWarnings(['Render error: ' + message]);
          setMeta(msg.fileName || 'Image', 'Render failed');
          setLoading(false);
          debug('render exception: ' + message);
        }
      }
    });

    window.addEventListener('error', (event) => {
      const message = event && event.message ? event.message : 'Unknown webview error';
      showWarnings(['Webview error: ' + message]);
      setLoading(false);
      debug('window error: ' + message);
    });

    debug('script boot');
    updateRenderModeUi();
    vscode.postMessage({ type: 'ready' });
    debug('ready posted');
  </script>
</body>
</html>`;
    }

}

function decodePreview(sourceBytes: Uint8Array, uri: vscode.Uri): DecodedBlpImage {
    const ext = path.extname(uri.fsPath || uri.path).toLowerCase();
    if (ext === '.dds') {
        return decodeDds(sourceBytes);
    }
    if (ext === '.mdx') {
        return decodeMdx(sourceBytes);
    }
    return decodeBlp(sourceBytes);
}

function decodeBlp(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeBlpInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading BLP: ${message}`);
    }
}

function decodeDds(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeDdsInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading DDS: ${message}`);
    }
}

function decodeDdsInternal(sourceBytes: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    const warn = (msg: string) => warnings.push(msg);
    const readU32 = (offset: number, label: string): number => {
        if (offset < 0 || offset + 4 > sourceBytes.length) {
            throw new Error(`${label} is truncated`);
        }
        const view = new DataView(sourceBytes.buffer, sourceBytes.byteOffset + offset, 4);
        return view.getUint32(0, true);
    };

    if (sourceBytes.length < 128) {
        throw new Error('DDS header is truncated');
    }
    const magic = readU32(0, 'magic');
    if (magic !== DDS_MAGIC) {
        throw new Error('invalid DDS magic');
    }

    const headerSize = readU32(4, 'headerSize');
    if (headerSize !== 124) {
        warn(`Unexpected DDS header size ${headerSize}, expected 124.`);
    }

    const height = readU32(12, 'height');
    const width = readU32(16, 'width');
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`invalid DDS dimensions ${width}x${height}`);
    }

    const mipMapCountRaw = readU32(28, 'mipMapCount');
    const mipMapCount = Math.max(1, mipMapCountRaw || 1);

    const pfSize = readU32(76, 'pixelFormatSize');
    const pfFlags = readU32(80, 'pixelFormatFlags');
    const fourCC = readU32(84, 'fourCC');
    const rgbBitCount = readU32(88, 'rgbBitCount');
    const rMask = readU32(92, 'rMask');
    const gMask = readU32(96, 'gMask');
    const bMask = readU32(100, 'bMask');
    const aMask = readU32(104, 'aMask');

    if (pfSize !== 32) {
        warn(`Unexpected DDS pixel format size ${pfSize}, expected 32.`);
    }

    const payload = sourceBytes.subarray(128);

    if ((pfFlags & DDPF_FOURCC) !== 0) {
        const fourCCText = fourCCToText(fourCC);
        let rgba: Uint8Array;
        if (fourCCText === 'DXT1') {
            rgba = decodeDxt1(payload, width, height, warn);
        } else if (fourCCText === 'DXT3') {
            rgba = decodeDxt3(payload, width, height, warn);
        } else if (fourCCText === 'DXT5') {
            rgba = decodeDxt5(payload, width, height, warn);
        } else {
            throw new Error(`unsupported DDS compression ${fourCCText}`);
        }
        return {
            kind: 'raster',
            mode: 'rgba',
            width,
            height,
            rgbaBase64: Buffer.from(rgba).toString('base64'),
            warnings,
            description: `DDS ${fourCCText} | mipmaps: ${mipMapCount}`,
        };
    }

    if ((pfFlags & DDPF_RGB) === 0 || rgbBitCount !== 32) {
        throw new Error(`unsupported DDS pixel format (flags=${pfFlags}, rgbBitCount=${rgbBitCount})`);
    }

    const pixelCount = safePixelCount(width, height);
    const expectedSize = pixelCount * 4;
    const pixelBytes = resizeChunk(payload, expectedSize, 'DDS RGBA payload', warn);
    const rgba = new Uint8Array(expectedSize);
    const alphaDefault = (pfFlags & DDPF_ALPHAPIXELS) !== 0 ? 0 : 255;

    for (let i = 0; i < pixelCount; i++) {
        const base = i * 4;
        const px = readU32FromArray(pixelBytes, base);
        rgba[base] = extractMaskedChannel(px, rMask, 255);
        rgba[base + 1] = extractMaskedChannel(px, gMask, 255);
        rgba[base + 2] = extractMaskedChannel(px, bMask, 255);
        rgba[base + 3] = extractMaskedChannel(px, aMask, alphaDefault);
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `DDS RGBA${(pfFlags & DDPF_ALPHAPIXELS) !== 0 ? '' : ' (opaque)'} | mipmaps: ${mipMapCount}`,
    };
}

function decodeMdx(sourceBytes: Uint8Array): DecodedMdxModel {
    try {
        return decodeMdxInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading MDX: ${message}`);
    }
}

function decodeMdxInternal(sourceBytes: Uint8Array): DecodedMdxModel {
    const warnings: string[] = [];
    const warn = (msg: string) => warnings.push(msg);
    const readU32 = (offset: number, label: string): number => {
        if (offset < 0 || offset + 4 > sourceBytes.length) {
            throw new Error(`${label} is truncated`);
        }
        const view = new DataView(sourceBytes.buffer, sourceBytes.byteOffset + offset, 4);
        return view.getUint32(0, true);
    };

    if (sourceBytes.length < 4 || readAscii4(sourceBytes, 0) !== 'MDLX') {
        throw new Error('invalid MDX magic');
    }

    let modelName = 'Unnamed Model';
    const sequences: MdxSequenceInfo[] = [];
    const allPositions: number[] = [];
    const allNormals: number[] = [];
    const allIndices: number[] = [];
    let geosetsCount = 0;
    let nodesCount = 0;

    let pos = 4;
    while (pos + 8 <= sourceBytes.length) {
        const token = readAscii4(sourceBytes, pos);
        const size = readU32(pos + 4, `${token}.size`);
        pos += 8;
        if (pos + size > sourceBytes.length) {
            warn(`Chunk ${token} size ${size} exceeds file bounds.`);
            break;
        }
        const chunk = sourceBytes.subarray(pos, pos + size);
        pos += size;

        if (token === 'MODL') {
            if (chunk.length >= 80) {
                modelName = readAsciiZ(chunk, 0, 80) || modelName;
            }
            continue;
        }

        if (token === 'SEQS') {
            const stride = 132;
            if (chunk.length % stride !== 0) {
                warn(`SEQS chunk size ${chunk.length} is not aligned to ${stride}.`);
            }
            for (let off = 0; off + stride <= chunk.length; off += stride) {
                const name = readAsciiZ(chunk, off, 80) || `Sequence ${sequences.length}`;
                const intervalStart = readU32FromArray(chunk, off + 80);
                const intervalEnd = readU32FromArray(chunk, off + 84);
                const flags = readU32FromArray(chunk, off + 92);
                sequences.push({
                    name,
                    intervalStart,
                    intervalEnd,
                    looping: (flags & 0x1) > 0,
                });
            }
            continue;
        }

        if (token === 'BONE') {
            nodesCount += countSizedEntries(chunk, 8, warn, 'BONE');
            continue;
        }

        if (token === 'HELP') {
            nodesCount += countSizedEntries(chunk, 0, warn, 'HELP');
            continue;
        }

        if (token !== 'GEOS') continue;

        let gpos = 0;
        while (gpos + 4 <= chunk.length) {
            const inclusiveSize = readU32FromArray(chunk, gpos);
            const geosetEnd = gpos + 4 + inclusiveSize;
            if (inclusiveSize <= 0 || geosetEnd > chunk.length) {
                warn(`GEOS geoset has invalid inclusiveSize ${inclusiveSize}.`);
                break;
            }

            geosetsCount++;
            const geoset = chunk.subarray(gpos + 4, geosetEnd);
            const parsed = parseMdxGeoset(geoset, warn);
            const baseVertex = allPositions.length / 3;
            for (const v of parsed.vertices) allPositions.push(v);
            for (const n of parsed.normals) allNormals.push(n);
            for (const idx of parsed.indices) allIndices.push(baseVertex + idx);

            gpos = geosetEnd;
        }
    }

    const positions = new Float32Array(allPositions);
    const normals = new Float32Array(allNormals);
    const indices = new Uint32Array(allIndices);
    return {
        kind: 'model',
        modelName,
        nodesCount,
        geosetsCount,
        trianglesCount: Math.floor(indices.length / 3),
        sequences,
        positionsBase64: Buffer.from(positions.buffer).toString('base64'),
        normalsBase64: Buffer.from(normals.buffer).toString('base64'),
        indicesBase64: Buffer.from(indices.buffer).toString('base64'),
        warnings,
        description: `MDX static geosets`,
    };
}

function parseMdxGeoset(geoset: Uint8Array, warn: (msg: string) => void): { vertices: number[]; normals: number[]; indices: number[] } {
    let pos = 0;

    const expectChunk = (token: string): { count: number; start: number } => {
        if (pos + 8 > geoset.length) throw new Error(`geoset missing ${token} header`);
        const got = readAscii4(geoset, pos);
        if (got !== token) throw new Error(`geoset expected ${token} but found ${got}`);
        const count = readU32FromArray(geoset, pos + 4);
        pos += 8;
        return { count, start: pos };
    };

    const vrtx = expectChunk('VRTX');
    const vertexCount = vrtx.count;
    const vertexBytes = vertexCount * 12;
    if (vrtx.start + vertexBytes > geoset.length) throw new Error('VRTX payload is truncated');
    const vertices: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
        const off = vrtx.start + i * 12;
        vertices.push(readF32FromArray(geoset, off), readF32FromArray(geoset, off + 4), readF32FromArray(geoset, off + 8));
    }
    pos += vertexBytes;

    const nrms = expectChunk('NRMS');
    const normalBytes = nrms.count * 12;
    if (nrms.start + normalBytes > geoset.length) throw new Error('NRMS payload is truncated');
    const normals: number[] = [];
    for (let i = 0; i < nrms.count; i++) {
        const off = nrms.start + i * 12;
        normals.push(readF32FromArray(geoset, off), readF32FromArray(geoset, off + 4), readF32FromArray(geoset, off + 8));
    }
    if (nrms.count !== vertexCount) {
        warn(`NRMS count ${nrms.count} differs from VRTX count ${vertexCount}.`);
        while (normals.length < vertices.length) normals.push(0, 0, 1);
        if (normals.length > vertices.length) normals.length = vertices.length;
    }
    pos += normalBytes;

    const ptyp = expectChunk('PTYP');
    const ptypBytes = ptyp.count * 4;
    if (ptyp.start + ptypBytes > geoset.length) throw new Error('PTYP payload is truncated');
    const faceTypes: number[] = [];
    for (let i = 0; i < ptyp.count; i++) {
        faceTypes.push(readU32FromArray(geoset, ptyp.start + i * 4));
    }
    pos += ptypBytes;

    const pcnt = expectChunk('PCNT');
    const pcntBytes = pcnt.count * 4;
    if (pcnt.start + pcntBytes > geoset.length) throw new Error('PCNT payload is truncated');
    const faceGroups: number[] = [];
    for (let i = 0; i < pcnt.count; i++) {
        faceGroups.push(readU32FromArray(geoset, pcnt.start + i * 4));
    }
    pos += pcntBytes;

    const pvtx = expectChunk('PVTX');
    const pvtxBytes = pvtx.count * 2;
    if (pvtx.start + pvtxBytes > geoset.length) throw new Error('PVTX payload is truncated');
    const faceIndices: number[] = [];
    for (let i = 0; i < pvtx.count; i++) {
        faceIndices.push(readU16FromArray(geoset, pvtx.start + i * 2));
    }
    pos += pvtxBytes;

    const gndx = expectChunk('GNDX');
    if (gndx.start + gndx.count > geoset.length) throw new Error('GNDX payload is truncated');
    pos += gndx.count;
    const mtgc = expectChunk('MTGC');
    const mtgcBytes = mtgc.count * 4;
    if (mtgc.start + mtgcBytes > geoset.length) throw new Error('MTGC payload is truncated');
    pos += mtgcBytes;
    const mats = expectChunk('MATS');
    const matsBytes = mats.count * 4;
    if (mats.start + matsBytes > geoset.length) throw new Error('MATS payload is truncated');
    pos += matsBytes;

    if (pos + 12 + 28 + 4 > geoset.length) {
        throw new Error('geoset fixed fields are truncated');
    }
    pos += 12; // materialId, selectionGroup, selectionFlags
    pos += 28; // extent

    const extentsCount = readU32FromArray(geoset, pos);
    pos += 4;
    const extentsBytes = extentsCount * 28;
    if (pos + extentsBytes > geoset.length) {
        throw new Error('geoset extents are truncated');
    }
    pos += extentsBytes;

    if (pos + 8 > geoset.length || readAscii4(geoset, pos) !== 'UVAS') {
        throw new Error('geoset missing UVAS');
    }
    const setCount = readU32FromArray(geoset, pos + 4);
    pos += 8;
    for (let i = 0; i < setCount; i++) {
        if (pos + 8 > geoset.length || readAscii4(geoset, pos) !== 'UVBS') {
            throw new Error('geoset missing UVBS');
        }
        const uvCount = readU32FromArray(geoset, pos + 4);
        pos += 8;
        const uvBytes = uvCount * 8;
        if (pos + uvBytes > geoset.length) throw new Error('UVBS payload is truncated');
        pos += uvBytes;
    }

    const triangles = buildTriangles(faceTypes, faceGroups, faceIndices, warn);
    return { vertices, normals, indices: triangles };
}

function buildTriangles(faceTypes: number[], faceGroups: number[], faceIndices: number[], warn: (msg: string) => void): number[] {
    const out: number[] = [];
    let cursor = 0;
    for (let i = 0; i < faceGroups.length; i++) {
        const groupCount = faceGroups[i];
        const type = faceTypes.length === 1 ? faceTypes[0] : (i < faceTypes.length ? faceTypes[i] : 4);
        const group = faceIndices.slice(cursor, cursor + groupCount);
        cursor += groupCount;
        if (type === 4) {
            for (let j = 0; j + 2 < group.length; j += 3) {
                out.push(group[j], group[j + 1], group[j + 2]);
            }
        } else if (type === 5) {
            for (let j = 0; j + 2 < group.length; j++) {
                if ((j & 1) === 0) out.push(group[j], group[j + 1], group[j + 2]);
                else out.push(group[j + 1], group[j], group[j + 2]);
            }
        } else if (type === 6) {
            for (let j = 1; j + 1 < group.length; j++) {
                out.push(group[0], group[j], group[j + 1]);
            }
        } else if (type === 7) {
            for (let j = 0; j + 3 < group.length; j += 4) {
                out.push(group[j], group[j + 1], group[j + 2]);
                out.push(group[j], group[j + 2], group[j + 3]);
            }
        } else if (type === 8) {
            for (let j = 0; j + 3 < group.length; j += 2) {
                out.push(group[j], group[j + 1], group[j + 2]);
                out.push(group[j + 1], group[j + 3], group[j + 2]);
            }
        } else {
            warn(`Unsupported face type ${type}, group ${i} skipped.`);
        }
    }
    return out;
}

function countSizedEntries(chunk: Uint8Array, trailingBytes: number, warn: (msg: string) => void, label: string): number {
    let count = 0;
    let pos = 0;
    while (pos + 4 <= chunk.length) {
        const size = readU32FromArray(chunk, pos);
        const step = 4 + size + trailingBytes;
        if (size <= 0 || pos + step > chunk.length) {
            warn(`${label} chunk has invalid entry size ${size}.`);
            break;
        }
        count++;
        pos += step;
    }
    return count;
}

function decodeBlpInternal(sourceBytes: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    const reader = new ByteReader(sourceBytes);
    const warn = (msg: string) => warnings.push(msg);

    const startToken = reader.readChar4();
    if (!startToken.startsWith('BLP')) {
        throw new Error(`Invalid BLP magic: ${startToken}`);
    }

    const version = startToken.charCodeAt(3) - '0'.charCodeAt(0);
    if (version < 0 || version > 2) {
        throw new Error(`Unsupported BLP version ${version}`);
    }
    if (version === 0) {
        throw new Error('BLP0 is not supported (external bXX mipmap files required)');
    }

    const typeRaw = reader.readI32LE('contentType');
    let type = typeRaw;
    if (type !== CONTENT_JPEG && type !== CONTENT_DIRECT) {
        warn(`Invalid content type ${typeRaw}; defaulting to JPEG.`);
        type = CONTENT_JPEG;
    }

    let hasMipmaps = false;
    let pixmapType = 1;
    let alphaBits = 0;
    if (version >= 2) {
        pixmapType = reader.readU8('pixmapType');
        if (pixmapType < 1 || pixmapType > 3) {
            warn(`Invalid pixmapType ${pixmapType} for BLP2, continuing.`);
        }
        alphaBits = normalizeAlphaBits(reader.readU8('alphaBits'), type, warn);
        reader.readU8('sampleType');
        hasMipmaps = reader.readU8('hasMipmaps') !== 0;
    } else {
        const rawAlphaBits = reader.readI32LE('alphaBits');
        let normalizedRawBits = rawAlphaBits;
        if (rawAlphaBits !== 0 && rawAlphaBits !== 1 && rawAlphaBits !== 4 && rawAlphaBits !== 8) {
            if ((rawAlphaBits & 0x8) > 0) {
                warn(`BLP1 alphaBits ${rawAlphaBits} looked flag-encoded; treating as 8-bit alpha.`);
                normalizedRawBits = 8;
            }
        }
        alphaBits = normalizeAlphaBits(normalizedRawBits, type, warn);
    }

    const width = validateDimension('width', reader.readI32LE('width'), version);
    const height = validateDimension('height', reader.readI32LE('height'), version);
    const hasAlpha = alphaBits > 0;

    if (version < 2) {
        reader.readI32LE('unknownField');
        hasMipmaps = reader.readI32LE('hasMipmaps') !== 0;
    }
    const mipmapCount = getMipmapLevelCount(width, height, hasMipmaps);

    const mipmapOffsets = new Array<number>(16).fill(0);
    const mipmapSizes = new Array<number>(16).fill(0);
    for (let i = 0; i < 16; i++) {
        mipmapOffsets[i] = reader.readI32LE(`mipmapOffset${i}`);
    }
    for (let i = 0; i < 16; i++) {
        mipmapSizes[i] = reader.readI32LE(`mipmapSize${i}`);
    }

    if (type === CONTENT_JPEG) {
        const headerSize = reader.readI32LE('jpegHeaderSize');
        if (headerSize < 0) {
            throw new Error(`Invalid JPEG header size: ${headerSize}`);
        }
        if (headerSize > 0x270) {
            warn(`JPEG header size ${headerSize} exceeds recommended max of 624 bytes.`);
        }
        const headerBytes = reader.readPadded(headerSize, 'jpegHeader');
        const mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
        if (mipmapData0.length === 0) {
            throw new Error('Missing or invalid JPEG mipmap level 0.');
        }
        const jpegBytes = new Uint8Array(headerBytes.length + mipmapData0.length);
        jpegBytes.set(headerBytes, 0);
        jpegBytes.set(mipmapData0, headerBytes.length);

        return {
            kind: 'raster',
            mode: 'jpeg',
            width,
            height,
            jpegBase64: Buffer.from(jpegBytes).toString('base64'),
            warnings,
            description: `BLP${version} JPEG | mipmaps: ${mipmapCount}`,
        };
    }

    if (version >= 2 && pixmapType === 3) {
        const pixelCount = safePixelCount(width, height);
        const expectedChunkSize = pixelCount * 4;
        let mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
        if (mipmapData0.length === 0) {
            throw new Error('Missing or invalid BGRA mipmap level 0.');
        }
        mipmapData0 = resizeChunk(mipmapData0, expectedChunkSize, 'BGRA mipmap 0 payload', warn);

        const rgba = new Uint8Array(expectedChunkSize);
        for (let src = 0, dst = 0; src < mipmapData0.length; src += 4, dst += 4) {
            const blue = mipmapData0[src];
            const green = mipmapData0[src + 1];
            const red = mipmapData0[src + 2];
            const alpha = mipmapData0[src + 3];
            rgba[dst] = red;
            rgba[dst + 1] = green;
            rgba[dst + 2] = blue;
            rgba[dst + 3] = alpha;
        }

        return {
            kind: 'raster',
            mode: 'rgba',
            width,
            height,
            rgbaBase64: Buffer.from(rgba).toString('base64'),
            warnings,
            description: `BLP${version} direct BGRA | mipmaps: ${mipmapCount}`,
        };
    }

    if (version >= 2 && pixmapType === 2) {
        throw new Error('BLP2 compressed sample (pixmapType=2) is not supported yet.');
    }

    const colorTableBytes = reader.readPadded(256 * 4, 'direct color table');

    const pixelCount = safePixelCount(width, height);
    const alphaSize = hasAlpha ? Math.floor((pixelCount * alphaBits + 7) / 8) : 0;
    const expectedChunkSize = pixelCount + alphaSize;

    let mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
    if (mipmapData0.length === 0) {
        throw new Error('Missing or invalid direct mipmap level 0.');
    }
    mipmapData0 = resizeChunk(mipmapData0, expectedChunkSize, 'direct mipmap 0 payload', warn);

    const indexList = mipmapData0.subarray(0, pixelCount);
    const alphaList = hasAlpha ? mipmapData0.subarray(pixelCount, pixelCount + alphaSize) : new Uint8Array(0);
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        const colorIndex = indexList[i] & 0xff;
        const paletteOffset = colorIndex * 4;
        rgba[i * 4] = colorTableBytes[paletteOffset + 2];
        rgba[i * 4 + 1] = colorTableBytes[paletteOffset + 1];
        rgba[i * 4 + 2] = colorTableBytes[paletteOffset];
        rgba[i * 4 + 3] = hasAlpha ? readAlpha(alphaList, i, alphaBits) : 0xff;
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `BLP${version} indexed direct | mipmaps: ${mipmapCount}`,
    };
}

function readAlpha(alphaData: Uint8Array, pixelIndex: number, alphaBits: number): number {
    if (alphaBits <= 0) return 0xff;
    if (alphaBits === 1) {
        const byteIndex = Math.floor(pixelIndex / 8);
        if (byteIndex >= alphaData.length) return 0xff;
        const bit = (alphaData[byteIndex] >> (pixelIndex % 8)) & 0x1;
        return bit === 0 ? 0x00 : 0xff;
    }
    if (alphaBits === 4) {
        const byteIndex = Math.floor(pixelIndex / 2);
        if (byteIndex >= alphaData.length) return 0xff;
        const nibble = pixelIndex % 2 === 0 ? alphaData[byteIndex] & 0x0f : (alphaData[byteIndex] >> 4) & 0x0f;
        return Math.floor((nibble * 0xff) / 0x0f);
    }
    if (pixelIndex >= alphaData.length) return 0xff;
    return alphaData[pixelIndex] & 0xff;
}

function normalizeAlphaBits(rawAlphaBits: number, contentType: number, warn: (msg: string) => void): number {
    if (contentType === CONTENT_JPEG) {
        if (rawAlphaBits === 0 || rawAlphaBits === 8) return rawAlphaBits;
        warn(`Invalid alphaBits ${rawAlphaBits} for JPEG; treating as 0.`);
        return 0;
    }
    if (rawAlphaBits === 0 || rawAlphaBits === 1 || rawAlphaBits === 4 || rawAlphaBits === 8) {
        return rawAlphaBits;
    }
    warn(`Invalid alphaBits ${rawAlphaBits} for direct content; treating as 0.`);
    return 0;
}

function getMipmapLevelCount(width: number, height: number, hasMipmaps: boolean): number {
    if (!hasMipmaps) return 1;
    let levels = 1;
    let maxDim = Math.max(width, height);
    while (maxDim > 1 && levels < 16) {
        maxDim = Math.max(1, Math.floor(maxDim / 2));
        levels++;
    }
    return levels;
}

function validateDimension(fieldName: string, value: number, version: number): number {
    if (value <= 0) {
        throw new Error(`${fieldName} ${value} is invalid`);
    }
    if (value > MAX_DIMENSION) {
        throw new Error(`${fieldName} ${value} exceeds max ${MAX_DIMENSION}`);
    }
    if (version === 0 && value > 512) {
        // BLP0 is unsupported anyway; this mirrors the Java diagnostic behavior.
    }
    return value;
}

function safePixelCount(width: number, height: number): number {
    const pixelCount = width * height;
    if (!Number.isFinite(pixelCount) || pixelCount <= 0 || pixelCount > 0x7fffffff) {
        throw new Error(`pixelCount ${pixelCount} is too large`);
    }
    return pixelCount;
}

function getMipmapChunk(
    reader: ByteReader,
    mipmapOffsets: number[],
    mipmapSizes: number[],
    mipmapLevel: number,
    warn: (msg: string) => void
): Uint8Array {
    if (mipmapLevel < 0 || mipmapLevel >= 16) return new Uint8Array(0);
    const offset = mipmapOffsets[mipmapLevel];
    const size = mipmapSizes[mipmapLevel];
    if (offset <= 0 || size <= 0) {
        warn(`Mipmap ${mipmapLevel} has invalid location offset=${offset} size=${size}.`);
        return new Uint8Array(0);
    }
    if (offset >= reader.size()) {
        warn(`Mipmap ${mipmapLevel} offset ${offset} is past EOF ${reader.size()}.`);
        return new Uint8Array(0);
    }
    const available = Math.min(size, reader.size() - offset);
    if (available < size) {
        warn(`Mipmap ${mipmapLevel} truncated at EOF (expected ${size}, got ${available}).`);
    }
    return reader.copy(offset, available);
}

function resizeChunk(
    src: Uint8Array,
    expectedSize: number,
    label: string,
    warn: (msg: string) => void
): Uint8Array {
    if (src.length === expectedSize) return src;
    if (src.length < expectedSize) {
        warn(`${label} smaller than expected (expected ${expectedSize}, got ${src.length}), padding with zeros.`);
    } else {
        warn(`${label} larger than expected (expected ${expectedSize}, got ${src.length}), truncating.`);
    }
    const out = new Uint8Array(expectedSize);
    out.set(src.subarray(0, Math.min(src.length, expectedSize)), 0);
    return out;
}

function makeNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 20; i++) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function fourCCToText(fourCC: number): string {
    const a = String.fromCharCode(fourCC & 0xff);
    const b = String.fromCharCode((fourCC >> 8) & 0xff);
    const c = String.fromCharCode((fourCC >> 16) & 0xff);
    const d = String.fromCharCode((fourCC >> 24) & 0xff);
    return `${a}${b}${c}${d}`;
}

function readAscii4(bytes: Uint8Array, offset: number): string {
    if (offset < 0 || offset + 4 > bytes.length) return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readAsciiZ(bytes: Uint8Array, offset: number, length: number): string {
    const end = Math.min(bytes.length, offset + length);
    const chars: number[] = [];
    for (let i = offset; i < end; i++) {
        const b = bytes[i];
        if (b === 0) break;
        chars.push(b);
    }
    return String.fromCharCode(...chars).trim();
}

function readU16FromArray(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readU32FromArray(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readF32FromArray(bytes: Uint8Array, offset: number): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return view.getFloat32(0, true);
}

function decode565(v: number): [number, number, number] {
    const r = (v >> 11) & 0x1f;
    const g = (v >> 5) & 0x3f;
    const b = v & 0x1f;
    return [
        Math.floor((r * 255 + 15) / 31),
        Math.floor((g * 255 + 31) / 63),
        Math.floor((b * 255 + 15) / 31),
    ];
}

function decodeDxtColors(c0: number, c1: number, transparentIfLte: boolean): Array<[number, number, number, number]> {
    const [r0, g0, b0] = decode565(c0);
    const [r1, g1, b1] = decode565(c1);
    const colors: Array<[number, number, number, number]> = [
        [r0, g0, b0, 255],
        [r1, g1, b1, 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
    ];

    if (transparentIfLte && c0 <= c1) {
        colors[2] = [Math.floor((r0 + r1) / 2), Math.floor((g0 + g1) / 2), Math.floor((b0 + b1) / 2), 255];
        colors[3] = [0, 0, 0, 0];
    } else {
        colors[2] = [
            Math.floor((2 * r0 + r1) / 3),
            Math.floor((2 * g0 + g1) / 3),
            Math.floor((2 * b0 + b1) / 3),
            255,
        ];
        colors[3] = [
            Math.floor((r0 + 2 * r1) / 3),
            Math.floor((g0 + 2 * g1) / 3),
            Math.floor((b0 + 2 * b1) / 3),
            255,
        ];
    }

    return colors;
}

function decodeDxt1(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 8;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT1 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const c0 = readU16FromArray(data, p);
            const c1 = readU16FromArray(data, p + 2);
            const idx = readU32FromArray(data, p + 4);
            p += 8;

            const colors = decodeDxtColors(c0, c1, true);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const code = (idx >> (2 * (py * 4 + px))) & 0x03;
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = c[3];
                }
            }
        }
    }
    return rgba;
}

function decodeDxt3(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 16;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT3 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const alphaLo = readU32FromArray(data, p);
            const alphaHi = readU32FromArray(data, p + 4);
            const c0 = readU16FromArray(data, p + 8);
            const c1 = readU16FromArray(data, p + 10);
            const idx = readU32FromArray(data, p + 12);
            p += 16;

            const colors = decodeDxtColors(c0, c1, false);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const pix = py * 4 + px;
                    const code = (idx >> (2 * pix)) & 0x03;
                    const alphaNybble = pix < 8
                        ? (alphaLo >> (4 * pix)) & 0x0f
                        : (alphaHi >> (4 * (pix - 8))) & 0x0f;
                    const alpha = Math.floor((alphaNybble * 255) / 15);
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = alpha;
                }
            }
        }
    }
    return rgba;
}

function decodeDxt5(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 16;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT5 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const a0 = data[p];
            const a1 = data[p + 1];
            const alphaIdx = data.subarray(p + 2, p + 8);
            const c0 = readU16FromArray(data, p + 8);
            const c1 = readU16FromArray(data, p + 10);
            const idx = readU32FromArray(data, p + 12);
            p += 16;

            const alphas = new Uint8Array(8);
            alphas[0] = a0;
            alphas[1] = a1;
            if (a0 > a1) {
                alphas[2] = Math.floor((6 * a0 + a1) / 7);
                alphas[3] = Math.floor((5 * a0 + 2 * a1) / 7);
                alphas[4] = Math.floor((4 * a0 + 3 * a1) / 7);
                alphas[5] = Math.floor((3 * a0 + 4 * a1) / 7);
                alphas[6] = Math.floor((2 * a0 + 5 * a1) / 7);
                alphas[7] = Math.floor((a0 + 6 * a1) / 7);
            } else {
                alphas[2] = Math.floor((4 * a0 + a1) / 5);
                alphas[3] = Math.floor((3 * a0 + 2 * a1) / 5);
                alphas[4] = Math.floor((2 * a0 + 3 * a1) / 5);
                alphas[5] = Math.floor((a0 + 4 * a1) / 5);
                alphas[6] = 0;
                alphas[7] = 255;
            }

            const alphaBitsLo = (alphaIdx[0] | (alphaIdx[1] << 8) | (alphaIdx[2] << 16)) >>> 0;
            const alphaBitsHi = (alphaIdx[3] | (alphaIdx[4] << 8) | (alphaIdx[5] << 16)) >>> 0;

            const colors = decodeDxtColors(c0, c1, false);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const pix = py * 4 + px;
                    const code = (idx >> (2 * pix)) & 0x03;
                    const bitPos = 3 * pix;
                    let aCode: number;
                    if (bitPos <= 21) {
                        aCode = (alphaBitsLo >> bitPos) & 0x07;
                    } else if (bitPos >= 24) {
                        aCode = (alphaBitsHi >> (bitPos - 24)) & 0x07;
                    } else {
                        const lowPart = (alphaBitsLo >> bitPos) & 0x03;
                        const highPart = (alphaBitsHi & 0x01) << 2;
                        aCode = lowPart | highPart;
                    }
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = alphas[aCode];
                }
            }
        }
    }
    return rgba;
}

function trailingZeroBits(mask: number): number {
    let shift = 0;
    let m = mask >>> 0;
    while (shift < 32 && (m & 1) === 0) {
        m >>>= 1;
        shift++;
    }
    return shift;
}

function bitCount(mask: number): number {
    let m = mask >>> 0;
    let count = 0;
    while (m !== 0) {
        count += m & 1;
        m >>>= 1;
    }
    return count;
}

function extractMaskedChannel(pixel: number, mask: number, fallback: number): number {
    if (mask === 0) return fallback;
    const shift = trailingZeroBits(mask);
    const bits = bitCount(mask);
    if (bits <= 0) return fallback;
    const value = (pixel & mask) >>> shift;
    const max = (1 << bits) - 1;
    if (max <= 0) return fallback;
    return Math.floor((value * 255 + Math.floor(max / 2)) / max);
}
