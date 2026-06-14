'use strict';

/**
 * Shared HTML/CSS primitives for all wurst webview panels.
 *
 * Design goals
 * ─────────────
 * • Single source of truth for VS Code theme token mapping.
 * • Consistent typography, scrollbar, header, toolbar, button, and separator
 *   styles across every custom editor.
 * • All shared class names are prefixed `wv-` to avoid collision with
 *   viewer-specific styles.
 */

import { fuzzyMatch } from './preview/fuzzy';

// ---------------------------------------------------------------------------
// Base CSS — VS Code token mapping + shared structural components
// ---------------------------------------------------------------------------

export const WEBVIEW_BASE_CSS = `
:root {
  --bg:           var(--vscode-editor-background);
  --sidebar:      var(--vscode-sideBar-background, var(--vscode-editor-background));
  --fg:           var(--vscode-editor-foreground);
  --text:         var(--vscode-editor-foreground);
  --muted:        var(--vscode-descriptionForeground);
  --warn:         var(--vscode-editorWarning-foreground);
  --border:       var(--vscode-panel-border, var(--vscode-widget-border, #454545));
  --hover:        var(--vscode-list-hoverBackground);
  --active:       var(--vscode-list-activeSelectionBackground);
  --active-fg:    var(--vscode-list-activeSelectionForeground, var(--vscode-editor-foreground));
  --input-bg:     var(--vscode-input-background);
  --input-fg:     var(--vscode-input-foreground);
  --input-border: var(--vscode-input-border, transparent);
  --input-ph:     var(--vscode-input-placeholderForeground);
  --btn-bg:       var(--vscode-button-secondaryBackground, var(--vscode-toolbar-hoverBackground));
  --btn-fg:       var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
  --btn-hover:    var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-activeBackground));
  --icon-fg:      var(--vscode-icon-foreground, var(--vscode-editor-foreground));
  --font:         var(--vscode-font-family);
  --font-size:    var(--vscode-font-size, 13px);
  --mono:         var(--vscode-editor-font-family, monospace);
}

*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: var(--font-size);
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* ── header ────────────────────────────────────────────────────────────────── */
.wv-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
  flex-shrink: 0;
  min-width: 0;
}
.wv-header-icon { flex-shrink: 0; width: 20px; height: 20px; opacity: 0.85; }
.wv-header-text { flex: 1; min-width: 0; }
.wv-header-name {
  font-weight: 600;
  font-size: calc(var(--font-size) + 1px);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.wv-header-meta { color: var(--muted); font-size: 12px; margin-top: 1px; }

/* ── toolbar ───────────────────────────────────────────────────────────────── */
.wv-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar);
  flex-shrink: 0;
}
.wv-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-family: var(--font);
  font-size: 12px;
  color: var(--muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.4;
}
.wv-btn svg { width: 13px; height: 13px; flex-shrink: 0; fill: currentColor; opacity: 0.85; }
.wv-btn:hover:not(:disabled) { background: var(--btn-hover); border-color: var(--border); color: var(--fg); }
.wv-btn.active { background: var(--btn-bg); color: var(--btn-fg); }
.wv-btn:disabled { opacity: 0.4; cursor: default; }
.wv-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px; }
.wv-sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex-shrink: 0; }

/* ── scrollable content area ───────────────────────────────────────────────── */
.wv-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; }
.wv-scroll::-webkit-scrollbar { width: 8px; }
.wv-scroll::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4));
  border-radius: 4px;
}
.wv-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,.7));
}

/* ── spinner overlay ───────────────────────────────────────────────────────── */
.wv-loading-overlay {
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
.wv-loading-overlay.visible { opacity: 1; }
.wv-spinner {
  width: 22px; height: 22px;
  border: 2px solid color-mix(in srgb, var(--text) 20%, transparent);
  border-top-color: var(--text);
  border-radius: 50%;
  animation: wv-spin 0.8s linear infinite;
}
.wv-loading-text { font-size: 12px; color: var(--muted); text-align: center; }
@keyframes wv-spin { to { transform: rotate(360deg); } }

/* ── empty / error state ───────────────────────────────────────────────────── */
.wv-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; gap: 8px; color: var(--muted); font-size: 13px; padding: 24px; text-align: center;
}
.wv-state .err { color: var(--vscode-errorForeground, #f14c4c); font-size: 12px; max-width: 360px; }
`;

// ---------------------------------------------------------------------------
// Inline object-icon thumbnails (shared by doo / map-data / objmod webviews)
// ---------------------------------------------------------------------------

/**
 * CSS for inline `.object-icon` thumbnails. Pair with ICON_LAZYLOAD_SCRIPT.
 * Markup contract: `<span class="object-icon" data-key="…" data-icon="…"></span>`.
 * Size via the `--obj-icon-size` custom property (default 18px).
 */
export const ICON_INLINE_CSS = `
.object-icon {
  display: inline-block;
  width: var(--obj-icon-size, 18px);
  height: var(--obj-icon-size, 18px);
  vertical-align: middle;
  flex-shrink: 0;
  border-radius: 2px;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  overflow: hidden;
}
.object-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
.object-icon.missing { background: transparent; }
`;

/**
 * Self-contained client script that lazily resolves `.object-icon[data-icon]`
 * thumbnails through the host `requestPreviewIcon` helper.
 *
 * It acquires the VS Code API itself, so include it only on pages that have no
 * other script needing `acquireVsCodeApi`. Exposes `window.observeIcons(root)`
 * for dynamically added content and observes the whole document on load.
 *
 * Requires CSP: `script-src 'unsafe-inline'; img-src data:;` (see PREVIEW_CSP).
 * Uses string concatenation (no template literals) so it nests safely.
 */
