// @ts-nocheck
import { esc, renderWc3Colors } from '../objModWebviewUtils';
import { ui, vscodeApi } from './state';

export function sourcePill(mod) {
  if (!mod.source) return '';
  const cls = mod.missingSource ? 'source-pill missing' : 'source-pill';
  const title = mod.missingSource ? mod.source + ' not found in war3map.wts' : 'Resolved from ' + mod.source;
  return ' <span class="' + cls + '" title="' + esc(title) + '">' + esc(mod.source) + '</span>';
}

export function hasColorMarkup(v) {
  var s = String(v == null ? '' : v).toLowerCase();
  return s.indexOf('|c') !== -1 || s.indexOf('|n') !== -1 || s.indexOf('|r') !== -1 || s.indexOf(String.fromCharCode(10)) !== -1;
}

// Only genuine display-text fields get the color tools: tooltips/descriptions/tips, or any value
// that already uses WC3 color codes / newlines. Short codes (hotkeys), names, comma rawcode lists
// etc. get a plain input — no color bloat.
export function needsColorEditor(mod) {
  if (!mod.editable || mod.varType !== 'string') return false;
  const v = mod.editValue == null ? '' : String(mod.editValue);
  if (hasColorMarkup(v)) return true;
  const label = String(mod.label || '').toLowerCase();
  return label.indexOf('tooltip') !== -1 || label.indexOf('description') !== -1 || label.indexOf('tip') !== -1;
}

// WC3 palette (RRGGBB) for the quick swatches inside the color popup.
export var PRESET_COLORS = [
  ['ffcc00', 'Gold'], ['ffffff', 'White'], ['c3c3c3', 'Grey'], ['ff0303', 'Red'],
  ['1ce6b9', 'Teal'], ['54a4ff', 'Blue'], ['20c000', 'Green'], ['fe8a0e', 'Orange'],
  ['e55bb0', 'Pink'], ['959697', 'Dark Grey'], ['0042ff', 'Player Blue'], ['fffc01', 'Yellow'],
];

export function swatchesHtml() {
  return PRESET_COLORS.map(c =>
    '<button type="button" class="tt-sw" data-color="' + c[0] + '" style="background:#' + c[0] + '" title="' + esc(c[1]) + ' (#' + c[0] + ')"></button>'
  ).join('');
}

// Compact color bar: one swatch that reflects the current caret/selection color.
export function colorBarHtml(mi) {
  return '<div class="tt-bar" data-mi="' + mi + '">' +
    '<button type="button" class="tt-color-sq" title="Text color" aria-label="Text color"></button>' +
    '<div class="tt-pop" hidden>' +
      '<div class="tt-swatches">' + swatchesHtml() + '</div>' +
      '<label class="tt-pick"><input type="color" class="tt-color" value="#ffcc00" aria-label="Custom colour"><span>Custom...</span></label>' +
    '</div>' +
  '</div>';
}

// Distinct |cffRRGGBB colors already present in a WC3 raw string, in first-seen order — lets the
// toolbar offer "colors already used here" for one-click consistency (e.g. reapplying the same gold
// used on a keyword elsewhere in the same tooltip) without opening the full preset/custom picker.
export function extractUsedColors(text, max) {
  const re = /\|c[0-9a-f]{2}([0-9a-f]{6})/gi;
  const seen = [];
  let m;
  while ((m = re.exec(String(text == null ? '' : text)))) {
    const hex = m[1].toLowerCase();
    if (!seen.includes(hex)) seen.push(hex);
    if (seen.length >= (max || 4)) break;
  }
  return seen;
}

function usedColorsHtml(v) {
  const used = extractUsedColors(v, 4);
  if (!used.length) return '';
  return '<span class="tt-used-colors" title="Colors already used in this tooltip">' +
    used.map(hex =>
      '<button type="button" class="tt-sw tt-used-sw" data-color="' + hex + '" style="background:#' + hex + '" title="#' + hex + ' (used in this tooltip)"></button>'
    ).join('') +
  '</span>';
}

