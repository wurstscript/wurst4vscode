// @ts-nocheck
import { initial, objects, detailCache, ui } from './state';
import { selectObject } from './objectTree';
import { openModelAssetBrowserForE2e, searchModelAssetBrowserForE2e, forceNarrowLayoutForE2e, getAssetCatalog } from './assetBrowser';
import {
  missingModelThumbReasons,
  isModelThumbActuallyVisible,
  isAssetBrowserOpen,
  modelThumbEvents,
  modelThumbRequestQueue,
  modelThumbQueue,
  modelThumbHostInflight,
  getActiveModelThumbJobKey,
  getAwaitingDecisionKey,
  loadedModelThumbs,
  missingModelThumbs,
  pendingModelThumbs,
} from './modelThumbnails';

export function installDebugApi() {
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
      const mods = detailCache.get(ui.selectedKey) || [];
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
        selectedKey: ui.selectedKey,
        selectedObject: objects.find(function (candidate) { return candidate.key === ui.selectedKey; }) || null,
        assetBrowserOpen: isAssetBrowserOpen(),
        assetBrowserCount: document.querySelectorAll('#ab-grid .ab-card').length,
        assetCatalogLoaded: !!getAssetCatalog(),
        assetCatalogCounts: getAssetCatalog() ? {
          models: (getAssetCatalog().model || []).length,
          icons: (getAssetCatalog().icon || []).length,
          sounds: (getAssetCatalog().sound || []).length,
          pathing: (getAssetCatalog().pathing || []).length,
        } : null,
        inert3dPlaceholders: document.querySelectorAll('.object-icon.model').length,
        visible: visible,
        events: modelThumbEvents.slice(),
        requestQueue: modelThumbRequestQueue.map(function (req) { return req.key; }),
        renderQueue: modelThumbQueue.map(function (job) { return job.key; }),
        hostInflight: Array.from(modelThumbHostInflight),
        activeJob: getActiveModelThumbJobKey(),
        awaitingDecision: getAwaitingDecisionKey(),
        loadedCount: loadedModelThumbs.size,
        missingCount: missingModelThumbs.size,
        pendingCount: pendingModelThumbs.size,
      };
    },
  };
}
