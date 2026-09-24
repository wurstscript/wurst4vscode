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

import BASE_CSS from '../webview/base.css';
import DATA_PAGE_CSS from '../webview/dataPage.css';

// ---------------------------------------------------------------------------
// Base CSS — VS Code token mapping + shared structural components
// ---------------------------------------------------------------------------

export const WEBVIEW_BASE_CSS = BASE_CSS;

/** Opt-in table/banner/empty-state styles for read-only data pages (see dataPage.css). */
export { DATA_PAGE_CSS };

// ---------------------------------------------------------------------------
// Inline object-icon thumbnails (doo preview, code asset picker)
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
 * Requires CSP: `script-src 'unsafe-inline'; img-src data:;` (see PREVIEW_ICON_CSP).
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
      if (data.mode !== 'rgba') return Promise.resolve(null);
      var rgba = b64ToBytes(data.rgbaBase64);
      fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
      return Promise.resolve(downscale(full));
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

/** CSP for static pages: inline styles only, no scripts or resources. */
export const STATIC_CSP = "default-src 'none'; style-src 'unsafe-inline';";

/** CSP for pages with inline scripts but no external resources. */
export const INLINE_SCRIPT_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';";

/** CSP for parsed-data webviews that use inline scripts + decoded data-URL icons. */
export const PREVIEW_ICON_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;";

/**
 * JSON for embedding inside an inline `<script>` (e.g. `window.__X_INITIAL__ = ${scriptSafeJson(data)}`).
 * Escapes the characters that could close the script element or break a JS string literal.
 */
const SCRIPT_UNSAFE_CHARS = /[<>&\u2028\u2029]/g;

export function scriptSafeJson(value: unknown): string {
    return JSON.stringify(value).replace(SCRIPT_UNSAFE_CHARS, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

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
    /** Additional markup placed in <head> after the inline viewer styles (for local webview assets). */
    extraHead?: string;
    /** Full <body> inner HTML (everything between <body> tags). */
    body: string;
}

export function buildPage(opts: BuildPageOptions): string {
    const { csp, title, extraCss = '', extraHead = '', body } = opts;
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
${extraHead}
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
