// @ts-nocheck
import { createIconLoader } from '../objModIconLoader';
import { effect, signal } from '../signals';

declare const acquireVsCodeApi: any;

export const initial = window.__OBJMOD_INITIAL__ || { objects: [], selectedKey: "", extended: false };
export const objects = initial.objects || [];

export const vscodeApi = acquireVsCodeApi();
export const iconLoader = createIconLoader(vscodeApi);

export const detailCache = new Map();
export const pendingDetails = new Set();

// Everything below is restored from vscodeApi's per-document persisted state (survives a webview
// reload — including our own external-change auto-reload/revert, see objModPreview.ts — and a full
// VS Code restart) so reopening a file doesn't dump the user back to a blank slate: same object
// selected, same search text, same collapsed tree branches, same category/technical/density filters.
const persisted = vscodeApi.getState() || {};

// A Set whose mutations bump a signal, so an effect that reads `.version` (once, anywhere in its run)
// gets re-run whenever the set's membership changes — without every consumer having to switch from
// `.has()`/`.add()`/`.delete()` to signal `.value` reads/writes.
function reactiveSet(initialValues) {
  const version = signal(0);
  const set = new Set(initialValues);
  return {
    has: v => set.has(v),
    add: v => { if (!set.has(v)) { set.add(v); version.value++; } },
    delete: v => { const had = set.delete(v); if (had) version.value++; return had; },
    clear: () => { if (set.size) { set.clear(); version.value++; } },
    get size() { return set.size; },
    [Symbol.iterator]: () => set[Symbol.iterator](),
    get version() { return version.value; },
  };
}

// Collapse state for every browse-tree heading (group/race/campaign/kind), keyed by that node's own
// path string (see nodeKey() in objectTree.ts) — one Set instead of one per tree level, since the
// tree can now be up to 4 levels deep (Group > Race > Melee|Campaign > Units/Buildings/Heroes/Special).
export const collapsedNodes = reactiveSet(Array.isArray(persisted.collapsedNodes) ? persisted.collapsedNodes : []);
// Keys whose field-row load failed on the host (missing game data, thrown parser error, etc). Kept
// separate from detailCache so a failed load renders a distinct "couldn't load, retry" state instead
// of silently looking identical to "this object genuinely has zero fields".
export const failedDetails = new Map();

export const tree = document.getElementById('tree');
export const details = document.getElementById('details');
export const search = document.getElementById('search');

// A cross-file rawcode jump (see locateObjectAcrossSiblings in objModPreview.ts) always wins over a
// restored selection — the user just asked to look at a specific object, so honor that over whatever
// was open last time. Otherwise prefer the restored key, falling back to it only if that object still
// exists in this file (it may have been deleted by an edit made elsewhere since).
const restoredSelectedKey = typeof persisted.selectedKey === 'string' && objects.some(obj => obj.key === persisted.selectedKey)
  ? persisted.selectedKey
  : '';
const initialSelectedKey = initial.isPendingJump ? initial.selectedKey : (restoredSelectedKey || initial.selectedKey || '');

