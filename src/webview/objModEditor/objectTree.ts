// @ts-nocheck
import { fuzzyMatch } from '../../features/preview/fuzzy';
import { esc } from '../objModWebviewUtils';
import { objects, tree, details, iconLoader, ui, collapsedGroups, collapsedRaces } from './state';
import { observeModelThumbs } from './modelThumbnails';
import { sourcePill } from './fieldDisplay';
import { renderDetails } from './detailsPanel';
import { hideModelPreview } from './modelPreviewPanel';

export function categoryLabel(category) {
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

export function matches(obj) {
  if (!ui.query) return true;
  const haystack = [obj.displayName, obj.baseId, obj.newId, obj.displaySource, obj.group].filter(Boolean).join(' ');
  return fuzzyMatch(ui.query, haystack);
}

export function renderTree() {
  const groups = ['Original', 'Custom'];
  let html = '';
  const allowCollapse = !ui.query;
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
        const active = obj.key === ui.selectedKey ? ' active' : '';
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
  tree.innerHTML = html || (ui.query
    ? '<div class="empty-state">No objects match &ldquo;' + esc(ui.query) + '&rdquo;.<br>Try a different term or clear the search.</div>'
    : '<div class="empty-state">No objects</div>');
  iconLoader.observe(tree);
  observeModelThumbs(tree);
}

// Move the selection highlight in place — rebuilding the whole tree (hundreds of rows) just to shift
// one '.active' class made object switching feel sluggish on large .w3a files.
export function objectRowReplacementHtml(obj) {
  const active = obj.key === ui.selectedKey ? ' active' : '';
  const source = obj.displaySource ? ' <span class="source-pill">' + esc(obj.displaySource) + '</span>' : '';
  const label = obj.displayName + ' - ' + (obj.newId ? obj.baseId + ' to ' + obj.newId : obj.baseId);
  return '<button class="object-row' + active + '" type="button" data-key="' + esc(obj.key) + '" aria-label="' + esc(label) + '">' +
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
  ui.selectedKey = key;
  setActiveRow(key);
  renderDetails();
  hideModelPreview(); // the open preview belongs to the previous object — don't leave it stale
}

// Delegated tree handlers, wired once — survive innerHTML rebuilds, no per-row listener churn.
export function setupTree() {
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
}

export function render() {
  renderTree();
  renderDetails();
}
