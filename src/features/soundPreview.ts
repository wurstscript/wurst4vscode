'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { buildPage } from './webviewShared';
import { escapeHtml } from './webviewUtils';

const SOUND_VIEW_TYPE = 'wurst.soundPreview';
const SOUND_EXTS = new Set(['.mp3', '.wav', '.ogg', '.flac']);

interface SoundDocument extends vscode.CustomDocument {
    uri: vscode.Uri;
    dispose(): void;
}

export function registerSoundPreview(_context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
        SOUND_VIEW_TYPE,
        new SoundPreviewProvider(),
        { supportsMultipleEditorsPerDocument: true },
    );
}

export function isSoundAssetPath(fsPathOrAssetPath: string): boolean {
    return SOUND_EXTS.has(path.extname(fsPathOrAssetPath).toLowerCase());
}

// Singleton side panel reused for "Play sound" code-lens playtesting: opens
// beside the code, auto-plays, and is reused so we don't spawn a tab per sound.
let soundPlayerPanel: vscode.WebviewPanel | undefined;

export async function playSoundInline(uri: vscode.Uri): Promise<void> {
    const dir = path.dirname(uri.fsPath);
    const title = path.basename(uri.fsPath || uri.path);
    const options: vscode.WebviewOptions = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(dir)],
    };

    if (!soundPlayerPanel) {
        soundPlayerPanel = vscode.window.createWebviewPanel(
            SOUND_VIEW_TYPE,
            title,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { ...options, retainContextWhenHidden: true },
        );
        soundPlayerPanel.onDidDispose(() => { soundPlayerPanel = undefined; });
    } else {
        soundPlayerPanel.title = title;
        // Different sounds may live in different directories.
        soundPlayerPanel.webview.options = options;
        soundPlayerPanel.reveal(soundPlayerPanel.viewColumn ?? vscode.ViewColumn.Beside, true);
    }

    soundPlayerPanel.webview.html = await buildSoundHtml(uri, soundPlayerPanel.webview, true);
}

class SoundPreviewProvider implements vscode.CustomReadonlyEditorProvider<SoundDocument> {
    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<SoundDocument> {
        return { uri, dispose() {} };
    }

    async resolveCustomEditor(
        document: SoundDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const dir = path.dirname(document.uri.fsPath);
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(dir)],
        };

        webviewPanel.webview.html = await buildSoundHtml(document.uri, webviewPanel.webview);
    }
}

async function buildSoundHtml(uri: vscode.Uri, webview: vscode.Webview, autoplay = false): Promise<string> {
    const name = path.basename(uri.fsPath || uri.path);
    const ext = path.extname(name).slice(1).toUpperCase() || 'Audio';
    let size = '';
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        size = formatBytes(stat.size);
    } catch {}

    const source = webview.asWebviewUri(uri).toString();
    const type = mimeTypeForExt(path.extname(name).toLowerCase());
    const meta = [ext, size].filter(Boolean).join(' - ');
    const title = escapeHtml(name);

    return buildPage({
        csp: `default-src 'none'; media-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';`,
        title,
        extraCss: `
.sound-shell { height: 100%; display: grid; grid-template-rows: auto 1fr; min-height: 0; }
.sound-main { display: grid; place-items: center; min-height: 0; padding: 24px; }
.player {
  width: min(560px, 100%);
  display: grid;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--sidebar) 82%, transparent);
}
.sound-icon {
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  justify-self: center;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--input-bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 700;
}
.play-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
audio { width: 100%; min-width: 0; }
.status { color: var(--muted); font-size: 12px; min-height: 16px; overflow-wrap: anywhere; }
`,
        body: `<div class="sound-shell">
  <div class="wv-header">
    <div class="wv-header-text">
      <div class="wv-header-name">${title}</div>
      <div class="wv-header-meta">${escapeHtml(meta || 'Audio')}</div>
    </div>
  </div>
  <main class="sound-main">
    <section class="player" aria-label="Sound preview">
      <div class="sound-icon">${escapeHtml(ext || 'AUD')}</div>
      <div class="play-row">
        <audio id="audio" controls preload="metadata"${autoplay ? ' autoplay' : ''}>
          <source src="${escapeHtml(source)}"${type ? ` type="${type}"` : ''}>
        </audio>
      </div>
      <div id="status" class="status">Ready</div>
    </section>
  </main>
</div>
<script>
(function () {
  var audio = document.getElementById('audio');
  var status = document.getElementById('status');
  function setStatus(text) { if (status) status.textContent = text || ''; }
  if (!audio) return;
  audio.addEventListener('play', function () { setStatus('Playing'); });
  audio.addEventListener('pause', function () { setStatus(audio.ended ? 'Ended' : 'Paused'); });
  audio.addEventListener('loadedmetadata', function () {
    if (Number.isFinite(audio.duration)) setStatus('Duration ' + formatDuration(audio.duration));
  });
  audio.addEventListener('error', function () { setStatus('Could not play this audio file. Try opening it externally if the codec is unsupported.'); });
  if (${autoplay ? 'true' : 'false'}) {
    var ap = audio.play();
    if (ap && ap.catch) ap.catch(function () { setStatus('Ready (autoplay blocked - press Play)'); });
  }
  function formatDuration(seconds) {
    var total = Math.max(0, Math.round(seconds));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + String(s).padStart(2, '0');
  }
})();
</script>`,
    });
}

function mimeTypeForExt(ext: string): string {
    switch (ext) {
        case '.mp3': return 'audio/mpeg';
        case '.wav': return 'audio/wav';
        case '.ogg': return 'audio/ogg';
        case '.flac': return 'audio/flac';
        default: return '';
    }
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