// Cross-cutting state that's reassigned (not just mutated) from more than one module. Real ES module
// bindings are read-only, so these live on a shared mutable object instead of plain module-scope `let`s.
//
// Each field is backed by a signal (src/webview/signals.ts) via a get/set accessor, so `ui.selectedKey = x`
// keeps working unchanged at every call site while making the field a real reactive primitive: a `computed`
// or `effect` elsewhere can read `ui.selectedKey` and stay in sync automatically instead of relying on
// every writer to remember to call the right render function. The underlying signals are module-private
// (not exported) — every consumer goes through the `ui.*` accessors below, never the raw signal.
const selectedKeySignal = signal(initialSelectedKey);
const querySignal = signal(typeof persisted.query === 'string' ? persisted.query : '');
const fieldQuerySignal = signal(typeof persisted.fieldQuery === 'string' ? persisted.fieldQuery : '');
const showTechnicalSignal = signal(!!persisted.showTechnical);
const hideEmptySignal = signal(!!persisted.hideEmpty);
const hideUnmodifiedSignal = signal(!!persisted.hideUnmodified);
// Only consulted once, to restore scroll position on the tree's first paint (see renderTree() in
// objectTree.ts) — every scroll after that just updates this via the listener in setupTree(), which
// the persistUi effect below picks up like every other field.
const treeScrollTopSignal = signal(typeof persisted.treeScrollTop === 'number' ? persisted.treeScrollTop : 0);
// Same idea, for the field table's own scroll container (.table-wrap, inside #details) — see
// renderDetails() in detailsPanel.ts. Unlike the tree, this one only applies on the very first paint:
// switching objects afterward should reset to the top of the new object's fields, not inherit whatever
// the previous object happened to be scrolled to.
const detailsScrollTopSignal = signal(typeof persisted.detailsScrollTop === 'number' ? persisted.detailsScrollTop : 0);
const e2eForcedNarrowLayoutSignal = signal(false);

export const ui = {
  get selectedKey() { return selectedKeySignal.value; },
  set selectedKey(v) { selectedKeySignal.value = v; },
  get query() { return querySignal.value; },
  set query(v) { querySignal.value = v; },
  get fieldQuery() { return fieldQuerySignal.value; },
  set fieldQuery(v) { fieldQuerySignal.value = v; },
  get showTechnical() { return showTechnicalSignal.value; },
  set showTechnical(v) { showTechnicalSignal.value = v; },
  // Field categories hidden from the details table (the "focus on tooltips" custom view). Persisted
  // across objects/sessions like showTechnical. Reactive like `collapsedNodes` above.
  hiddenCategories: reactiveSet(Array.isArray(persisted.hiddenCategories) ? persisted.hiddenCategories : []),
  // Density/noise filters for the field table — hide blank fields, or hide everything but overridden
  // (customized) ones. Persisted like showTechnical.
  get hideEmpty() { return hideEmptySignal.value; },
  set hideEmpty(v) { hideEmptySignal.value = v; },
  get hideUnmodified() { return hideUnmodifiedSignal.value; },
  set hideUnmodified(v) { hideUnmodifiedSignal.value = v; },
  get treeScrollTop() { return treeScrollTopSignal.value; },
  set treeScrollTop(v) { treeScrollTopSignal.value = v; },
  get detailsScrollTop() { return detailsScrollTopSignal.value; },
  set detailsScrollTop(v) { detailsScrollTopSignal.value = v; },
  get e2eForcedNarrowLayout() { return e2eForcedNarrowLayoutSignal.value; },
  set e2eForcedNarrowLayout(v) { e2eForcedNarrowLayoutSignal.value = v; },
};

// One place that persists every restorable field above, instead of every mutation site remembering to
// call vscodeApi.setState itself — write it here once and every future reactive field is covered for
// free. Merges onto whatever's already persisted (e.g. the splitter width in objModEditorWebview.ts)
// rather than replacing it outright.
effect(() => {
  const collapsed = Array.from(collapsedNodes);
  const hiddenCategories = Array.from(ui.hiddenCategories);
  collapsedNodes.version; // tracked: re-persist when a tree branch is collapsed/expanded
  ui.hiddenCategories.version; // tracked: re-persist when the category filter changes
  vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, {
    selectedKey: ui.selectedKey,
    query: ui.query,
    fieldQuery: ui.fieldQuery,
    showTechnical: ui.showTechnical,
    hideEmpty: ui.hideEmpty,
    hideUnmodified: ui.hideUnmodified,
    treeScrollTop: ui.treeScrollTop,
    detailsScrollTop: ui.detailsScrollTop,
    collapsedNodes: collapsed,
    hiddenCategories: hiddenCategories,
  }));
}, 'state.persistUi');