// Floating toolbar mounted beside a tooltip field while it's being edited in place (see
// enterTooltipEdit in detailsPanel.ts) — just the color swatch, a Raw/Rich toggle, and a Copy button.
// Toggling Raw swaps the in-place edit box itself (see enterRawView/enterRichView in detailsPanel.ts)
// rather than opening a second floating panel, so the toolbar never resizes/repositions itself and
// nothing else on the page shifts.
export function tooltipToolbarHtml(mi, v) {
  return '<div class="tt-float-toolbar-row">' +
      colorBarHtml(mi) +
      usedColorsHtml(v) +
      '<button type="button" class="tt-raw-toggle" data-mi="' + mi + '" aria-pressed="false" title="Toggle raw WC3 text view">Raw</button>' +
      '<button type="button" class="tt-copy-raw" data-mi="' + mi + '" title="Copy as raw WC3 text (copies the selection if any, otherwise the whole tooltip)">Copy</button>' +
    '</div>';
}

export function optionsHtml(options, selected) {
  return (options || []).map(opt =>
    '<option value="' + esc(opt.value) + '"' + (String(opt.value) === String(selected) ? ' selected' : '') + '>' +
      esc(opt.label + (opt.detail ? ' (' + opt.detail + ')' : '')) +
    '</option>'
  ).join('');
}

export function datalistOptionsHtml(options) {
  return (options || []).map(opt =>
    '<option value="' + esc(opt.value) + '" label="' + esc(opt.label) + '">' + esc(opt.detail || '') + '</option>'
  ).join('');
}

export function pickerEditorHtml(mod, mi, v) {
  if (!mod.options || !mod.options.length) return '';
  if (mod.editorKind === 'select') {
    const hasValue = mod.options.some(opt => String(opt.value) === String(v));
    return '<div class="value-editor single"><select class="edit-raw" data-mi="' + mi + '">' +
      (hasValue ? '' : '<option value="' + esc(v) + '" selected>' + esc(v || '(empty)') + '</option>') +
      optionsHtml(mod.options, v) +
      '</select></div>';
  }
  const listId = 'pick-' + mi;
  const browse = mod.assetType
    ? '<button type="button" class="browse-btn" data-browse="' + mi + '" title="Browse game assets visually">Browse…</button>'
    : '';
  return '<div class="value-editor single">' +
    '<div class="picker-row">' +
      '<input class="edit-raw" type="text" list="' + listId + '" data-mi="' + mi + '" spellcheck="false" aria-label="Choose from Warcraft III game data" value="' + esc(v) + '">' +
      browse +
    '</div>' +
    '<datalist id="' + listId + '">' + datalistOptionsHtml(mod.options) + '</datalist>' +
    '<div class="picker-note">Start typing' + (mod.assetType ? ', or click Browse for a visual picker.' : ' to choose from Warcraft III game data.') + '</div>' +
  '</div>';
}

export function assetMiniHtml(mod, mi) {
  if (!mod.assetPath) return '';
  const assetPath = String(mod.assetPath);
  if (mod.assetType === 'icon') {
    const iconKey = ui.selectedKey + ':field:' + mi + ':' + assetPath;
    return '<span class="asset-mini object-icon loading" data-key="' + esc(iconKey) + '" data-icon="' + esc(assetPath) + '" title="' + esc(assetPath) + '"><span class="icon-spinner"></span></span>';
  }
  // Model: clickable badge that renders an inline 3D preview square (no separate window).
  if (mod.assetType === 'model') {
    const modelKey = ui.selectedKey + ':model-field:' + mi + ':' + assetPath;
    return '<button type="button" class="asset-mini asset-open" data-model-preview="' + esc(assetPath) + '" title="' + esc('Preview model: ' + assetPath) + '">' +
      '<span class="asset-mini model-thumb" data-key="' + esc(modelKey) + '" data-model="' + esc(assetPath) + '"></span></button>';
  }
  if (mod.assetType === 'sound') {
    return '<button type="button" class="asset-mini asset-open" data-open-asset="' + esc(assetPath) + '" title="' + esc('Play sound: ' + assetPath) + '">AUD</button>';
  }
  // Pathing texture: open the image preview.
  return '<button type="button" class="asset-mini asset-open" data-open-asset="' + esc(assetPath) + '" title="' + esc('Open texture: ' + assetPath) + '">▶ PAT</button>';
}

