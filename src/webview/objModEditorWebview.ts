// @ts-nocheck
import { fuzzyMatch } from '../features/preview/fuzzy';
import { createIconLoader } from './objModIconLoader';
import { base64ToBytes, esc, renderWc3Colors } from './objModWebviewUtils';
import { effect, signal } from './signals';

declare const acquireVsCodeApi: any;

const initial = window.__OBJMOD_INITIAL__ || { objects: [], selectedKey: "", extended: false };
const objects = initial.objects || [];
let selectedKey = initial.selectedKey || "";
let query = '';
let fieldQuery = '';
const vscodeApi = acquireVsCodeApi();
let showTechnical = !!((vscodeApi.getState() || {}).showTechnical);
const detailCache = new Map();
const pendingDetails = new Set();
const collapsedGroups = new Set();
const collapsedRaces = new Set();
let modelThumbObserver;
const pendingModelThumbs = new Set();
const loadedModelThumbs = new Map();
const missingModelThumbs = new Set();
const missingModelThumbReasons = new Map();
const modelThumbRequestQueue = [];
const modelThumbHostInflight = new Set();
const modelThumbQueue = [];
let modelThumbJob = null;
let modelThumbAwaitingDecisionKey = '';
let modelThumbSeq = 0;
let modelThumbInited = false;
let modelThumbTextureTimer = 0;
let modelThumbIdleTimer = 0;
let modelThumbCancelGeneration = 0;
let e2eForcedNarrowLayout = false;
const modelThumbEvents = [];
const MODEL_THUMB_HOST_CONCURRENCY = 1;
const MODEL_THUMB_ZERO_ALPHA_RETRIES = 0;
const MODEL_THUMB_MIN_VISIBLE_PIXELS = 4;

const tree = document.getElementById('tree');
const details = document.getElementById('details');
const search = document.getElementById('search');
const iconLoader = createIconLoader(vscodeApi);

function sourcePill(mod) {
  if (!mod.source) return '';
  const cls = mod.missingSource ? 'source-pill missing' : 'source-pill';
  const title = mod.missingSource ? mod.source + ' not found in war3map.wts' : 'Resolved from ' + mod.source;
  return ' <span class="' + cls + '" title="' + esc(title) + '">' + esc(mod.source) + '</span>';
}

function hasColorMarkup(v) {
  var s = String(v == null ? '' : v).toLowerCase();
  return s.indexOf('|c') !== -1 || s.indexOf('|n') !== -1 || s.indexOf('|r') !== -1 || s.indexOf(String.fromCharCode(10)) !== -1;
}

// Only genuine display-text fields get the color tools: tooltips/descriptions/tips, or any value
// that already uses WC3 color codes / newlines. Short codes (hotkeys), names, comma rawcode lists
// etc. get a plain input — no color bloat.
function needsColorEditor(mod) {
  if (!mod.editable || mod.varType !== 'string') return false;
  const v = mod.editValue == null ? '' : String(mod.editValue);
  if (hasColorMarkup(v)) return true;
  const label = String(mod.label || '').toLowerCase();
  return label.indexOf('tooltip') !== -1 || label.indexOf('description') !== -1 || label.indexOf('tip') !== -1;
}

// WC3 palette (RRGGBB) for the quick swatches inside the color popup.
var PRESET_COLORS = [
  ['ffcc00', 'Gold'], ['ffffff', 'White'], ['c3c3c3', 'Grey'], ['ff0303', 'Red'],
  ['1ce6b9', 'Teal'], ['54a4ff', 'Blue'], ['20c000', 'Green'], ['fe8a0e', 'Orange'],
  ['e55bb0', 'Pink'], ['959697', 'Dark Grey'], ['0042ff', 'Player Blue'], ['fffc01', 'Yellow'],
];

function swatchesHtml() {
  return PRESET_COLORS.map(c =>
    '<button type="button" class="tt-sw" data-color="' + c[0] + '" style="background:#' + c[0] + '" title="' + esc(c[1]) + ' (#' + c[0] + ')"></button>'
  ).join('');
}

// Compact color bar: one small square that opens a popup (swatches + custom picker), plus |n / |r.
function colorBarHtml(mi) {
  return '<div class="tt-bar" data-mi="' + mi + '">' +
    '<button type="button" class="tt-color-sq" title="Color selected text"></button>' +
    '<button type="button" class="tt-btn-sm" data-act="newline" title="Line break (|n)">|n</button>' +
    '<button type="button" class="tt-btn-sm" data-act="reset" title="End color (|r)">|r</button>' +
    '<div class="tt-pop" hidden>' +
      '<div class="tt-swatches">' + swatchesHtml() + '</div>' +
      '<label class="tt-pick"><input type="color" class="tt-color" value="#ffcc00" aria-label="Custom colour"><span>Custom...</span></label>' +
    '</div>' +
  '</div>';
}

function colorEditorHtml(mod, mi) {
  const v = mod.editValue == null ? '' : String(mod.editValue);
  return '<div class="value-editor">' +
    '<div class="tt-edit">' + colorBarHtml(mi) +
      '<textarea class="edit-raw" data-mi="' + mi + '" rows="3" spellcheck="false">' + esc(v) + '</textarea>' +
    '</div>' +
    '<div><div class="tt-preview-label">preview' + (mod.source ? ' - ' + esc(mod.source) : '') + '</div>' +
      '<div class="tt-preview" data-preview-for="' + mi + '">' + renderWc3Colors(v) + '</div></div>' +
    '</div>';
}

function optionsHtml(options, selected) {
  return (options || []).map(opt =>
    '<option value="' + esc(opt.value) + '"' + (String(opt.value) === String(selected) ? ' selected' : '') + '>' +
      esc(opt.label + (opt.detail ? ' (' + opt.detail + ')' : '')) +
    '</option>'
  ).join('');
}

function datalistOptionsHtml(options) {
  return (options || []).map(opt =>
    '<option value="' + esc(opt.value) + '" label="' + esc(opt.label) + '">' + esc(opt.detail || '') + '</option>'
  ).join('');
}