export const ICON_LAZYLOAD_SCRIPT = `
<script>
(function () {
  var vscodeApi = acquireVsCodeApi();
  var pending = new Set(), loaded = new Map(), missing = new Set();
  var observer;
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function observeIcons(root) {
    if (!observer) {
      observer = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          observer.unobserve(entries[i].target);
          requestIcon(entries[i].target);
        }
      }, { root: null, rootMargin: '160px' });
    }
    var els = (root || document).querySelectorAll('.object-icon[data-icon]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], key = el.getAttribute('data-key') || '';
      if (loaded.has(key)) setLoaded(el, loaded.get(key));
      else if (missing.has(key)) setMissing(el);
      else observer.observe(el);
    }
  }
  function requestIcon(el) {
    var key = el.getAttribute('data-key') || '', iconPath = el.getAttribute('data-icon') || '';
    if (!key || !iconPath || pending.has(key) || loaded.has(key) || missing.has(key)) return;
    pending.add(key);
    vscodeApi.postMessage({ type: 'loadObjectIcon', key: key, iconPath: iconPath });
  }
  function setLoaded(el, uri) { el.classList.remove('missing'); el.innerHTML = '<img loading="lazy" src="' + esc(uri) + '" alt="">'; }
  function setMissing(el) { el.classList.add('missing'); el.innerHTML = ''; }
  function eachEl(key, fn) {
    var els = document.querySelectorAll('.object-icon');
    for (var i = 0; i < els.length; i++) if ((els[i].getAttribute('data-key') || '') === key) fn(els[i]);
  }
  function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function renderDataUrl(data) {
    try {
      var w = data.width, h = data.height;
      var full = document.createElement('canvas'); full.width = w; full.height = h;
      var fctx = full.getContext('2d');
      if (data.mode === 'rgba') {
        var rgba = b64ToBytes(data.rgbaBase64);
        fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
        return Promise.resolve(downscale(full));
      }
      return createImageBitmap(new Blob([b64ToBytes(data.jpegBase64)], { type: 'image/jpeg' })).then(function (bmp) {
        fctx.drawImage(bmp, 0, 0, w, h);
        var id = fctx.getImageData(0, 0, w, h), px = id.data;
        for (var i = 0; i < px.length; i += 4) { var r = px[i]; px[i] = px[i + 2]; px[i + 2] = r; }
        fctx.putImageData(id, 0, 0);
        return downscale(full);
      });
    } catch (e) { return Promise.resolve(null); }
  }
  function downscale(full) {
    var out = document.createElement('canvas'); out.width = 48; out.height = 48;
    var octx = out.getContext('2d'); octx.imageSmoothingQuality = 'high';
    octx.drawImage(full, 0, 0, 48, 48);
    return out.toDataURL('image/png');
  }
  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'objectIconLoaded') {
      pending.delete(msg.key);
      renderDataUrl(msg).then(function (url) {
        if (!url) { missing.add(msg.key); eachEl(msg.key, setMissing); return; }
        loaded.set(msg.key, url);
        eachEl(msg.key, function (el) { setLoaded(el, url); });
      });
    } else if (msg.type === 'objectIconMissing') {
      pending.delete(msg.key); missing.add(msg.key); eachEl(msg.key, setMissing);
    }
  });
  window.observeIcons = observeIcons;
  observeIcons(document);
})();
</script>`;

/** CSP for parsed-data webviews that use inline scripts + decoded data-URL icons. */
export const PREVIEW_ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;";

/**
 * Shared typo-tolerant search for every webview search box. Exposes `window.fuzzyMatch(query, text)`
 * — the SAME pure function unit-tested in `scripts/test-fuzzy.js`, shipped to the webview verbatim
 * via `.toString()` (single source of truth; see `preview/fuzzy.ts`).
 */
export const FUZZY_SEARCH_SCRIPT = `
<script>
window.fuzzyMatch = ${fuzzyMatch.toString()};
</script>`;

// ---------------------------------------------------------------------------
// HTML page builder
// ---------------------------------------------------------------------------

export interface BuildPageOptions {
    /** Full CSP meta-content string. */
    csp: string;
    /** Document title (already HTML-escaped). */
    title: string;
    /** Additional CSS placed after WEBVIEW_BASE_CSS (viewer-specific rules). */
    extraCss?: string;
    /** Full <body> inner HTML (everything between <body> tags). */
    body: string;
}

export function buildPage(opts: BuildPageOptions): string {
    const { csp, title, extraCss = '', body } = opts;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
${WEBVIEW_BASE_CSS}
${extraCss}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Reusable HTML snippets
// ---------------------------------------------------------------------------

/** A 1px vertical separator for use inside a .wv-toolbar. */
export function sep(): string {
    return `<div class="wv-sep"></div>`;
}

/**
 * A loading spinner overlay to be placed inside a `position:relative` container.
 * @param textId  id of the inner text element so callers can update it via JS.
 * @param initiallyVisible  whether the overlay starts visible (default true).
 */
export function spinnerOverlay(textId: string, initiallyVisible = true): string {
    const cls = initiallyVisible ? 'wv-loading-overlay visible' : 'wv-loading-overlay';
    return `<div class="${cls}">
  <div class="wv-spinner"></div>
  <div id="${textId}" class="wv-loading-text">Loading...</div>
</div>`;
}