// Every resolved rawcode (an ability/unit/item/etc. id referenced from another object's field, e.g. a
// unit's Abilities list) is clickable: data-jump selects it right away when it's in this same file's
// object list; data-xref asks the extension to find which sibling war3map.* file actually customizes
// it (see locateObjectAcrossSiblings in objModPreview.ts) and jump there — or, for a rawcode that's
// never been customized anywhere, to say so instead of silently doing nothing.
export function resolvedItemsHtml(mod) {
  const items = mod.resolvedItems || [];
  return '<span class="value-display rawcodes">' + items.map(item =>
    '<span class="resolved-chip linked" tabindex="0" role="button" title="' +
      esc(item.objectKey ? 'Open ' + item.label : 'Find ' + item.label + ' (' + item.value + ')') + '"' +
      (item.objectKey
        ? ' data-jump="' + esc(item.objectKey) + '"'
        : ' data-xref="' + esc(item.value) + '" data-xref-label="' + esc(item.label) + '"') + '>' +
      '<span>' + esc(item.label) + '</span><span class="raw">' + esc(item.value) + '</span>' +
    '</span>'
  ).join('') + '</span>';
}

export function assetName(value) {
  const file = String(value || '').split('\\').pop().split('/').pop();
  return file.replace(/\.(blp|dds|tga|png|jpe?g|mdx|mdl|mp3|wav|ogg|flac)$/i, '').replace(/^(btn|disbtn|pasbtn|att|upg)/i, '') || value;
}

export function firstAssetPath(value) {
  const first = String(value || '').split(',')[0].trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!first || first === '-' || /^WESTRING_/i.test(first)) return '';
  return first.replace(/\//g, '\\');
}