function pickerEditorHtml(mod, mi, v) {
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

function assetMiniHtml(mod, mi) {
  if (!mod.assetPath) return '';
  const assetPath = String(mod.assetPath);
  if (mod.assetType === 'icon') {
    const iconKey = selectedKey + ':field:' + mi + ':' + assetPath;
    return '<span class="asset-mini object-icon loading" data-key="' + esc(iconKey) + '" data-icon="' + esc(assetPath) + '" title="' + esc(assetPath) + '"><span class="icon-spinner"></span></span>';
  }
  // Model: clickable badge that renders an inline 3D preview square (no separate window).
  if (mod.assetType === 'model') {
    const modelKey = selectedKey + ':model-field:' + mi + ':' + assetPath;
    return '<button type="button" class="asset-mini asset-open" data-model-preview="' + esc(assetPath) + '" title="' + esc('Preview model: ' + assetPath) + '">' +
      '<span class="asset-mini model-thumb" data-key="' + esc(modelKey) + '" data-model="' + esc(assetPath) + '"></span></button>';
  }
  // Pathing texture: open the image preview.
  return '<button type="button" class="asset-mini asset-open" data-open-asset="' + esc(assetPath) + '" title="' + esc('Open texture: ' + assetPath) + '">▶ PAT</button>';
}

function resolvedItemsHtml(mod) {
  const items = mod.resolvedItems || [];
  return '<span class="value-display rawcodes">' + items.map(item =>
    '<span class="resolved-chip' + (item.objectKey ? ' linked' : '') + '" title="' + esc(item.objectKey ? 'Open ' + item.label : (item.detail || item.value)) + '"' +
      (item.objectKey ? ' data-jump="' + esc(item.objectKey) + '"' : '') + '>' +
      '<span>' + esc(item.label) + '</span><span class="raw">' + esc(item.value) + '</span>' +
    '</span>'
  ).join('') + '</span>';
}

function assetName(value) {
  const file = String(value || '').split('\\\\').pop().split('/').pop();
  return file.replace(/\\.(blp|dds|tga|png|jpe?g|mdx|mdl)$/i, '').replace(/^(btn|disbtn|pasbtn|att|upg)/i, '') || value;
}

function firstAssetPath(value) {
  const first = String(value || '').split(',')[0].trim()
    .replace(/^"(.*)"$/, '$1')
    .replace(/^'(.*)'$/, '$1');
  if (!first || first === '-' || /^WESTRING_/i.test(first)) return '';
  return first.replace(/\//g, '\\');
}

function inferAssetType(mod, value) {
  if (mod.assetType) return mod.assetType;
  const v = firstAssetPath(value);
  const hay = String((mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.type || '') + ' ' + (mod.category || '')).toLowerCase();
  const ext = (v.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const textureExt = ext === 'blp' || ext === 'dds' || ext === 'tga' || ext === 'png' || ext === 'jpg' || ext === 'jpeg';

  if (ext === 'mdx' || ext === 'mdl') return 'model';
  if (textureExt) {
    if (hay.includes('pathing')) return 'pathing';
    if (hay.includes('icon') || hay.includes('button') || hay.includes('game interface') || hay.includes('art')) return 'icon';
    return '';
  }
  if (hay.includes('pathing map') || hay.includes('pathing texture')) return 'pathing';
  if (hay.includes('icon') || hay.includes('button') || hay.includes('game interface')) return 'icon';
  if (hay.includes('model') || hay.includes('model file') || ['umdl', 'amdl', 'ifil', 'bfil', 'dfil'].includes(String(mod.fieldId || '').toLowerCase())) return 'model';
  return '';
}

function normalizeAssetPathForType(value, type) {
  const first = firstAssetPath(value);
  if (!first) return '';
  if (type === 'model') return /\.(mdx|mdl)$/i.test(first) ? first : first + '.mdl';
  if (type === 'icon') return /\.(blp|dds|tga|png|jpe?g)$/i.test(first) ? first : '';
  if (type === 'pathing') return /\.(blp|dds|tga)$/i.test(first) ? first : '';
  return '';
}

function refreshDecoratedValue(mod) {
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

function setModValue(mod, value) {
  mod.editValue = value;
  mod.currentValue = value;
  refreshDecoratedValue(mod);
}

function decoratedValueHtml(mod, mi, raw) {
  refreshDecoratedValue(mod);
  if (mod.displayKind === 'rawcodes' && mod.resolvedItems && mod.resolvedItems.length) return resolvedItemsHtml(mod);
  if (!mod.displayValue || String(mod.displayValue) === String(raw)) {
    return raw === '' ? '<span class="tt-empty">(empty)</span>' : esc(raw);
  }
  return '<span class="value-display ' + esc(mod.displayKind || '') + '">' +
    assetMiniHtml(mod, mi) +
    '<span class="value-main" title="' + esc(mod.displayValue) + '">' + esc(mod.displayValue) + '</span>' +
    '<span class="value-raw" title="' + esc(mod.displayDetail || raw) + '">' + esc(mod.displayDetail || raw) + '</span>' +
  '</span>';
}

// Editor shown on click. Color/text fields get textarea + color bar + preview; everything else a plain input.
function editorHtml(mod, mi) {
  refreshDecoratedValue(mod);
  if (needsColorEditor(mod)) return colorEditorHtml(mod, mi);
  const v = mod.editValue == null ? '' : String(mod.editValue);
  const picker = pickerEditorHtml(mod, mi, v);
  if (picker) return picker;
  const numType = mod.varType === 'int' || mod.varType === 'real' || mod.varType === 'unreal';
  // NOTE: use a plain text input (not type="number") so the '.' decimal is locale-independent —
  // these are raw float/int game values, not locale-formatted numbers (German shows 1,5 for a
  // number input, which corrupts the value). inputmode hints a numeric keypad on touch.
  const mode = numType ? ' inputmode="' + (mod.varType === 'int' ? 'numeric' : 'decimal') + '"' : '';
  return '<div class="value-editor single"><input class="edit-raw" type="text"' + mode + ' data-mi="' + mi + '" spellcheck="false" value="' + esc(v) + '"></div>';
}

// Compact, click-to-edit view shown by default for every editable cell (keeps the 700-row table light).
function collapsedView(mod, mi) {
  const dv = mod.editValue == null ? (mod.currentValue == null ? '' : String(mod.currentValue)) : String(mod.editValue);
  if (hasColorMarkup(dv)) {
    return '<div class="tt-collapsed" data-mi="' + mi + '" tabindex="0" role="button" title="Click or press Enter to edit">' +
      '<span class="tt-collapsed-body">' + renderWc3Colors(dv) + '</span><span class="tt-edit-hint">✎</span></div>';
  }
  const badge = mod.overridden ? '<span class="override-badge" title="This field overrides the base value">modified</span>' : '';
  const disp = decoratedValueHtml(mod, mi, dv);
  return '<span class="cell-edit" data-mi="' + mi + '" tabindex="0" role="button" title="Click or press Enter to edit">' +
    '<span class="cell-edit-val">' + disp + '</span>' + badge + (mod.source ? sourcePill(mod) : '') +
    '<span class="tt-edit-hint">✎</span></span>';
}

function valueCell(mod, mi) {
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

function postEdit(mod) {
  vscodeApi.postMessage({
    type: 'editField',
    key: selectedKey,
    fieldId: mod.fieldId,
    level: mod.level == null ? null : mod.level,
    dataPt: mod.dataPt == null ? null : mod.dataPt,
    varType: mod.varType,
    value: mod.editValue == null ? '' : String(mod.editValue),
  });
}

// Current selection range for a textarea (kept fresh even after blur, so toolbar/color-picker work).
function taRange(ta) {
  const ss = ta._ss != null ? ta._ss : (ta.selectionStart || 0);
  const se = ta._se != null ? ta._se : (ta.selectionEnd || 0);
  return ss <= se ? [ss, se] : [se, ss];
}

function applyToTextarea(ta, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(selStart, selEnd);
  ta._ss = selStart; ta._se = selEnd;
  ta.dispatchEvent(new Event('input'));
}

// Wrap the current selection in |cffRRGGBB ... |r (hex = 6 chars, no '#').
function wrapColor(ta, hex) {
  const r = taRange(ta);
  const val = ta.value;
  const open = '|cff' + String(hex).replace('#', '').toLowerCase();
  const selected = val.slice(r[0], r[1]) || 'text';
  ta.value = val.slice(0, r[0]) + open + selected + '|r' + val.slice(r[1]);
  const a = r[0] + open.length;
  applyToTextarea(ta, a, a + selected.length);
}

function insertText(ta, text) {
  const r = taRange(ta);
  const val = ta.value;
  ta.value = val.slice(0, r[0]) + text + val.slice(r[1]);
  const c = r[0] + text.length;
  applyToTextarea(ta, c, c);
}

function categoryLabel(category) {
  const raw = String(category || 'Other');
  const labels = {
    abil: 'Abilities',
    art: 'Art',
    combat: 'Combat',
    data: 'Data',
    move: 'Movement',
    stats: 'Stats',
    tech: 'Techtree',
    text: 'Text',
    '-': 'Other'
  };
  return labels[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

function raceLabel(race) {
  const labels = {
    human: 'Human',
    orc: 'Orc',
    nightelf: 'Night Elf',
    undead: 'Undead',
    neutral: 'Neutral',
    naga: 'Naga',
    demon: 'Demon',
    other: 'Other'
  };
  return labels[String(race || 'other').toLowerCase()] || String(race || 'Other');
}

function raceRank(race) {
  const order = ['human', 'orc', 'nightelf', 'undead', 'neutral', 'naga', 'demon', 'other'];
  const index = order.indexOf(String(race || 'other').toLowerCase());
  return index < 0 ? order.length : index;
}

function idLine(obj) {
  return obj.newId
    ? esc(obj.baseId) + ' -> ' + esc(obj.newId)
    : esc(obj.baseId);
}

function objectIconHtml(obj, extraClass) {
  const cls = extraClass ? ' ' + extraClass : '';
  if (obj.iconPath) {
    const iconPath = String(obj.iconPath);
    const iconKey = obj.key + ':icon:' + iconPath;
    return '<span class="object-icon loading' + cls + '" data-key="' + esc(iconKey) + '" data-icon="' + esc(iconPath) + '" title="' + esc(iconPath) + '"><span class="icon-spinner"></span></span>';
  }
  if (obj.modelPath) {
    const modelPath = String(obj.modelPath);
    const modelKey = obj.key + ':model:' + modelPath;
    return '<span class="object-icon model-thumb' + cls + '" data-key="' + esc(modelKey) + '" data-model="' + esc(modelPath) + '" title="' + esc(modelPath) + '"></span>';
  }
  return '<span class="object-icon missing' + cls + '" title="No icon field"></span>';
}

function matches(obj) {
  if (!query) return true;
  const haystack = [obj.displayName, obj.baseId, obj.newId, obj.displaySource, obj.group].filter(Boolean).join(' ');
  return fuzzyMatch(query, haystack);
}

function renderTree() {
  const groups = ['Original', 'Custom'];
  let html = '';
  const allowCollapse = !query;
  for (const group of groups) {
    const groupObjects = objects.filter(obj => obj.group === group && matches(obj));
    if (!groupObjects.length) continue;
    const groupClosed = allowCollapse && collapsedGroups.has(group);
    html += '<button class="group-heading" type="button" data-group="' + esc(group) + '" aria-expanded="' + (groupClosed ? 'false' : 'true') + '">' +
      '<span class="twisty">' + (groupClosed ? '>' : 'v') + '</span>' +
      '<span>' + group + ' Objects</span><span class="folder-count">' + groupObjects.length + '</span></button>';
    if (groupClosed) continue;
    const races = Array.from(new Set(groupObjects.map(obj => obj.race || 'other')))
      .sort((a, b) => raceRank(a) - raceRank(b) || raceLabel(a).localeCompare(raceLabel(b)));
    for (const race of races) {
      const raceObjects = groupObjects.filter(obj => (obj.race || 'other') === race);
      const raceKey = group + ':' + race;
      const raceClosed = allowCollapse && collapsedRaces.has(raceKey);
      html += '<button class="race-heading" type="button" data-race="' + esc(raceKey) + '" aria-expanded="' + (raceClosed ? 'false' : 'true') + '">' +
        '<span class="twisty">' + (raceClosed ? '>' : 'v') + '</span>' +
        '<span>' + esc(raceLabel(race)) + '</span><span class="folder-count">' + raceObjects.length + '</span></button>';
      if (raceClosed) continue;
      for (const obj of raceObjects) {
        const active = obj.key === selectedKey ? ' active' : '';
        const source = obj.displaySource ? ' <span class="source-pill">' + esc(obj.displaySource) + '</span>' : '';
        const label = obj.displayName + ' — ' + (obj.newId ? obj.baseId + ' to ' + obj.newId : obj.baseId);
        html += '<button class="object-row' + active + '" type="button" data-key="' + esc(obj.key) + '" aria-label="' + esc(label) + '">' +
          objectIconHtml(obj, '') +
          '<span class="object-main"><span class="object-name" title="' + esc(obj.displayName) + '">' + esc(obj.displayName) + source + '</span>' +
          '<span class="object-id">' + idLine(obj) + '</span></span>' +
          '</button>';
      }
    }
  }
  tree.innerHTML = html || (query
    ? '<div class="empty-state">No objects match &ldquo;' + esc(query) + '&rdquo;.<br>Try a different term or clear the search.</div>'
    : '<div class="empty-state">No objects</div>');
  iconLoader.observe(tree);
  observeModelThumbs(tree);
}

// Move the selection highlight in place — rebuilding the whole tree (hundreds of rows) just to shift
// one '.active' class made object switching feel sluggish on large .w3a files.
function objectRowReplacementHtml(obj) {
  const active = obj.key === selectedKey ? ' active' : '';
  const source = obj.displaySource ? ' <span class="source-pill">' + esc(obj.displaySource) + '</span>' : '';
  const label = obj.displayName + ' - ' + (obj.newId ? obj.baseId + ' to ' + obj.newId : obj.baseId);
  return '<button class="object-row' + active + '" type="button" data-key="' + esc(obj.key) + '" aria-label="' + esc(label) + '">' +
    objectIconHtml(obj, '') +
    '<span class="object-main"><span class="object-name" title="' + esc(obj.displayName) + '">' + esc(obj.displayName) + source + '</span>' +
    '<span class="object-id">' + idLine(obj) + '</span></span>' +
    '</button>';
}

function updateObjectRow(obj) {
  const row = tree.querySelector('.object-row[data-key="' + obj.key + '"]');
  if (!row) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = objectRowReplacementHtml(obj);
  const next = wrap.firstElementChild;
  if (!next) return;
  row.replaceWith(next);
  iconLoader.observe(next);
}

function updateDetailsHeader(obj) {
  if (obj.key !== selectedKey) return;
  const head = details.querySelector('.details-head');
  if (!head) return;
  const iconSlot = head.querySelector('.details-title-row > .object-icon');
  if (iconSlot) {
    const wrap = document.createElement('div');
    wrap.innerHTML = objectIconHtml(obj, 'details-icon');
    const next = wrap.firstElementChild;
    if (next) {
      iconSlot.replaceWith(next);
      iconLoader.observe(next);
    }
  }
  const title = head.querySelector('.details-title');
  if (title) {
    const rawcode = obj.newId ? esc(obj.baseId) + ' -> ' + esc(obj.newId) : esc(obj.baseId);
    title.innerHTML = esc(obj.displayName) +
      '<span class="details-rawcode">' + rawcode + '</span>' +
      (obj.displaySource ? sourcePill({ source: obj.displaySource }) : '');
  }
}

function setActiveRow(key) {
  for (const el of tree.querySelectorAll('.object-row.active')) el.classList.remove('active');
  // Keys are trusted 'Group:Index' strings (no quotes/backslashes) so a literal attribute match is safe.
  const row = tree.querySelector('.object-row[data-key="' + key + '"]');
  if (row) row.classList.add('active');
  return row;
}

function selectObject(key) {
  if (!key) return;
  selectedKey = key;
  setActiveRow(key);
  renderDetails();
  hideModelPreview(); // the open preview belongs to the previous object — don't leave it stale
}

// Delegated tree handlers, wired once — survive innerHTML rebuilds, no per-row listener churn.
function setupTree() {
  tree.addEventListener('click', e => {
    const groupHeading = e.target.closest('.group-heading');
    if (groupHeading) {
      const group = groupHeading.getAttribute('data-group') || '';
      if (group) { if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group); renderTree(); }
      return;
    }
    const raceHeading = e.target.closest('.race-heading');
    if (raceHeading) {
      const race = raceHeading.getAttribute('data-race') || '';
      if (race) { if (collapsedRaces.has(race)) collapsedRaces.delete(race); else collapsedRaces.add(race); renderTree(); }
      return;
    }
    const row = e.target.closest('.object-row');
    if (row) selectObject(row.getAttribute('data-key') || selectedKey);
  });
  // Arrow / Home / End move through the visible object rows (collapsed sections aren't in the DOM).
  tree.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = Array.prototype.slice.call(tree.querySelectorAll('.object-row'));
    if (!rows.length) return;
    e.preventDefault();
    const ae = document.activeElement;
    const focused = ae && ae.classList && ae.classList.contains('object-row') ? ae : tree.querySelector('.object-row.active');
    let idx = focused ? rows.indexOf(focused) : -1;
    if (e.key === 'Home') idx = 0;
    else if (e.key === 'End') idx = rows.length - 1;
    else if (e.key === 'ArrowDown') idx = idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
    else idx = idx <= 0 ? 0 : idx - 1;
    const target = rows[idx];
    if (!target) return;
    selectObject(target.getAttribute('data-key'));
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  });
}

// Scope the scan to the just-rendered subtree (tree / details / a single cell) instead of the whole
// document — a .w3a file can have hundreds of icons and a full-document scan ran on every render.

// Decode an icon to a data URL using the browser — same pipeline as the BLP viewer (handles BGR
// jpeg-content BLPs by swapping R/B after decode, plus 4-component jpegs the browser supports).
function observeModelThumbs(root) {
  if (!modelThumbObserver) {
    modelThumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (!isModelThumbActuallyVisible(entry.target)) continue;
        modelThumbObserver.unobserve(entry.target);
        requestModelThumb(entry.target);
      }
    }, { root: null, rootMargin: '0px' });
  }
  for (const el of (root || document).querySelectorAll('.model-thumb[data-model]')) {
    const key = el.getAttribute('data-key') || '';
    if (loadedModelThumbs.has(key)) {
      setModelThumbLoaded(el, loadedModelThumbs.get(key));
    } else if (missingModelThumbs.has(key)) {
      setModelThumbMissing(el, missingModelThumbReasons.get(key));
    } else if (isModelThumbActuallyVisible(el)) {
      requestModelThumb(el);
    } else {
      modelThumbObserver.observe(el);
    }
  }
}

function requestVisibleModelThumbs(root) {
  for (const el of (root || document).querySelectorAll('.model-thumb[data-model]')) {
    const key = el.getAttribute('data-key') || '';
    if (!key || pendingModelThumbs.has(key) || loadedModelThumbs.has(key) || missingModelThumbs.has(key)) continue;
    if (isModelThumbActuallyVisible(el)) requestModelThumb(el);
  }
}

function isAssetBrowserModelKey(key) {
  return String(key || '').indexOf('ab-model:') === 0;
}

function isAssetBrowserOpen() {
  const ov = document.getElementById('ab-overlay');
  return !!ov && !ov.hidden;
}

function rectsIntersect(a, b) {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

function isModelThumbActuallyVisible(el) {
  if (!el || !el.isConnected) return false;
  const key = el.getAttribute('data-key') || '';
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (isAssetBrowserModelKey(key)) {
    if (!isAssetBrowserOpen() || abActiveTab.get() !== 'model') return false;
    const grid = document.getElementById('ab-grid');
    if (!grid || !grid.contains(el)) return false;
    return rectsIntersect(rect, grid.getBoundingClientRect());
  }
  return rectsIntersect(rect, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
}

function hasVisibleModelThumbElement(key) {
  for (const el of modelThumbElementsForKey(key)) {
    if (isModelThumbActuallyVisible(el)) return true;
  }
  return false;
}

function reobserveModelThumbKey(key) {
  for (const el of modelThumbElementsForKey(key)) {
    if (!loadedModelThumbs.has(key) && !missingModelThumbs.has(key) && modelThumbObserver && el.isConnected) {
      modelThumbObserver.observe(el);
    }
  }
}

function cancelPendingModelThumb(key) {
  pendingModelThumbs.delete(key);
  cancelQueuedModelThumbRequest(key);
  updateModelThumbElements(key, setModelThumbQueuedOrCancelled);
  reobserveModelThumbKey(key);
}

function shouldPruneQueuedModelThumb(key) {
  return !!key && !loadedModelThumbs.has(key) && !missingModelThumbs.has(key) && !hasVisibleModelThumbElement(key);
}

function pruneInvisibleQueuedModelThumbs() {
  const keys = new Set();
  for (const req of modelThumbRequestQueue) {
    if (req && shouldPruneQueuedModelThumb(req.key)) keys.add(req.key);
  }
  for (const job of modelThumbQueue) {
    if (job && shouldPruneQueuedModelThumb(job.key)) keys.add(job.key);
  }
  for (const key of keys) {
    for (let i = modelThumbQueue.length - 1; i >= 0; i--) {
      if (modelThumbQueue[i] && modelThumbQueue[i].key === key) modelThumbQueue.splice(i, 1);
    }
    cancelPendingModelThumb(key);
  }
}

function recordModelThumbEvent(type, key, extra) {
  modelThumbEvents.push(Object.assign({ type, key: key || '', at: Math.round(performance.now()) }, extra || {}));
  if (modelThumbEvents.length > 10000) modelThumbEvents.splice(0, modelThumbEvents.length - 10000);
}

function scheduleModelThumbQueues(delay) {
  if (modelThumbIdleTimer) clearTimeout(modelThumbIdleTimer);
  modelThumbIdleTimer = setTimeout(() => {
    modelThumbIdleTimer = 0;
    processModelThumbRequestQueue();
    processModelThumbQueue();
  }, Math.max(0, delay || 0));
}

function noteModelThumbUserActivity() {
  requestVisibleModelThumbs(document);
  pruneInvisibleQueuedModelThumbs();
  scheduleModelThumbQueues(0);
}

function requestModelThumb(el) {
  const key = el.getAttribute('data-key') || '';
  const modelPath = el.getAttribute('data-model') || '';
  if (!isModelThumbActuallyVisible(el)) return;
  if (isAssetBrowserModelKey(key) && !isAssetBrowserOpen()) return;
  if (!key || !modelPath || pendingModelThumbs.has(key) || loadedModelThumbs.has(key) || missingModelThumbs.has(key)) return;
  pendingModelThumbs.add(key);
  el.classList.add('pending');
  modelThumbRequestQueue.push({ key, path: modelPath, seq: modelThumbSeq++ });
  recordModelThumbEvent('queued', key);
  scheduleModelThumbQueues(0);
}

function sortModelThumbQueueByDom(queue) {
  const order = new Map();
  Array.prototype.slice.call(document.querySelectorAll('.model-thumb[data-key]')).forEach((el, index) => {
    const key = el.getAttribute('data-key') || '';
    if (key && !order.has(key)) order.set(key, index);
  });
  queue.sort((a, b) => {
    const ai = order.has(a.key) ? order.get(a.key) : Number.MAX_SAFE_INTEGER;
    const bi = order.has(b.key) ? order.get(b.key) : Number.MAX_SAFE_INTEGER;
    return ai - bi || (a.seq || 0) - (b.seq || 0);
  });
}

function processModelThumbRequestQueue() {
  pruneInvisibleQueuedModelThumbs();
  if (modelThumbAwaitingDecisionKey || modelThumbJob || modelThumbQueue.length) return;
  sortModelThumbQueueByDom(modelThumbRequestQueue);
  while (modelThumbHostInflight.size < MODEL_THUMB_HOST_CONCURRENCY && modelThumbRequestQueue.length) {
    const req = modelThumbRequestQueue.shift();
    if (!req || !req.key || loadedModelThumbs.has(req.key) || missingModelThumbs.has(req.key) || !pendingModelThumbs.has(req.key)) continue;
    if (!hasVisibleModelThumbElement(req.key)) {
      cancelPendingModelThumb(req.key);
      continue;
    }
    modelThumbHostInflight.add(req.key);
    updateModelThumbElements(req.key, el => el.classList.add('pending'));
    recordModelThumbEvent('host-start', req.key);
    vscodeApi.postMessage({ type: 'loadModelThumb', key: req.key, path: req.path });
  }
}

function completeModelThumbHostRequest(key) {
  modelThumbHostInflight.delete(key);
  scheduleModelThumbQueues(0);
}

function cancelQueuedModelThumbRequest(key) {
  for (let i = modelThumbRequestQueue.length - 1; i >= 0; i--) {
    if (modelThumbRequestQueue[i] && modelThumbRequestQueue[i].key === key) {
      modelThumbRequestQueue.splice(i, 1);
    }
  }
  modelThumbHostInflight.delete(key);
}

function setModelThumbLoaded(el, uri) {
  el.classList.remove('pending', 'missing');
  el.innerHTML = '<img loading="lazy" src="' + esc(uri) + '" alt="' + esc(el.getAttribute('data-model') || '') + '">';
}

function setModelThumbQueuedOrCancelled(el) {
  el.classList.remove('pending');
}

function describeModelThumbMissing(reason) {
  if (!reason) return 'Thumbnail unavailable';
  if (reason.reason === 'not-found') return 'Model not found in map or game files';
  if (reason.reason === 'not-model') return 'Resolved asset is not a model';
  if (reason.reason === 'error') return 'Thumbnail failed';
  return 'Thumbnail unavailable: ' + reason.reason;
}

function setModelThumbMissing(el, reason) {
  el.classList.remove('pending');
  el.classList.add('missing');
  el.title = describeModelThumbMissing(reason);
}

function markModelThumbMissing(key, reason) {
  pendingModelThumbs.delete(key);
  missingModelThumbs.add(key);
  missingModelThumbReasons.set(key, reason || { reason: 'missing' });
  updateModelThumbElements(key, el => setModelThumbMissing(el, missingModelThumbReasons.get(key)));
}

function updateModelThumbElements(key, updater) {
  for (const el of modelThumbElementsForKey(key)) updater(el);
}

function modelThumbElementsForKey(key) {
  return Array.prototype.slice.call(document.querySelectorAll('.model-thumb[data-key]')).filter(el => (el.getAttribute('data-key') || '') === key);
}

function modelThumbProfile(phase, detail) {
  if (!modelThumbJob) return;
  const now = performance.now();
  const previous = modelThumbJob.lastMarkAt || modelThumbJob.startedAt || now;
  modelThumbJob.lastMarkAt = now;
  vscodeApi.postMessage({
    type: 'modelThumbProfile',
    key: modelThumbJob.key,
    phase: phase,
    elapsedMs: Math.round(now - modelThumbJob.startedAt),
    deltaMs: Math.round(now - previous),
    detail: detail || '',
  });
  recordModelThumbEvent('profile:' + phase, modelThumbJob.key, { elapsedMs: Math.round(now - modelThumbJob.startedAt), detail: detail || '' });
}

async function modelThumbJobBytes(job) {
  if (job.modelUri) {
    const response = await fetch(job.modelUri);
    if (!response.ok) throw new Error('fetch ' + response.status);
    return response.arrayBuffer();
  }
  return mpvB64ToArrayBuffer(job.mdxBase64 || '');
}

function modelThumbEnsureInit() {
  const v = mpvViewer();
  if (!v) return false;
  if (modelThumbInited) return true;
  const canvas = document.getElementById('model-thumb-canvas');
  const viewport = document.getElementById('model-thumb-viewport');
  if (!canvas || !viewport) return false;
  const gizmo = document.createElement('canvas');
  gizmo.width = 1; gizmo.height = 1;
  window.__WAR3_MODEL_DEBUG = true;
  v.init({
    canvas3d: canvas,
    gizmo: gizmo,
    viewport: viewport,
    vscodeApi: {
      postMessage(msg) {
        if (msg && msg.type === 'requestTextures') {
          if (!modelThumbJob) return;
          const paths = modelThumbTexturePaths(msg.paths || []);
          modelThumbJob.requestedTextures = new Set(paths);
          modelThumbJob.pendingTextures = new Set(paths.filter(path => !modelThumbJob.receivedTextures || !modelThumbJob.receivedTextures.has(path)));
          vscodeApi.postMessage(Object.assign({}, msg, { paths, thumbKey: modelThumbJob ? modelThumbJob.key : '' }));
        } else {
          vscodeApi.postMessage(msg);
        }
      },
    },
    callbacks: {
      onModelLoaded(info) { modelThumbOnLoaded((info && info.sequences) || [], (info && info.texturePaths) || []); },
      onFrameUpdate() {},
      onDebug(msg) {
        const text = String(msg || '');
        if (/Uploading compressed texture|^texture(?: \(dds\)| \(rgba\))? ok:|^texture not found:|Missing HD |Rendering SD |SD material layer setup|Missing SD /i.test(text)) return;
        modelThumbProfile('viewer-debug', text);
      },
      onError() { finishModelThumb(false); },
    },
  });
  modelThumbInited = true;
  mpvInited = false;
  return true;
}

function modelThumbTexturePaths(texturePaths) {
  return (texturePaths || []).filter(path => {
    const lower = String(path || '').replace(/\\/g, '/').toLowerCase();
    const name = lower.split('/').pop() || lower;
    if (/(?:^|[_-])(?:normal|orm)(?:\.|_|-)/.test(name)) return false;
    if (/(?:^|[_-])emissive(?:\.|_|-)/.test(name)) return false;
    if (name === 'environmentmap.blp' || name === 'environmentmap.dds' || name === 'environmentmap.tga') return false;
    if (/(?:^|[_-])corpse(?:[_-]|\.|$)/.test(name) || /(?:[_-])corpse(?:[_-])/.test(name)) return false;
    return true;
  });
}

function pickStandSequence(seqs) {
  let pick = 0, best = Infinity;
  seqs.forEach((s, i) => {
    const n = (s.name || '').toLowerCase();
    if (n.indexOf('stand') >= 0 && n.length < best) { best = n.length; pick = i; }
  });
  return pick;
}

function modelThumbOnLoaded(seqs, texturePaths) {
  if (!modelThumbJob) return;
  const thumbTextures = modelThumbTexturePaths(texturePaths || []);
  modelThumbProfile('model-loaded', 'textures=' + thumbTextures.length + '/' + ((texturePaths && texturePaths.length) || 0));
  const v = mpvViewer();
  if (v && seqs.length) {
    const pick = pickStandSequence(seqs);
    const seq = seqs[pick];
    try {
      v.setSequence(pick);
      v.setFrame(seq ? Math.round(seq.start + Math.max(0, seq.end - seq.start) * 0.2) : 0);
      v.resetCamera();
      v.zoomOut();
      v.zoomOut();
      v.setAutoplay(false);
    } catch (e) {}
  }
  const requested = modelThumbJob.requestedTextures ? Array.from(modelThumbJob.requestedTextures) : thumbTextures;
  modelThumbJob.pendingTextures = new Set(requested.filter(path => !modelThumbJob.receivedTextures || !modelThumbJob.receivedTextures.has(path)));
  modelThumbJob.textureFailures = modelThumbJob.textureFailures || 0;
  if (modelThumbJob.pendingTextures.size === 0) scheduleModelThumbCapture(0, 1);
  else modelThumbProfile('wait-textures', 'remaining=' + modelThumbJob.pendingTextures.size);
}

function scheduleModelThumbCapture(timeoutMs, frames) {
  if (!modelThumbJob) return;
  if (isAssetBrowserModelKey(modelThumbJob.key) && !hasVisibleModelThumbElement(modelThumbJob.key)) {
    cancelCurrentModelThumb('not-visible-before-capture');
    return;
  }
  modelThumbProfile('schedule-capture', 'delay=' + timeoutMs + 'ms pendingTextures=' + (modelThumbJob.pendingTextures ? modelThumbJob.pendingTextures.size : 0));
  clearTimeout(modelThumbTextureTimer);
  const waitFrames = Math.max(0, frames == null ? 1 : frames);
  const arm = () => {
    let remaining = waitFrames;
    const tick = () => {
      if (!modelThumbJob) return;
      if (isAssetBrowserModelKey(modelThumbJob.key) && !hasVisibleModelThumbElement(modelThumbJob.key)) {
        cancelCurrentModelThumb('not-visible-capture');
        return;
      }
      if (remaining-- > 0) requestAnimationFrame(tick);
      else captureModelThumb();
    };
    requestAnimationFrame(tick);
  };
  if (timeoutMs > 0) modelThumbTextureTimer = setTimeout(arm, timeoutMs);
  else arm();
}

function captureModelThumb() {
  if (!modelThumbJob) return;
  if (isAssetBrowserModelKey(modelThumbJob.key) && !hasVisibleModelThumbElement(modelThumbJob.key)) {
    cancelCurrentModelThumb('not-visible-capture-start');
    return;
  }
  if (modelThumbJob.pendingTextures && modelThumbJob.pendingTextures.size > 0) {
    modelThumbProfile('capture-blocked-textures', 'remaining=' + modelThumbJob.pendingTextures.size);
    return;
  }
  modelThumbProfile('capture-start');
  const canvas = document.getElementById('model-thumb-canvas');
  if (!canvas) { finishModelThumb(false, 'no-canvas'); return; }
  try {
    const v = mpvViewer();
    if (v && typeof v.renderStillFrame === 'function') v.renderStillFrame();
    const out = cropModelThumbCanvas(canvas);
    const quality = modelThumbQuality(out);
    if (quality.alphaPixels < MODEL_THUMB_MIN_VISIBLE_PIXELS) {
      modelThumbJob.blackRetries = (modelThumbJob.blackRetries || 0) + 1;
      modelThumbProfile('capture-empty', 'retry=' + modelThumbJob.blackRetries + ' alpha=' + quality.alphaPixels);
      if (modelThumbJob.blackRetries <= MODEL_THUMB_ZERO_ALPHA_RETRIES) {
        scheduleModelThumbCapture(50, 1);
      } else {
        finishModelThumb(false, 'empty');
      }
      return;
    }
    if (quality.tooDark) {
      // Some valid WC3 models render as very dark silhouettes in the thumbnail light/camera setup.
      // Prefer caching a visible thumbnail over spending a render cycle and ending as a permanent "?".
      modelThumbProfile('capture-dark-accepted', 'alpha=' + quality.alphaPixels + ' avg=' + Math.round(quality.avgLuma) + ' max=' + quality.maxLuma);
    }
    const dataUrl = out.toDataURL('image/webp', 0.58);
    const marker = 'data:image/webp;base64,';
    if (!dataUrl || dataUrl.indexOf(marker) !== 0) { finishModelThumb(false, 'encode-failed'); return; }
    vscodeApi.postMessage({
      type: 'modelThumbRendered',
      key: modelThumbJob.key,
      cacheKey: modelThumbJob.cacheKey,
      aliasKey: modelThumbJob.aliasKey,
      webpBase64: dataUrl.slice(marker.length),
    });
    modelThumbProfile('capture-posted', 'bytes=' + Math.round((dataUrl.length - marker.length) * 0.75));
    finishModelThumb(true, '', dataUrl);
  } catch (e) {
    modelThumbProfile('capture-error', String(e && e.message ? e.message : e));
    finishModelThumb(false, 'capture-error');
  }
}

function modelThumbQuality(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { tooDark: true, alphaPixels: 0, avgLuma: 0, maxLuma: 0 };
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = id.data;
  let alphaPixels = 0;
  let lumaSum = 0;
  let maxLuma = 0;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a <= 12) continue;
    const luma = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    alphaPixels++;
    lumaSum += luma;
    if (luma > maxLuma) maxLuma = luma;
  }
  const avgLuma = alphaPixels ? lumaSum / alphaPixels : 0;
  return {
    tooDark: alphaPixels >= MODEL_THUMB_MIN_VISIBLE_PIXELS && avgLuma < 10 && maxLuma < 34,
    alphaPixels,
    avgLuma,
    maxLuma,
  };
}

function cropModelThumbCanvas(canvas) {
  const id = readModelThumbFrame(canvas);
  const w = id.width, h = id.height;
  const px = id.data;
  normalizeAdditivePixels(px);
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  const sctx = src.getContext('2d');
  sctx.putImageData(id, 0, 0);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = (y * w + x) * 4;
      if (!isModelThumbPixelVisible(px[off], px[off + 1], px[off + 2], px[off + 3])) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return src;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const pad = Math.ceil(Math.max(bw, bh) * 0.16);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = document.createElement('canvas');
  out.width = 96; out.height = 96;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  const scale = Math.min(96 / cw, 96 / ch);
  const dw = Math.max(1, Math.round(cw * scale));
  const dh = Math.max(1, Math.round(ch * scale));
  octx.clearRect(0, 0, 96, 96);
  octx.drawImage(src, minX, minY, cw, ch, Math.round((96 - dw) / 2), Math.round((96 - dh) / 2), dw, dh);
  return out;
}

function readModelThumbFrame(canvas) {
  const v = mpvViewer();
  if (v && typeof v.readPixelsImageData === 'function') {
    const frame = v.readPixelsImageData();
    if (frame) return frame;
  }
  const src = document.createElement('canvas');
  src.width = canvas.width;
  src.height = canvas.height;
  const sctx = src.getContext('2d');
  sctx.drawImage(canvas, 0, 0);
  return sctx.getImageData(0, 0, src.width, src.height);
}

function isModelThumbPixelVisible(r, g, b, a) {
  return a > 8 || (r + g + b) > 24;
}

function normalizeAdditivePixels(px) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a > 8) continue;
    const rgbAlpha = Math.max(px[i], px[i + 1], px[i + 2]);
    if (rgbAlpha > 8) px[i + 3] = rgbAlpha;
  }
}

