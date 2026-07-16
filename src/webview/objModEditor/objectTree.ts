import { fuzzyMatch } from '../../features/preview/fuzzy';
import { esc } from '../objModWebviewUtils';
import { effect, untracked } from '../signals';
import { objects, tree, details, iconLoader, ui, collapsedNodes } from './state';
import { observeModelThumbs } from './modelThumbnails';
import { sourcePill } from './fieldDisplay';
import { hideModelPreview } from './modelPreviewPanel';

// Only the categories whose natural-case raw value doesn't already read fine capitalized (e.g. 'tech'
// isn't 'Techtree', '-' means unset). Anything else falls through to auto-capitalization below — no
// need to hand-maintain the full WC3 category vocabulary, which turned out to be bigger than expected
// (sound/pathing/editor-only categories exist beyond the common abil/art/combat/... set).
const CATEGORY_LABELS = {
  abil: 'Abilities',
  move: 'Movement',
  tech: 'Techtree',
  '-': 'Other'
};

export function categoryLabel(category) {
  const raw = String(category || 'Other');
  return CATEGORY_LABELS[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function categoryKey(category) {
  return String(category || '-').toLowerCase();
}

export function raceLabel(race) {
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

export function raceRank(race) {
  const order = ['human', 'orc', 'nightelf', 'undead', 'neutral', 'naga', 'demon', 'other'];
  const index = order.indexOf(String(race || 'other').toLowerCase());
  return index < 0 ? order.length : index;
}

const KNOWN_RACES = ['human', 'orc', 'nightelf', 'undead', 'neutral', 'naga', 'demon', 'other'];

// Typing a race name (or a fuzzy near-miss of one) in the object search finds every object of that
// race, not just ones whose own name/id happens to contain it — same convenience as the World
// Editor's race folders, but reachable from the search box.
//
// `matches()` below calls this once per object during a `.filter(matches)` pass, but the query is the
// same for every object in that pass — so the last {query, hits} pair is cached here (transparent to
// callers) instead of re-looping over KNOWN_RACES and re-running fuzzyMatch up to 8x per object.
let racesQueryCache: { query: string | null; hits: Set<string> } = { query: null, hits: new Set<string>() };
export function raceKeysMatchingQuery(query) {
  const q = String(query || '').trim().toLowerCase();
  if (racesQueryCache.query === q) return racesQueryCache.hits;
  const hits = new Set<string>();
  if (q) {
    for (const race of KNOWN_RACES) {
      const label = raceLabel(race).toLowerCase();
      if (race === q || label === q || race.startsWith(q) || label.startsWith(q) || fuzzyMatch(q, label)) hits.add(race);
    }
  }
  racesQueryCache = { query: q, hits };
  return hits;
}

const KIND_LABELS = { unit: 'Units', building: 'Buildings', hero: 'Heroes', special: 'Special' };
const KIND_ORDER = ['unit', 'building', 'hero', 'special'];

export function idLine(obj) {
  return obj.newId
    ? esc(obj.baseId) + ' -> ' + esc(obj.newId)
    : esc(obj.baseId);
}

export function objectIconHtml(obj, extraClass) {
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

// Ranked match: lower is better, -1 means no match. An exact/prefix hit on the rawcode id (what
// users usually paste in when hunting a specific object, e.g. "A0FY") always outranks a loose fuzzy
// hit on the longer display-name/source text — otherwise a 1-edit-distance fuzzy match elsewhere in
// that combined haystack can bury the object whose id you typed exactly.
export function matchScore(obj, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const base = String(obj.baseId || '').toLowerCase();
  const newId = String(obj.newId || '').toLowerCase();
  if (base === q || newId === q) return 0;
  if (base.startsWith(q) || newId.startsWith(q)) return 1;
  const name = String(obj.displayName || '').toLowerCase();
  if (name === q) return 2;
  if (name.startsWith(q)) return 3;
  if (name.includes(q) || base.includes(q) || newId.includes(q)) return 4;
  const haystack = [obj.displayName, obj.baseId, obj.newId, obj.displaySource, obj.group].filter(Boolean).join(' ');
  return fuzzyMatch(query, haystack) ? 5 : -1;
}

// A query matches an object either the normal way (id/name/source text) or by naming its race
// outright ("orc" pulls in every orc object, not just ones with "orc" literally in their name).
export function matches(obj) {
  if (!ui.query) return true;
  if (matchScore(obj, ui.query) >= 0) return true;
  return raceKeysMatchingQuery(ui.query).has(String(obj.race || 'other').toLowerCase());
}

function headingHtml(kindClass, key, label, count, closed) {
  return '<button class="' + kindClass + '-heading" type="button" data-node="' + esc(key) + '" aria-expanded="' + (closed ? 'false' : 'true') + '">' +
    '<span class="twisty">' + (closed ? '&gt;' : 'v') + '</span>' +
    '<span>' + esc(label) + '</span><span class="folder-count">' + count + '</span></button>';
}

// The browse tree always keeps its full Group > Race [> Melee|Campaign > Units/Buildings/Heroes/
// Special] shape, whether searching or not — only *emptied-out* branches disappear (per-node counts
// reflect what's left). Manual collapse/expand state (collapsedNodes) is respected exactly the same
// as when not searching — a heading a user collapsed stays collapsed, still showing its filtered count,
// so it can be expanded or re-collapsed same as always instead of being forced open by the search.
// Reassigning tree.innerHTML (below) destroys and recreates every row, which resets scrollTop to 0 in
// every browser — so every render (not just the first) has to explicitly carry it forward. `false`
// until the first render so that one restores the persisted position (see state.ts's treeScrollTop)
// instead of the live (always-0, nothing painted yet) tree.scrollTop.
let treeRenderedOnce = false;

export function renderTree() {
  const scrollTop = treeRenderedOnce ? tree.scrollTop : ui.treeScrollTop;
  treeRenderedOnce = true;
  const searching = !!ui.query;
  const visible = searching ? objects.filter(matches) : objects;
  if (searching && !visible.length) {
    tree.innerHTML = '<div class="empty-state">No objects match &ldquo;' + esc(ui.query) + '&rdquo;.<br>Try a different term, or a race name like &ldquo;orc&rdquo;.</div>';
    tree.scrollTop = scrollTop;
    return;
  }

  const groups = ['Original', 'Custom'];
  // Single bucketing pass over `visible` instead of a cascading `.filter()` at each tree level (group ->
  // race -> campaign -> kind) — the old version rescanned its parent array at every level, which on a
  // large .w3u file (600+ objects) multiplies out across all four nesting depths on every keystroke.
  const raceBucketsByGroup = new Map(); // group -> Map<race, { all: obj[], camp: Map<campToken, Map<kind, obj[]>> }>
  for (const group of groups) raceBucketsByGroup.set(group, new Map());
  for (const obj of visible) {
    const raceBuckets = raceBucketsByGroup.get(obj.group);
    if (!raceBuckets) continue; // group isn't 'Original'/'Custom' — excluded, same as the old .filter()
    const race = obj.race || 'other';
    let bucket = raceBuckets.get(race);
    if (!bucket) { bucket = { all: [], camp: new Map() }; raceBuckets.set(race, bucket); }
    bucket.all.push(obj);
    if (obj.kind !== undefined) {
      const campToken = obj.campaign ? 'campaign' : 'melee';
      let campMap = bucket.camp.get(campToken);
      if (!campMap) { campMap = new Map(); bucket.camp.set(campToken, campMap); }
      let kindArr = campMap.get(obj.kind);
      if (!kindArr) { kindArr = []; campMap.set(obj.kind, kindArr); }
      kindArr.push(obj);
    }
  }

  let html = '';
  for (const group of groups) {
    const raceBuckets = raceBucketsByGroup.get(group);
    let groupCount = 0;
    for (const bucket of raceBuckets.values()) groupCount += bucket.all.length;
    if (!groupCount) continue;
    const groupKey = 'group:' + group;
    const groupClosed = collapsedNodes.has(groupKey);
    html += headingHtml('group', groupKey, group + ' Objects', groupCount, groupClosed);
    if (groupClosed) continue;

    const races = Array.from(raceBuckets.keys())
      .sort((a, b) => raceRank(a) - raceRank(b) || raceLabel(a).localeCompare(raceLabel(b)));
    for (const race of races) {
      const bucket = raceBuckets.get(race);
      const raceObjects = bucket.all;
      const raceKey = 'race:' + group + ':' + race;
      const raceClosed = collapsedNodes.has(raceKey);
      html += headingHtml('race', raceKey, raceLabel(race), raceObjects.length, raceClosed);
      if (raceClosed) continue;

      // World Editor-style subgrouping only applies where buildObject computed a `kind` for these
      // objects (units files) — every object in a document shares the same ext, so checking one is enough.
      if (raceObjects[0].kind === undefined) {
        for (const obj of raceObjects) html += objectRowReplacementHtml(obj);
        continue;
      }
      for (const isCampaign of [false, true]) {
        const campToken = isCampaign ? 'campaign' : 'melee';
        const campMap = bucket.camp.get(campToken);
        if (!campMap) continue;
        let campCount = 0;
        for (const arr of campMap.values()) campCount += arr.length;
        if (!campCount) continue;
        const campKey = 'camp:' + group + ':' + race + ':' + campToken;
        const campClosed = collapsedNodes.has(campKey);
        html += headingHtml('camp', campKey, isCampaign ? 'Campaign' : 'Melee', campCount, campClosed);
        if (campClosed) continue;
        for (const kind of KIND_ORDER) {
          const kindObjects = campMap.get(kind);
          if (!kindObjects || !kindObjects.length) continue;
          const kindKey = 'kind:' + group + ':' + race + ':' + campToken + ':' + kind;
          const kindClosed = collapsedNodes.has(kindKey);
          html += headingHtml('kind', kindKey, KIND_LABELS[kind], kindObjects.length, kindClosed);
          if (kindClosed) continue;
          for (const obj of kindObjects) html += objectRowReplacementHtml(obj);
        }
      }
    }
  }
  tree.innerHTML = html || '<div class="empty-state">No objects</div>';
  tree.scrollTop = scrollTop;
  iconLoader.observe(tree);
  observeModelThumbs(tree);
}

// Move the selection highlight in place — rebuilding the whole tree (hundreds of rows) just to shift
// one '.active' class made object switching feel sluggish on large .w3a files.
export function objectRowReplacementHtml(obj) {
  // Read untracked: selection changes move the '.active' class via setActiveRow() instead of a full
  // tree rebuild (see selectObject), so renderTree()'s reactive effect must NOT re-run just because
  // the selected object changed — only because the query or collapse state changed.
  const active = obj.key === untracked(() => ui.selectedKey) ? ' active' : '';
  // Objects with a `kind` (units files — see buildObject) always render nested one level deeper, under
  // a kind-heading (Units/Buildings/Heroes/Special), whether in the grouped browse tree or a solo
  // row-refresh — so this can key off the object alone rather than needing render-context passed in.
  const nested = obj.kind !== undefined ? ' nested' : '';
  const source = obj.displaySource ? ' <span class="source-pill">' + esc(obj.displaySource) + '</span>' : '';
  const label = obj.displayName + ' - ' + (obj.newId ? obj.baseId + ' to ' + obj.newId : obj.baseId);
  return '<button class="object-row' + active + nested + '" type="button" data-key="' + esc(obj.key) + '" aria-label="' + esc(label) + '">' +
    objectIconHtml(obj, '') +
    '<span class="object-main"><span class="object-name" title="' + esc(obj.displayName) + '">' + esc(obj.displayName) + source + '</span>' +
    '<span class="object-id">' + idLine(obj) + '</span></span>' +
    '</button>';
}

export function updateObjectRow(obj) {
  const row = tree.querySelector('.object-row[data-key="' + obj.key + '"]');
  if (!row) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = objectRowReplacementHtml(obj);
  const next = wrap.firstElementChild;
  if (!next) return;
  row.replaceWith(next);
  iconLoader.observe(next);
}

export function updateDetailsHeader(obj) {
  if (obj.key !== ui.selectedKey) return;
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

export function setActiveRow(key) {
  for (const el of tree.querySelectorAll('.object-row.active')) el.classList.remove('active');
  // Keys are trusted 'Group:Index' strings (no quotes/backslashes) so a literal attribute match is safe.
  const row = tree.querySelector('.object-row[data-key="' + key + '"]');
  if (row) row.classList.add('active');
  return row;
}

export function selectObject(key) {
  if (!key) return;
  // Writing the signal is enough to drive the details panel — see the renderDetails effect wired in
  // setupDetails() (detailsPanel.ts), which reacts to ui.selectedKey automatically. The tree itself
  // deliberately stays untracked of selection (see objectRowReplacementHtml) for perf on large trees,
  // so the highlight still needs this explicit, cheap DOM update.
  ui.selectedKey = key;
  setActiveRow(key);
  hideModelPreview(); // the open preview belongs to the previous object — don't leave it stale
}

// Delegated tree handlers, wired once — survive innerHTML rebuilds, no per-row listener churn.
export function setupTree() {
  // Reactive browse tree: rebuilds whenever the search query or the collapse state changes. Runs
  // immediately on creation (this is the tree's first paint), so no separate bootstrap call is needed.
  effect(() => {
    ui.query;
    collapsedNodes.version;
    renderTree();
  }, 'objectTree.renderTree');

  tree.addEventListener('click', e => {
    const heading = e.target.closest('.group-heading, .race-heading, .camp-heading, .kind-heading');
    if (heading) {
      const key = heading.getAttribute('data-node') || '';
      if (key) { if (collapsedNodes.has(key)) collapsedNodes.delete(key); else collapsedNodes.add(key); }
      return;
    }
    const row = e.target.closest('.object-row');
    if (row) selectObject(row.getAttribute('data-key') || ui.selectedKey);
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
  // Keep ui.treeScrollTop live so a reopen (or our external-change auto-reload) restores roughly where
  // the user was browsing — the persistUi effect in state.ts picks this up like every other field.
  // rAF-coalesced: scroll fires continuously while dragging the scrollbar/wheeling.
  let treeScrollRaf = 0;
  tree.addEventListener('scroll', () => {
    if (treeScrollRaf) cancelAnimationFrame(treeScrollRaf);
    treeScrollRaf = requestAnimationFrame(() => {
      treeScrollRaf = 0;
      ui.treeScrollTop = tree.scrollTop;
    });
  }, { passive: true });
}
