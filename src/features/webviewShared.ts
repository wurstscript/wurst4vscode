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
