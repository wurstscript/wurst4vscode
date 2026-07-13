// @ts-nocheck
import { createIconLoader } from '../objModIconLoader';

declare const acquireVsCodeApi: any;

export const initial = window.__OBJMOD_INITIAL__ || { objects: [], selectedKey: "", extended: false };
export const objects = initial.objects || [];

export const vscodeApi = acquireVsCodeApi();
export const iconLoader = createIconLoader(vscodeApi);

export const detailCache = new Map();
export const pendingDetails = new Set();
export const collapsedGroups = new Set();
export const collapsedRaces = new Set();
// Keys whose field-row load failed on the host (missing game data, thrown parser error, etc). Kept
// separate from detailCache so a failed load renders a distinct "couldn't load, retry" state instead
// of silently looking identical to "this object genuinely has zero fields".
export const failedDetails = new Map();

export const tree = document.getElementById('tree');
export const details = document.getElementById('details');
export const search = document.getElementById('search');

// Cross-cutting state that's reassigned (not just mutated) from more than one module. Real ES module
// bindings are read-only, so these live on a shared mutable object instead of plain module-scope `let`s.
export const ui = {
  selectedKey: initial.selectedKey || "",
  query: '',
  fieldQuery: '',
  showTechnical: !!((vscodeApi.getState() || {}).showTechnical),
  // Field categories hidden from the details table (the "focus on tooltips" custom view). Persisted
  // across objects/sessions like showTechnical.
  hiddenCategories: new Set((vscodeApi.getState() || {}).hiddenCategories || []),
  e2eForcedNarrowLayout: false,
};