function finishModelThumb(rendered, reason, localUri) {
  if (!modelThumbJob) return;
  const key = modelThumbJob.key;
  const cacheKey = modelThumbJob.cacheKey;
  const aliasKey = modelThumbJob.aliasKey;
  clearTimeout(modelThumbTextureTimer);
  if (!rendered) {
    vscodeApi.postMessage({ type: 'modelThumbFailed', key, cacheKey, aliasKey, reason: reason || 'failed' });
    cancelQueuedModelThumbRequest(key);
    markModelThumbMissing(key, { reason: reason || 'failed' });
    recordModelThumbEvent('failed', key, { reason: reason || 'failed' });
  } else if (localUri) {
    pendingModelThumbs.delete(key);
    loadedModelThumbs.set(key, localUri);
    updateModelThumbElements(key, el => setModelThumbLoaded(el, localUri));
    recordModelThumbEvent('loaded', key);
  } else {
    modelThumbAwaitingDecisionKey = key;
  }
  modelThumbJob = null;
  if (!rendered || localUri) scheduleModelThumbQueues(0);
}

function cancelCurrentModelThumb(reason) {
  if (!modelThumbJob) return;
  const key = modelThumbJob.key;
  modelThumbProfile(reason || 'cancelled');
  clearTimeout(modelThumbTextureTimer);
  pendingModelThumbs.delete(key);
  cancelQueuedModelThumbRequest(key);
  if (modelThumbAwaitingDecisionKey === key) modelThumbAwaitingDecisionKey = '';
  updateModelThumbElements(key, setModelThumbQueuedOrCancelled);
  recordModelThumbEvent('cancelled', key, { reason: reason || 'cancelled' });
  reobserveModelThumbKey(key);
  modelThumbJob = null;
  scheduleModelThumbQueues(0);
}