export function inferAssetType(mod, value) {
  if (mod.assetType) return mod.assetType;
  const v = firstAssetPath(value);
  const hay = String((mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.type || '') + ' ' + (mod.category || '')).toLowerCase();
  const ext = (v.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const textureExt = ext === 'blp' || ext === 'dds' || ext === 'tga' || ext === 'png' || ext === 'jpg' || ext === 'jpeg';
  const soundExt = ext === 'mp3' || ext === 'wav' || ext === 'ogg' || ext === 'flac';

  if (ext === 'mdx' || ext === 'mdl') return 'model';
  if (soundExt) return 'sound';
  if (textureExt) {
    if (hay.includes('pathing')) return 'pathing';
    if (hay.includes('icon') || hay.includes('button') || hay.includes('game interface') || hay.includes('art')) return 'icon';
    return '';
  }
  if (hay.includes('pathing map') || hay.includes('pathing texture')) return 'pathing';
  if (hay.includes('icon') || hay.includes('button') || hay.includes('game interface')) return 'icon';
  if (hay.includes('sound') || hay.includes('music') || hay.includes('audio')) return 'sound';
  if (hay.includes('model') || hay.includes('model file') || ['umdl', 'amdl', 'ifil', 'bfil', 'dfil'].includes(String(mod.fieldId || '').toLowerCase())) return 'model';
  return '';
}

export function normalizeAssetPathForType(value, type) {
  const first = firstAssetPath(value);
  if (!first) return '';
  if (type === 'model') return /\.(mdx|mdl)$/i.test(first) ? first : first + '.mdl';
  if (type === 'icon') return /\.(blp|dds|tga|png|jpe?g)$/i.test(first) ? first : '';
  if (type === 'sound') return /\.(mp3|wav|ogg|flac)$/i.test(first) ? first : '';
  if (type === 'pathing') return /\.(blp|dds|tga)$/i.test(first) ? first : '';
  return '';
}

export function refreshDecoratedValue(mod) {
  const v = mod.editValue == null ? (mod.currentValue == null ? '' : String(mod.currentValue)) : String(mod.editValue);
  const inferredAssetType = inferAssetType(mod, v);
  if (inferredAssetType) {
    const assetPath = normalizeAssetPathForType(v, inferredAssetType);
    if (assetPath) {
      mod.displayKind = 'asset';
      mod.assetType = inferredAssetType;
      mod.assetPath = assetPath;
      if (!mod.editorKind || mod.editorKind === 'select') mod.editorKind = 'datalist';
    }
  }
  if (mod.displayKind === 'asset') {
    mod.assetPath = normalizeAssetPathForType(v, mod.assetType) || v || '';
    if (!v) {
      mod.displayValue = '';
      mod.displayDetail = '';
      return;
    }
  }
  const match = (mod.options || []).find(opt => String(opt.value) === v);
  if (match) {
    mod.displayValue = match.label;
    mod.displayDetail = match.detail || v;
  } else if (mod.displayKind === 'asset' && v) {
    mod.displayValue = assetName(v);
    mod.displayDetail = v;
  }
}

export function setModValue(mod, value) {
  mod.editValue = value;
  mod.currentValue = value;
  refreshDecoratedValue(mod);
}

export function decoratedValueHtml(mod, mi, raw) {
  refreshDecoratedValue(mod);
  if (mod.displayKind === 'rawcodes' && mod.resolvedItems && mod.resolvedItems.length) return resolvedItemsHtml(mod);
  // Asset fields (icon/model/sound/pathing) always get their mini preview badge, even when there's
  // no friendlier label to show alongside the raw path — the badge itself is the point (icon swatch,
  // cached model thumbnail). Only skip the badge for genuinely plain fields with nothing to add.
  const isAsset = mod.displayKind === 'asset' && !!mod.assetPath;
  const hasFriendlyLabel = !!mod.displayValue && String(mod.displayValue) !== String(raw);
  if (!isAsset && !hasFriendlyLabel) {
    return raw === '' ? '<span class="tt-empty">(empty)</span>' : esc(raw);
  }
  const mainText = hasFriendlyLabel ? mod.displayValue : raw;
  return '<span class="value-display ' + esc(mod.displayKind || '') + '">' +
    assetMiniHtml(mod, mi) +
    (mainText === ''
      ? '<span class="tt-empty">(empty)</span>'
      : '<span class="value-main" title="' + esc(mainText) + '">' + esc(mainText) + '</span>') +
    (hasFriendlyLabel ? '<span class="value-raw" title="' + esc(mod.displayDetail || raw) + '">' + esc(mod.displayDetail || raw) + '</span>' : '') +
  '</span>';
}

// Clamp/round a typed number field value to something valid for its varType: whole numbers for
// int, and non-negative for unreal (WC3's "unsigned real"). Invalid/empty text collapses to '0' for
// int so a stray edit can't leave a non-numeric string in an integer game field.
export function normalizeNumberValue(varType, raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return s;
  if (varType === 'int') {
    const n = Math.round(Number(s));
    return Number.isFinite(n) ? String(n) : '0';
  }
  let n = Number(s);
  if (!Number.isFinite(n)) n = 0;
  if (varType === 'unreal' && n < 0) n = 0;
  return String(n);
}

function numberStepFor(varType) {
  return varType === 'int' ? 1 : 0.05;
}

// NOTE: the value input stays type="text" (not type="number") so the '.' decimal is locale-independent —
// these are raw float/int game values, not locale-formatted numbers (German shows 1,5 for a number
// input, which corrupts the value). The +/- steppers give integer-safe increments without that risk;
// inputmode hints a numeric keypad on touch.
function numberEditorHtml(mod, mi, v) {
  const step = numberStepFor(mod.varType);
  return '<div class="value-editor single num-editor">' +
    '<input class="edit-raw num-input" type="text" inputmode="' + (mod.varType === 'int' ? 'numeric' : 'decimal') + '" data-mi="' + mi + '" data-num-type="' + mod.varType + '" data-num-step="' + step + '" spellcheck="false" value="' + esc(v) + '">' +
    '<span class="num-steppers">' +
      '<button type="button" class="num-step" data-mi="' + mi + '" data-dir="1" tabindex="-1" aria-label="Increase value">▲</button>' +
      '<button type="button" class="num-step" data-mi="' + mi + '" data-dir="-1" tabindex="-1" aria-label="Decrease value">▼</button>' +
    '</span>' +
  '</div>';
}

// Editor shown on click for non-tooltip fields (tooltip/color fields edit in place — see
// enterTooltipEdit in detailsPanel.ts — and never reach this function). Text fields get a plain
// input; number fields get a stepper-enhanced input; picker fields get a datalist/select.
export function editorHtml(mod, mi) {
  refreshDecoratedValue(mod);
  const v = mod.editValue == null ? '' : String(mod.editValue);
  const picker = pickerEditorHtml(mod, mi, v);
  if (picker) return picker;
  const numType = mod.varType === 'int' || mod.varType === 'real' || mod.varType === 'unreal';
  if (numType) return numberEditorHtml(mod, mi, v);
  return '<div class="value-editor single"><input class="edit-raw" type="text" data-mi="' + mi + '" spellcheck="false" value="' + esc(v) + '"></div>';
}

// Compact, click-to-edit view shown by default for every editable cell (keeps the 700-row table light).
// Tooltip/color fields always render as the dark WC3 tooltip box (.tt-collapsed), whether or not they
// currently contain color codes, so the box a user clicks on is the exact same box they edit in place —
// no swap to a differently-shaped container.
export function collapsedView(mod, mi) {
  const dv = mod.editValue == null ? (mod.currentValue == null ? '' : String(mod.currentValue)) : String(mod.editValue);
  if (needsColorEditor(mod)) {
    const body = dv ? renderWc3Colors(dv) : '<span class="tt-empty">(empty)</span>';
    return '<div class="tt-collapsed" data-mi="' + mi + '" tabindex="0" role="button" title="Click or press Enter to edit">' +
      '<div class="tt-collapsed-body" data-mi="' + mi + '">' + body + '</div>' + (mod.source ? sourcePill(mod) : '') + '<span class="tt-edit-hint">✎</span></div>';
  }
  const badge = mod.overridden ? '<span class="override-badge" title="This field overrides the base value">modified</span>' : '';
  const disp = decoratedValueHtml(mod, mi, dv);
  return '<span class="cell-edit" data-mi="' + mi + '" tabindex="0" role="button" title="Click or press Enter to edit">' +
    '<span class="cell-edit-val">' + disp + '</span>' + badge + (mod.source ? sourcePill(mod) : '') +
    '<span class="tt-edit-hint">✎</span></span>';
}

export function valueCell(mod, mi) {
  if (mod.editable) return collapsedView(mod, mi);
  // Read-only (non-editable, e.g. TRIGSTR with missing wts): still render WC3 color codes when present.
  let extra = (mod.overridden ? '<span class="override-badge">modified</span>' : '') + sourcePill(mod);
  if (mod.missingWts) extra += ' <span class="readonly-trigstr">(externalized – war3map.wts missing)</span>';
  const ro = mod.currentValue == null ? '' : String(mod.currentValue);
  if (hasColorMarkup(ro)) {
    return '<div class="tt-preview tt-readonly">' + renderWc3Colors(ro) + '</div>' + extra;
  }
  return decoratedValueHtml(mod, mi, ro) + extra;
}

export function postEdit(mod) {
  vscodeApi.postMessage({
    type: 'editField',
    key: ui.selectedKey,
    fieldId: mod.fieldId,
    level: mod.level == null ? null : mod.level,
    dataPt: mod.dataPt == null ? null : mod.dataPt,
    varType: mod.varType,
    value: mod.editValue == null ? '' : String(mod.editValue),
  });
}

export function commitActiveEditor() {
  const el = document.activeElement;
  if (!el || !el.classList || (!el.classList.contains('edit-raw') && !el.classList.contains('edit-rich'))) return false;
  if (typeof el._commitNow === 'function') {
    el._commitNow();
    return true;
  }
  return false;
}