function cancelAssetBrowserModelThumbs() {
  modelThumbCancelGeneration++;
  modelThumbRequestQueue.splice(0, modelThumbRequestQueue.length, ...modelThumbRequestQueue.filter(req => !isAssetBrowserModelKey(req.key)));
  modelThumbQueue.splice(0, modelThumbQueue.length, ...modelThumbQueue.filter(job => !isAssetBrowserModelKey(job.key)));
  for (const key of Array.from(pendingModelThumbs)) {
    if (isAssetBrowserModelKey(key)) {
      cancelPendingModelThumb(key);
    }
  }
  if (modelThumbJob && isAssetBrowserModelKey(modelThumbJob.key)) {
    cancelCurrentModelThumb('cancelled');
  }
  scheduleModelThumbQueues(0);
}

function processModelThumbQueue() {
  pruneInvisibleQueuedModelThumbs();
  if (modelThumbJob || !modelThumbQueue.length) return;
  if (modelThumbAwaitingDecisionKey) return;
  const box = document.getElementById('mpv-box');
  if (box && !box.hidden) return;
  sortModelThumbQueueByDom(modelThumbQueue);
  const job = modelThumbQueue.shift();
  if (job && !hasVisibleModelThumbElement(job.key)) {
    cancelPendingModelThumb(job.key);
    scheduleModelThumbQueues(0);
    return;
  }
  if (!job || loadedModelThumbs.has(job.key) || missingModelThumbs.has(job.key)) {
    scheduleModelThumbQueues(0);
    return;
  }
  if (!modelThumbEnsureInit()) {
    cancelQueuedModelThumbRequest(job.key);
    markModelThumbMissing(job.key, { reason: 'viewer-init-failed' });
    scheduleModelThumbQueues(0);
    return;
  }
  modelThumbJob = job;
  updateModelThumbElements(job.key, el => el.classList.add('pending'));
  recordModelThumbEvent('render-start', job.key);
  modelThumbJob.startedAt = performance.now();
  modelThumbJob.lastMarkAt = modelThumbJob.startedAt;
  modelThumbJob.generation = modelThumbCancelGeneration;
  modelThumbJob.receivedTextures = new Set();
  modelThumbJob.requestedTextures = null;
  modelThumbJob.textureFailures = 0;
  modelThumbProfile('fetch-start', job.modelUri ? 'uri' : 'base64');
  modelThumbJobBytes(job).then(buffer => {
    if (!modelThumbJob || modelThumbJob !== job) return;
    modelThumbProfile('load-start', String(job.fileName || ''));
    try {
      mpvViewer().loadModel(buffer, job.fileName || '', job.format || 'mdx', { autoplay: false });
    } catch (e) {
      finishModelThumb(false);
    }
  }).catch(e => {
    if (!modelThumbJob || modelThumbJob !== job) return;
    modelThumbProfile('fetch-error', String(e && e.message ? e.message : e));
    finishModelThumb(false);
  });
}

function applyMdxTexture(msg) {
  const v = mpvViewer();
  if (!v) return;
  if (msg.ddsBase64) {
    v.onTextureDds(msg.path, mpvB64ToArrayBuffer(msg.ddsBase64));
  } else if (msg.rgbaBase64 && msg.width && msg.height) {
    const rgba = base64ToBytes(msg.rgbaBase64);
    v.onTextureImageData(msg.path, new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), msg.width, msg.height));
  } else {
    v.onTexture(msg.path, msg.blpBase64 ? mpvB64ToArrayBuffer(msg.blpBase64) : null);
  }
}

window.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type === 'objectIconLoaded') {
    iconLoader.handleLoaded(msg);
  } else if (msg.type === 'objectIconMissing') {
    iconLoader.handleMissing(msg.key || '');
  } else if (msg.type === 'modelThumbLoaded') {
    completeModelThumbHostRequest(msg.key);
    pendingModelThumbs.delete(msg.key);
    loadedModelThumbs.set(msg.key, msg.uri);
    missingModelThumbs.delete(msg.key);
    missingModelThumbReasons.delete(msg.key);
    updateModelThumbElements(msg.key, el => setModelThumbLoaded(el, msg.uri));
    recordModelThumbEvent('loaded', msg.key);
    if (modelThumbAwaitingDecisionKey === msg.key) modelThumbAwaitingDecisionKey = '';
    scheduleModelThumbQueues(0);
  } else if (msg.type === 'modelThumbMissing') {
    completeModelThumbHostRequest(msg.key);
    markModelThumbMissing(msg.key, {
      reason: msg.reason || 'missing',
      bytes: msg.bytes,
      maxBytes: msg.maxBytes,
    });
    recordModelThumbEvent('missing', msg.key, { reason: msg.reason || 'missing' });
    if (modelThumbAwaitingDecisionKey === msg.key) modelThumbAwaitingDecisionKey = '';
    scheduleModelThumbQueues(0);
  } else if (msg.type === 'modelThumbRender') {
    completeModelThumbHostRequest(msg.key);
    if (isAssetBrowserModelKey(msg.key) && (!isAssetBrowserOpen() || !hasVisibleModelThumbElement(msg.key))) {
      pendingModelThumbs.delete(msg.key);
      updateModelThumbElements(msg.key, setModelThumbQueuedOrCancelled);
      return;
    }
    if (!msg.key || !msg.cacheKey || (!msg.modelUri && !msg.mdxBase64)) {
      markModelThumbMissing(msg.key, { reason: 'invalid-render-request' });
    } else if (!loadedModelThumbs.has(msg.key) && !missingModelThumbs.has(msg.key)) {
      msg.seq = modelThumbSeq++;
      modelThumbQueue.push(msg);
      recordModelThumbEvent('render-enqueued', msg.key);
      scheduleModelThumbQueues(0);
    }
  } else if (msg.type === 'objectDetailsLoaded') {
    pendingDetails.delete(msg.key);
    detailCache.set(msg.key, msg.mods || []);
    if (msg.key === selectedKey) renderDetails();
  } else if (msg.type === 'objectDetailsFailed') {
    pendingDetails.delete(msg.key);
    detailCache.set(msg.key, []);
    if (msg.key === selectedKey) renderDetails();
  } else if (msg.type === 'invalidateDetails') {
    detailCache.delete(msg.key);
    pendingDetails.delete(msg.key);
    if (msg.key === selectedKey) renderDetails();
  } else if (msg.type === 'fieldUpdated') {
    const mods = detailCache.get(msg.key);
    if (!mods) return;
    const norm = v => (v == null ? null : v);
    const mod = mods.find(m => m.fieldId && m.fieldId.toLowerCase() === String(msg.fieldId).toLowerCase() &&
      norm(m.level) === norm(msg.level) && norm(m.dataPt) === norm(msg.dataPt));
    if (!mod) return;
    setModValue(mod, msg.editValue);
    if (msg.overridden != null) mod.overridden = msg.overridden;
    if (msg.key === selectedKey) {
      const mi = mods.indexOf(mod);
      const anchor = details.querySelector('[data-mi="' + mi + '"]');
      const tr = anchor && anchor.closest('tr');
      if (tr) tr.classList.toggle('overridden', !!mod.overridden);
      updateFieldCell(mods, mod);
    }
  } else if (msg.type === 'objectUpdated' && msg.object && msg.object.key) {
    const index = objects.findIndex(obj => obj.key === msg.object.key);
    if (index < 0) return;
    const oldIcon = objects[index].iconPath || '';
    Object.assign(objects[index], msg.object);
    if (oldIcon !== (objects[index].iconPath || '')) {
      iconLoader.clearPrefix(objects[index].key + ':icon:');
    }
    updateObjectRow(objects[index]);
    updateDetailsHeader(objects[index]);
  } else if (msg.type === 'dirtyStateChanged') {
    const badge = document.getElementById('editable-badge');
    if (badge) {
      badge.classList.toggle('dirty', !!msg.isDirty);
      badge.textContent = msg.isDirty ? '● unsaved' : 'editable';
      badge.title = msg.isDirty
        ? 'Unsaved changes — Ctrl+S to save.'
        : 'Existing overrides can be edited. Ctrl+S to save.';
    }
  } else if (msg.type === 'mdxModel') {
    mpvStatus('');
    if (mpvViewer()) { mpvViewer().loadModel(mpvB64ToArrayBuffer(msg.mdxBase64), msg.fileName || '', msg.format || 'mdx'); mpvSetPlaying(true); }
  } else if (msg.type === 'assetCatalog') {
    abCatalog = { model: msg.models || [], icon: msg.icons || [], pathing: msg.pathing || [] };
    const ov = document.getElementById('ab-overlay');
    if (ov && !ov.hidden) renderAssetGrid();
  } else if (msg.type === 'mdxModelMissing') {
    mpvStatus('Not found in map or game files:\\n' + (msg.path || '') + '\\n(tried .mdx/.mdl — see "Log (Extension Host)" for CASC details)');
  } else if (msg.type === 'mdxTexture') {
    if (modelThumbJob) {
      if (msg.thumbKey && msg.thumbKey !== modelThumbJob.key) return;
      if (!modelThumbJob.receivedTextures) modelThumbJob.receivedTextures = new Set();
      modelThumbJob.receivedTextures.add(msg.path);
      if (!msg.thumbKey && modelThumbJob.pendingTextures && modelThumbJob.pendingTextures.has(msg.path)) return;
      if (modelThumbJob.pendingTextures && !modelThumbJob.pendingTextures.has(msg.path)) return;
      if (msg.missing || msg.unsupported || msg.error) {
        modelThumbJob.textureFailures = (modelThumbJob.textureFailures || 0) + 1;
      } else {
        applyMdxTexture(msg);
      }
      if (modelThumbJob.pendingTextures) modelThumbJob.pendingTextures.delete(msg.path);
      modelThumbProfile('texture-received', 'remaining=' + (modelThumbJob.pendingTextures ? modelThumbJob.pendingTextures.size : 0) + ' failures=' + (modelThumbJob.textureFailures || 0) + ' path=' + (msg.path || ''));
      if (!modelThumbJob.pendingTextures || modelThumbJob.pendingTextures.size === 0) scheduleModelThumbCapture(0, 1);
      return;
    }
    if (msg.thumbKey) return;
    applyMdxTexture(msg);
  }
});

// ── Inline model preview (control-less docked square) ────────────────────────
let mpvInited = false;
function mpvViewer() { return window.War3Viewer || null; }
function mpvB64ToArrayBuffer(b64) {
  const bytes = base64ToBytes(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function mpvStatus(text) {
  const el = document.getElementById('mpv-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}
function mpvEnsureInit() {
  if (mpvInited) return mpvInited;
  const v = mpvViewer();
  if (!v) return false;
  modelThumbInited = false;
  v.init({
    canvas3d: document.getElementById('mpv-canvas'),
    gizmo: document.getElementById('mpv-gizmo'),
    viewport: document.getElementById('mpv-viewport'),
    vscodeApi: vscodeApi,
    callbacks: {
      onModelLoaded(info) { mpvStatus(''); mpvFillAnims((info && info.sequences) || []); },
      onFrameUpdate() {},
      onDebug() {},
      onError(message) { mpvStatus('Preview error:\\n' + message); },
    },
  });
  mpvInited = true;
  return true;
}
// Populate the slim animation selector and default to a "Stand" sequence (movement anims drift).
function mpvFillAnims(seqs) {
  const sel = document.getElementById('mpv-anim');
  if (!sel) return;
  if (!seqs.length) { sel.hidden = true; sel.innerHTML = ''; return; }
  sel.innerHTML = seqs.map((s, i) => '<option value="' + i + '">' + esc(s.name || ('Sequence ' + i)) + '</option>').join('');
  // Prefer the shortest name containing "stand" (base Stand over Stand Ready / Stand Victory).
  let pick = 0, best = Infinity;
  seqs.forEach((s, i) => {
    const n = (s.name || '').toLowerCase();
    if (n.indexOf('stand') >= 0 && n.length < best) { best = n.length; pick = i; }
  });
  sel.value = String(pick);
  sel.hidden = false;
  const v = mpvViewer();
  if (v) v.setSequence(pick);
}
function showModelPreview(path) {
  if (!path) return;
  if (modelThumbJob) finishModelThumb(false);
  const box = document.getElementById('mpv-box');
  const name = document.getElementById('mpv-name');
  if (box) box.hidden = false;
  if (name) { name.textContent = path.split(/[\\\\/]/).pop() || path; name.title = path; }
  if (!mpvViewer()) { mpvStatus('Model viewer unavailable.'); return; }
  mpvEnsureInit();
  mpvStatus('Loading…');
  vscodeApi.postMessage({ type: 'loadModel', path: path });
}
let mpvPlaying = true;
function hideModelPreview() {
  const box = document.getElementById('mpv-box');
  if (box) box.hidden = true;
  if (mpvViewer() && mpvInited) { try { mpvViewer().setAutoplay(false); } catch (e) {} }
  scheduleModelThumbQueues(0);
}
function mpvSetPlaying(on) {
  mpvPlaying = on;
  const v = mpvViewer();
  if (v && mpvInited) { try { v.setAutoplay(on); } catch (e) {} }
  const btn = document.getElementById('mpv-play');
  if (btn) { btn.textContent = on ? '⏸' : '▶'; btn.title = on ? 'Pause' : 'Play'; }
}
function mpvRestart() {
  const v = mpvViewer();
  if (!v || !mpvInited) return;
  const anim = document.getElementById('mpv-anim');
  try { v.setSequence(Number(anim && anim.value) || 0); v.setAutoplay(true); } catch (e) {}
  mpvSetPlaying(true);
}
(function () {
  const box = document.getElementById('mpv-box');
  const head = document.getElementById('mpv-head');
  const close = document.getElementById('mpv-close');
  const play = document.getElementById('mpv-play');
  const restart = document.getElementById('mpv-restart');
  const anim = document.getElementById('mpv-anim');
  if (close) close.addEventListener('click', hideModelPreview);
  if (play) play.addEventListener('click', () => mpvSetPlaying(!mpvPlaying));
  if (restart) restart.addEventListener('click', mpvRestart);
  if (anim) anim.addEventListener('change', () => { mpvRestart(); });
  // Drag the box by its header. Switches from the bottom-right dock to free positioning.
  if (head && box) {
    let dragging = false, ox = 0, oy = 0;
    head.addEventListener('pointerdown', e => {
      if (e.target.closest('button, select')) return; // don't start a drag from a control
      dragging = true;
      const r = box.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      box.style.right = 'auto'; box.style.bottom = 'auto';
      box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
      head.classList.add('dragging');
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', e => {
      if (!dragging) return;
      const w = box.offsetWidth, h = box.offsetHeight;
      const nx = Math.max(0, Math.min(window.innerWidth - w, e.clientX - ox));
      const ny = Math.max(0, Math.min(window.innerHeight - h, e.clientY - oy));
      box.style.left = nx + 'px'; box.style.top = ny + 'px';
    });
    const end = e => { if (dragging) { dragging = false; head.classList.remove('dragging'); try { head.releasePointerCapture(e.pointerId); } catch (x) {} } };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }
})();

// ── Asset browser (rich visual picker over WC3 game data, by category) ────────
let abMi = -1;
const abActiveTab = signal('model');
const abSearchQuery = signal('');
const abSourceFilter = signal('all');
let abCatalog = null; // { model: [], icon: [], pathing: [] } — fetched once from the host
function openAssetBrowser(mi) {
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!mod) return;
  abMi = mi;
  // A model field defaults to Models; only icon/pathing fields default elsewhere — never offer the
  // wrong asset class by default.
  abActiveTab.set((mod.assetType === 'icon' || mod.assetType === 'pathing') ? mod.assetType : 'model');
  abSearchQuery.set('');
  const search = document.getElementById('ab-search');
  if (search) search.value = '';
  const ov = document.getElementById('ab-overlay');
  if (ov) ov.hidden = false;
  if (abCatalog) {
    renderAssetGrid();
  } else {
    const grid = document.getElementById('ab-grid');
    if (grid) grid.innerHTML = '<div class="ab-empty">Loading game assets…</div>';
    vscodeApi.postMessage({ type: 'requestAssetCatalog' });
  }
  if (search) search.focus();
}

function openModelAssetBrowserForE2e() {
  abMi = 0;
  abActiveTab.set('model');
  abSearchQuery.set('');
  abSourceFilter.set('all');
  const search = document.getElementById('ab-search');
  if (search) search.value = '';
  const ov = document.getElementById('ab-overlay');
  if (ov) ov.hidden = false;
  if (abCatalog) {
    renderAssetGrid();
  } else {
    const grid = document.getElementById('ab-grid');
    if (grid) grid.innerHTML = '<div class="ab-empty">Loading game assets...</div>';
    vscodeApi.postMessage({ type: 'requestAssetCatalog' });
  }
}

function searchModelAssetBrowserForE2e(value) {
  abActiveTab.set('model');
  abSearchQuery.set(String(value || ''));
  const search = document.getElementById('ab-search');
  if (search) search.value = String(value || '');
  if (isAssetBrowserOpen() && abCatalog) renderAssetGrid();
}

function forceNarrowLayoutForE2e(on) {
  e2eForcedNarrowLayout = !!on;
  const editor = document.getElementById('object-editor');
  if (editor) editor.classList.toggle('narrow', !!on);
}

function updateAbTabs() {
  const tabs = document.getElementById('ab-tabs');
  if (!tabs) return;
  for (const b of tabs.querySelectorAll('.ab-tab')) b.classList.toggle('active', b.getAttribute('data-tab') === abActiveTab.get());
}
function renderAssetGrid() {
  const grid = document.getElementById('ab-grid');
  if (!grid) return;
  const activeTab = abActiveTab.get();
  const opts = (abCatalog && abCatalog[activeTab]) || [];
  const sourceFilter = abSourceFilter.get();
  const query = abSearchQuery.get().trim();
  const matches = [];
  let matchedCount = 0;
  for (const o of opts) {
    if (sourceFilter === 'import' && o.source !== 'import') continue;
    if (sourceFilter === 'wc3' && o.source === 'import') continue;
    if (query && !fuzzyMatch(query, o.label + ' ' + o.value + ' ' + (o.detail || ''))) continue;
    matchedCount++;
    if (matches.length < 600) matches.push(o);
  }
  const count = document.getElementById('ab-count');
  if (count) count.textContent = matches.length + (matchedCount > 600 ? '+' : '') + ' / ' + opts.length;
  if (!matches.length) { grid.innerHTML = '<div class="ab-empty">No matching assets</div>'; return; }
  grid.innerHTML = matches.map(o => {
    const icon = activeTab === 'model'
      ? '<span class="object-icon model-thumb pending" data-key="ab-model:' + esc(o.value) + '" data-model="' + esc(o.value) + '"></span>'
      : (o.iconPath
        ? '<span class="object-icon" data-key="ab:' + esc(o.value) + '" data-icon="' + esc(o.iconPath) + '"></span>'
        : '<span class="object-icon missing"></span>');
    return '<div class="ab-card" data-value="' + esc(o.value) + '" title="' + esc(o.label + ' — ' + o.value) + '">' +
      icon + '<span class="ab-card-label">' + esc(o.label) + '</span></div>';
  }).join('');
  iconLoader.observe(grid);
  observeModelThumbs(grid);
  requestAnimationFrame(() => requestVisibleModelThumbs(grid));
}
function closeAssetBrowser() {
  const ov = document.getElementById('ab-overlay');
  if (ov) ov.hidden = true;
  cancelAssetBrowserModelThumbs();
  abMi = -1; // keep abCatalog cached for next time
}
function pickAsset(value) {
  const mods = detailCache.get(selectedKey) || [];
  const mi = abMi;
  const mod = mods[mi];
  closeAssetBrowser();
  if (!mod) return;
  setModValue(mod, value);
  const anchor = details.querySelector('[data-mi="' + mi + '"]');
  if (anchor) markModified(anchor, mod);
  postEdit(mod);
  // Re-render the whole cell so the decorated value + model/icon badge (data-model-preview) reflect
  // the new pick. updateFieldCell only patches an open input's value, leaving the badge/preview stale.
  const cell = anchor ? anchor.closest('td') : null;
  if (cell) { cell._refocusOnCollapse = false; collapseCell(cell, mi); }
}
(function () {
  const ov = document.getElementById('ab-overlay');
  const search = document.getElementById('ab-search');
  const close = document.getElementById('ab-close');
  const grid = document.getElementById('ab-grid');
  const tabs = document.getElementById('ab-tabs');
  let abSearchRaf = 0;
  if (close) close.addEventListener('click', closeAssetBrowser);
  if (ov) ov.addEventListener('mousedown', e => { if (e.target === ov) closeAssetBrowser(); });
  if (search) search.addEventListener('input', () => {
    noteModelThumbUserActivity();
    if (abSearchRaf) cancelAnimationFrame(abSearchRaf);
    abSearchRaf = requestAnimationFrame(() => {
      abSearchRaf = 0;
      abSearchQuery.set(search.value);
    });
  });
  const source = document.getElementById('ab-source');
  if (source) source.addEventListener('change', () => abSourceFilter.set(source.value || 'all'));
  if (tabs) tabs.addEventListener('click', e => {
    const tab = e.target.closest('.ab-tab[data-tab]');
    if (!tab) return;
    if (abActiveTab.get() === 'model' && tab.getAttribute('data-tab') !== 'model') cancelAssetBrowserModelThumbs();
    abActiveTab.set(tab.getAttribute('data-tab'));
  });
  if (grid) grid.addEventListener('click', e => {
    const card = e.target.closest('.ab-card[data-value]');
    if (card) pickAsset(card.getAttribute('data-value'));
  });
  if (grid) {
    grid.addEventListener('scroll', noteModelThumbUserActivity, { passive: true });
    grid.addEventListener('wheel', noteModelThumbUserActivity, { passive: true });
    grid.addEventListener('pointerdown', noteModelThumbUserActivity, { passive: true });
  }
  if (search) {
    search.addEventListener('keydown', noteModelThumbUserActivity, { passive: true });
  }
  document.addEventListener('scroll', noteModelThumbUserActivity, { passive: true, capture: true });
  document.addEventListener('wheel', noteModelThumbUserActivity, { passive: true });
  document.addEventListener('keydown', noteModelThumbUserActivity, { passive: true });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov && !ov.hidden) closeAssetBrowser(); });
  effect(() => {
    abActiveTab.get();
    abSearchQuery.get();
    abSourceFilter.get();
    updateAbTabs();
    if (isAssetBrowserOpen() && abCatalog) renderAssetGrid();
  });
})();

// Forward undo/redo to the host (so the custom-document edit stack drives them) — except while a
// text field is focused, where the browser's native text undo should win.
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains('edit-raw')) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); vscodeApi.postMessage({ type: 'undo' }); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); vscodeApi.postMessage({ type: 'redo' }); }
});

function requestDetails(obj) {
  if (!obj || detailCache.has(obj.key) || pendingDetails.has(obj.key)) return;
  pendingDetails.add(obj.key);
  vscodeApi.postMessage({ type: 'loadObjectDetails', key: obj.key });
}

function renderDetails() {
  const obj = objects.find(candidate => candidate.key === selectedKey) || objects.find(matches) || objects[0];
  if (!obj) {
    details.innerHTML = '<div class="empty-state">No object modifications</div>';
    return;
  }
  selectedKey = obj.key;
  const headers = showTechnical
    ? (initial.extended ? ['Field', 'Label', 'Group', 'Type', 'Level', 'Data', 'Value'] : ['Field', 'Label', 'Group', 'Type', 'Value'])
    : ['Field', 'Value'];
  const mods = detailCache.get(obj.key);
  if (!mods) requestDetails(obj);
  let lastCategory = '';
  const rows = (mods || []).map((mod, mi) => {
    const category = categoryLabel(mod.category);
    const groupRow = category !== lastCategory
      ? '<tr class="category-row"><td colspan="' + headers.length + '">' + esc(category) + '</td></tr>'
      : '';
    lastCategory = category;
    const fieldCell = showTechnical
      ? '<td class="id">' + esc(mod.fieldId) + '</td><td class="label">' + esc(mod.label || '-') + '</td><td class="type">' + esc(category) + '</td><td class="type">' + esc(mod.type) + '</td>' +
        (initial.extended ? '<td class="num">' + esc(mod.level ?? '') + '</td>' + '<td class="num">' + esc(mod.dataPt ?? '') + '</td>' : '')
      : '<td class="field">' + esc(mod.label || mod.fieldId) + '</td>';
    const fsearch = esc(((mod.fieldId || '') + ' ' + (mod.label || '') + ' ' + (mod.currentValue || '') + ' ' + (mod.editValue || '') + ' ' + (mod.displayValue || '') + ' ' + (mod.displayDetail || '')).toLowerCase());
    return groupRow + '<tr class="' + (mod.overridden ? 'overridden' : '') + '" data-fsearch="' + fsearch + '">' +
      fieldCell +
      '<td class="value current">' + valueCell(mod, mi) + '</td>' +
    '</tr>';
  }).join('');

  const rawcode = obj.newId ? esc(obj.baseId) + ' → ' + esc(obj.newId) : esc(obj.baseId);
  details.innerHTML = '<div class="details-head">' +
    '<div class="details-title-row">' + objectIconHtml(obj, 'details-icon') +
      '<div class="details-title">' + esc(obj.displayName) +
        '<span class="details-rawcode">' + rawcode + '</span>' +
        (obj.displaySource ? sourcePill({ source: obj.displaySource }) : '') + '</div>' +
    '</div>' +
    (mods ? '<div class="field-search-wrap">' +
      '<input id="field-search" class="field-search" type="text" placeholder="Search fields…" aria-label="Search fields" spellcheck="false" value="' + esc(fieldQuery) + '">' +
      '<span id="field-match" class="field-match" role="status" aria-live="polite"></span>' +
      '<label class="toggle-chip"><input id="technical-toggle" type="checkbox" ' + (showTechnical ? 'checked' : '') + '> technical</label>' +
    '</div>' : '') +
  '</div>' +
  (mods
    ? '<div class="table-wrap"><table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="' + headers.length + '" class="empty">no modifications</td></tr>') + '</tbody></table></div>'
    : '<div class="details-loading"><div><div class="wv-spinner"></div><div class="wv-loading-text">Loading fields...</div></div></div>');

  const technicalToggle = document.getElementById('technical-toggle');
  if (technicalToggle) {
    technicalToggle.addEventListener('change', () => {
      showTechnical = technicalToggle.checked;
      vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { showTechnical: showTechnical }));
      renderDetails();
    });
  }

  const fieldSearch = document.getElementById('field-search');
  if (fieldSearch) {
    let fieldFilterRaf = 0;
    fieldSearch.addEventListener('input', () => {
      fieldQuery = fieldSearch.value;
      if (fieldFilterRaf) cancelAnimationFrame(fieldFilterRaf);
      fieldFilterRaf = requestAnimationFrame(() => {
        fieldFilterRaf = 0;
        filterFields(fieldQuery);
      });
    });
  }
  filterFields(fieldQuery);

  iconLoader.observe(details);
  observeModelThumbs(details);
}

// Delegated details handlers, wired once. The #details element persists across renders (only its
// innerHTML changes), so a single listener covers every collapsed cell and object-jump chip — no
// more re-wiring 1000+ listeners on each object switch / search / technical toggle.
function setupDetails() {
  details.addEventListener('click', e => {
    const jump = e.target.closest('.resolved-chip[data-jump]');
    if (jump) {
      const key = jump.getAttribute('data-jump') || '';
      if (key) { selectedKey = key; render(); }
      return;
    }
    const browse = e.target.closest('[data-browse]');
    if (browse) {
      e.stopPropagation();
      openAssetBrowser(Number(browse.getAttribute('data-browse')));
      return;
    }
    const modelPreview = e.target.closest('[data-model-preview]');
    if (modelPreview) {
      e.stopPropagation();
      showModelPreview(modelPreview.getAttribute('data-model-preview') || '');
      return;
    }
    const openAsset = e.target.closest('[data-open-asset]');
    if (openAsset) {
      e.stopPropagation();
      vscodeApi.postMessage({ type: 'openAsset', path: openAsset.getAttribute('data-open-asset') || '' });
      return;
    }
    const collapsed = e.target.closest('.tt-collapsed, .cell-edit');
    if (collapsed) expandEditor(collapsed);
  });
  // A focused collapsed cell expands on Enter/Space (matching its click affordance).
  details.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const ae = document.activeElement;
    if (ae && ae.classList && (ae.classList.contains('tt-collapsed') || ae.classList.contains('cell-edit'))) {
      e.preventDefault();
      expandEditor(ae);
    }
  });
}

function markModified(el, mod) {
  if (!mod.overridden) {
    mod.overridden = true;
    const tr = el.closest('tr');
    if (tr) tr.classList.add('overridden');
  }
}

function wireEditRaw(el) {
  const mi = Number(el.getAttribute('data-mi'));
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!mod) return;
  const startVal = mod.editValue == null ? '' : String(mod.editValue);
  let timer;
  let posted = false;
  const commit = () => { markModified(el, mod); postEdit(mod); posted = true; };
  const onEdit = () => {
    setModValue(mod, el.value);
    const preview = details.querySelector('.tt-preview[data-preview-for="' + mi + '"]');
    if (preview) preview.innerHTML = renderWc3Colors(el.value);
    clearTimeout(timer);
    // Only create/update a mod once the value actually changes (clicking a field to view it shouldn't modify it).
    if (el.value !== startVal || posted) timer = setTimeout(commit, 250);
  };
  el.addEventListener('input', onEdit);
  el.addEventListener('change', onEdit);
  el.addEventListener('blur', () => { clearTimeout(timer); if (el.value !== startVal || posted) commit(); });
  // Track selection so the toolbar / color picker act on it even after the textarea blurs.
  const saveSel = () => {
    if (typeof el.selectionStart !== 'number' || typeof el.selectionEnd !== 'number') return;
    el._ss = el.selectionStart; el._se = el.selectionEnd;
  };
  ['keyup', 'mouseup', 'select', 'blur', 'click'].forEach(ev => el.addEventListener(ev, saveSel));
}

function wireColorBar(bar) {
  const mi = bar.getAttribute('data-mi');
  const ta = details.querySelector('.edit-raw[data-mi="' + mi + '"]');
  if (!ta) return;
  const pop = bar.querySelector('.tt-pop');
  const sq = bar.querySelector('.tt-color-sq');
  if (sq) {
    sq.addEventListener('mousedown', e => e.preventDefault()); // keep textarea selection
    sq.addEventListener('click', () => { if (pop) pop.hidden = !pop.hidden; });
    sq.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (pop) pop.hidden = !pop.hidden; }
    });
  }
  if (pop) {
    for (const sw of pop.querySelectorAll('.tt-sw')) {
      sw.addEventListener('mousedown', e => e.preventDefault());
      sw.addEventListener('click', () => { wrapColor(ta, sw.getAttribute('data-color')); pop.hidden = true; });
    }
    const colorInput = pop.querySelector('.tt-color');
    if (colorInput) colorInput.addEventListener('change', () => { wrapColor(ta, colorInput.value); pop.hidden = true; });
  }
  for (const b of bar.querySelectorAll('.tt-btn-sm')) {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const act = b.getAttribute('data-act');
      if (act === 'newline') insertText(ta, '|n');
      else if (act === 'reset') insertText(ta, '|r');
    });
  }
}

// Swap a collapsed cell for its editor on demand. The editor collapses back when focus leaves it.
function expandEditor(c) {
  const mi = Number(c.getAttribute('data-mi'));
  const cell = c.parentElement;
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  cell.innerHTML = editorHtml(mod, mi);
  const ta = cell.querySelector('.edit-raw');
  if (ta) {
    wireEditRaw(ta);
    ta.focus();
    if (ta.tagName === 'INPUT' && ta.type !== 'number' && ta.setSelectionRange) ta.setSelectionRange(ta.value.length, ta.value.length);
    // Keyboard: Esc reverts and closes; Enter commits+closes (Ctrl/Cmd+Enter in the textarea).
    const original = mod.editValue == null ? '' : String(mod.editValue);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (ta.value !== original) { ta.value = original; ta.dispatchEvent(new Event('input')); }
        cell._refocusOnCollapse = true; // closed via keyboard → return focus to the cell
        ta.blur();
      } else if (e.key === 'Enter' && (ta.tagName === 'INPUT' || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        cell._refocusOnCollapse = true;
        ta.blur();
      }
    });
  }
  const bar = cell.querySelector('.tt-bar');
  if (bar) wireColorBar(bar);
  // Collapse back to the compact view once focus truly leaves this editor (not when clicking its own
  // color bar / popup / picker, which keep focus inside the cell). The handler is stored so collapseCell
  // can remove it — otherwise it would linger on the collapsed cell and stack on every re-expand.
  if (cell._collapseHandler) cell.removeEventListener('focusout', cell._collapseHandler);
  cell._collapseHandler = () => {
    setTimeout(() => {
      if (cell.isConnected && !cell.contains(document.activeElement)) collapseCell(cell, mi);
    }, 120);
  };
  cell.addEventListener('focusout', cell._collapseHandler);
}

function collapseCell(cell, mi) {
  const mods = detailCache.get(selectedKey) || [];
  const mod = mods[mi];
  if (!cell || !mod) return;
  if (cell._collapseHandler) { cell.removeEventListener('focusout', cell._collapseHandler); cell._collapseHandler = null; }
  cell.innerHTML = collapsedView(mod, mi);
  iconLoader.observe(cell);
  observeModelThumbs(cell);
  // When the editor was closed via keyboard (Esc/Enter), return focus to the collapsed cell so
  // keyboard users keep their place; on click-away the user already moved focus, so don't yank it back.
  if (cell._refocusOnCollapse) {
    cell._refocusOnCollapse = false;
    const el = cell.querySelector('.tt-collapsed, .cell-edit');
    if (el) el.focus();
  }
}

// Update a single field's cell in place (used by undo/redo — avoids rebuilding the whole table).
function updateFieldCell(mods, mod) {
  const mi = mods.indexOf(mod);
  if (mi < 0) return;
  const el = details.querySelector('.edit-raw[data-mi="' + mi + '"]');
  if (el) {
    el.value = mod.editValue == null ? '' : String(mod.editValue);
    const pv = details.querySelector('.tt-preview[data-preview-for="' + mi + '"]');
    if (pv) pv.innerHTML = renderWc3Colors(el.value);
    return;
  }
  const col = details.querySelector('.tt-collapsed[data-mi="' + mi + '"], .cell-edit[data-mi="' + mi + '"]');
  if (col && col.parentElement) {
    col.parentElement._refocusOnCollapse = false; // programmatic (undo/redo) collapse must not steal focus
    collapseCell(col.parentElement, mi);
  }
}

// Filter the details table rows by field id / label / value without rebuilding (keeps focus while typing).
let lastFieldFilterFirst = null;
function filterFields(q) {
  const query = String(q || '').trim().toLowerCase();
  const table = details.querySelector('table');
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  // Single pass: toggle field-row visibility and roll up each category's visible-child count at the
  // same time (was two full passes over a 700-row table on every keystroke).
  let shown = 0;
  let cat = null, catHasVisible = false;
  const flush = () => { if (cat) cat.classList.toggle('hidden', !catHasVisible); };
  rows.forEach(tr => {
    if (tr.classList.contains('category-row')) { flush(); cat = tr; catHasVisible = false; return; }
    const hay = tr.getAttribute('data-fsearch') || '';
    const vis = !query || fuzzyMatch(query, hay);
    tr.classList.toggle('hidden', !vis);
    if (vis) { shown++; catHasVisible = true; }
  });
  flush();
  const fm = document.getElementById('field-match');
  if (fm) fm.textContent = query ? (shown + ' match' + (shown === 1 ? '' : 'es')) : '';
  // Bring the first match into view while actively filtering (not on clear / initial render).
  if (query && shown > 0) {
    const first = table.querySelector('tbody tr:not(.hidden):not(.category-row)');
    if (first && first !== lastFieldFilterFirst) first.scrollIntoView({ block: 'nearest' });
    lastFieldFilterFirst = first;
  } else {
    lastFieldFilterFirst = null;
  }
}

function render() {
  renderTree();
  renderDetails();
}

let searchRaf = 0;
function applySearch() {
  searchRaf = 0;
  query = search.value.trim().toLowerCase();
  const matched = query ? objects.filter(matches).length : 0;
  const sm = document.getElementById('search-match');
  if (sm) sm.textContent = query ? (matched + ' of ' + objects.length) : '';
  const sc = document.getElementById('search-clear');
  if (sc) sc.classList.toggle('show', !!search.value);
  const selected = objects.find(obj => obj.key === selectedKey);
  if (selected && !matches(selected)) {
    selectedKey = (objects.find(matches) || objects[0] || {}).key || '';
  }
  render();
}
// Coalesce rapid keystrokes into one render per frame — typing stays smooth on large lists.
search.addEventListener('input', () => {
  if (searchRaf) cancelAnimationFrame(searchRaf);
  searchRaf = requestAnimationFrame(applySearch);
});
const searchClear = document.getElementById('search-clear');
if (searchClear) {
  searchClear.addEventListener('click', () => {
    search.value = '';
    applySearch();
    search.focus();
  });
}

(function setupSplitter() {
  const editor = document.getElementById('object-editor');
  const splitter = document.getElementById('splitter');
  if (!editor || !splitter) return;
  const isStacked = () => editor.classList.contains('narrow') || (window.matchMedia && window.matchMedia('(max-width: 720px)').matches);
  const applySavedWidth = () => {
    const saved = vscodeApi.getState() || {};
    if (isStacked()) editor.style.removeProperty('--list-w');
    else if (saved.listW) editor.style.setProperty('--list-w', saved.listW + 'px');
  };
  const saved = vscodeApi.getState() || {};
  if (saved.listW && !isStacked()) editor.style.setProperty('--list-w', saved.listW + 'px');
  window.addEventListener('resize', applySavedWidth);
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(entries => {
      const rect = entries[0] && entries[0].contentRect;
      if (!rect) return;
      editor.classList.toggle('narrow', e2eForcedNarrowLayout || rect.width <= 720);
      applySavedWidth();
    });
    ro.observe(editor);
  }
  let dragging = false;
  splitter.addEventListener('mousedown', e => {
    if (isStacked()) return;
    dragging = true;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const rect = editor.getBoundingClientRect();
    const max = Math.max(170, rect.width - 260);
    const w = Math.max(170, Math.min(max, e.clientX - rect.left));
    editor.style.setProperty('--list-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    const cur = parseInt(editor.style.getPropertyValue('--list-w'), 10) || 260;
    vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { listW: cur }));
  });
})();

// Close any open color popup when clicking outside its bar.
document.addEventListener('mousedown', e => {
  for (const pop of details.querySelectorAll('.tt-pop')) {
    if (pop.hidden) continue;
    const bar = pop.closest('.tt-bar');
    if (!bar || !bar.contains(e.target)) pop.hidden = true;
  }
});

setupTree();
setupDetails();
render();
setTimeout(() => { try { modelThumbEnsureInit(); } catch (e) {} }, 0);

window.__wurstModelThumbDebug = {
  openModelAssetBrowser: openModelAssetBrowserForE2e,
  searchModelAssetBrowser: searchModelAssetBrowserForE2e,
  forceNarrowLayout: forceNarrowLayoutForE2e,
  selectObject: function (rawcode) {
    const needle = String(rawcode || '').toLowerCase();
    const obj = objects.find(function (candidate) {
      return String(candidate.baseId || '').toLowerCase() === needle || String(candidate.newId || '').toLowerCase() === needle;
    });
    if (!obj) return false;
    selectObject(obj.key);
    return true;
  },
  layout: function () {
    const editor = document.getElementById('object-editor');
    const list = document.querySelector('.object-list');
    const det = document.getElementById('details');
    const rect = function (el) {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const er = rect(editor);
    const lr = rect(list);
    const dr = rect(det);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      editor: er,
      list: lr,
      details: dr,
      stacked: !!(lr && dr && dr.top >= lr.bottom - 1),
      listVisible: !!(lr && lr.width > 20 && lr.height > 20),
      detailsVisible: !!(dr && dr.width > 20 && dr.height > 20),
    };
  },
  detailsRows: function () {
    const mods = detailCache.get(selectedKey) || [];
    return mods.map(function (mod) {
      return {
        fieldId: mod.fieldId || '',
        label: mod.label || '',
        currentValue: mod.currentValue || '',
        baseValue: mod.baseValue || '',
        overrideValue: mod.overrideValue || '',
        overridden: !!mod.overridden,
        editable: !!mod.editable,
        level: mod.level == null ? null : mod.level,
        dataPt: mod.dataPt == null ? null : mod.dataPt,
        assetPath: mod.assetPath || '',
      };
    });
  },
  state: function () {
    const visible = Array.prototype.slice.call(document.querySelectorAll('.model-thumb[data-key]')).map(function (el, index) {
      return {
        index: index,
        key: el.getAttribute('data-key') || '',
        model: el.getAttribute('data-model') || '',
        pending: el.classList.contains('pending'),
        missing: el.classList.contains('missing'),
        reason: missingModelThumbReasons.get(el.getAttribute('data-key') || '') || null,
        loaded: !!el.querySelector('img'),
        visible: isModelThumbActuallyVisible(el),
      };
    });
    return {
      fileInfo: initial.fileInfo || null,
      selectedKey: selectedKey,
      selectedObject: objects.find(function (candidate) { return candidate.key === selectedKey; }) || null,
      assetBrowserOpen: isAssetBrowserOpen(),
      assetBrowserCount: document.querySelectorAll('#ab-grid .ab-card').length,
      assetCatalogLoaded: !!abCatalog,
      assetCatalogCounts: abCatalog ? {
        models: (abCatalog.model || []).length,
        icons: (abCatalog.icon || []).length,
        pathing: (abCatalog.pathing || []).length,
      } : null,
      inert3dPlaceholders: document.querySelectorAll('.object-icon.model').length,
      visible: visible,
      events: modelThumbEvents.slice(),
      requestQueue: modelThumbRequestQueue.map(function (req) { return req.key; }),
      renderQueue: modelThumbQueue.map(function (job) { return job.key; }),
      hostInflight: Array.from(modelThumbHostInflight),
      activeJob: modelThumbJob ? modelThumbJob.key : '',
      awaitingDecision: modelThumbAwaitingDecisionKey,
      loadedCount: loadedModelThumbs.size,
      missingCount: missingModelThumbs.size,
      pendingCount: pendingModelThumbs.size,
    };
  },
};
