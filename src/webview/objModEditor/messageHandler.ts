// @ts-nocheck
import { details, detailCache, pendingDetails, failedDetails, objects, ui, iconLoader } from './state';
import { setModValue } from './fieldDisplay';
import { renderDetails, updateFieldCell } from './detailsPanel';
import { updateObjectRow, updateDetailsHeader, render, renderTree } from './objectTree';
import {
  completeModelThumbHostRequest,
  pendingModelThumbs,
  loadedModelThumbs,
  missingModelThumbs,
  missingModelThumbReasons,
  updateModelThumbElements,
  setModelThumbLoaded,
  setModelThumbQueuedOrCancelled,
  recordModelThumbEvent,
  clearAwaitingDecisionKey,
  scheduleModelThumbQueues,
  markModelThumbMissing,
  isAssetBrowserModelKey,
  isAssetBrowserOpen,
  hasVisibleModelThumbElement,
  nextModelThumbSeq,
  modelThumbQueue,
  handleMdxTextureMessage,
} from './modelThumbnails';
import { mpvViewer, mpvB64ToArrayBuffer } from './modelViewerShared';
import { mpvStatus, mpvSetPlaying } from './modelPreviewPanel';
import { setAssetCatalog, renderAssetGrid, handleAssetCatalogFailed } from './assetBrowser';

export function setupMessageHandler() {
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
      clearAwaitingDecisionKey(msg.key);
      scheduleModelThumbQueues(0);
    } else if (msg.type === 'modelThumbMissing') {
      completeModelThumbHostRequest(msg.key);
      markModelThumbMissing(msg.key, {
        reason: msg.reason || 'missing',
        bytes: msg.bytes,
        maxBytes: msg.maxBytes,
      });
      recordModelThumbEvent('missing', msg.key, { reason: msg.reason || 'missing' });
      clearAwaitingDecisionKey(msg.key);
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
        msg.seq = nextModelThumbSeq();
        modelThumbQueue.push(msg);
        recordModelThumbEvent('render-enqueued', msg.key);
        scheduleModelThumbQueues(0);
      }
    } else if (msg.type === 'objectDetailsLoaded') {
      pendingDetails.delete(msg.key);
      failedDetails.delete(msg.key);
      detailCache.set(msg.key, msg.mods || []);
      if (msg.key === ui.selectedKey) renderDetails();
    } else if (msg.type === 'objectDetailsFailed') {
      pendingDetails.delete(msg.key);
      failedDetails.set(msg.key, msg.reason || '');
      if (msg.key === ui.selectedKey) renderDetails();
    } else if (msg.type === 'invalidateDetails') {
      detailCache.delete(msg.key);
      pendingDetails.delete(msg.key);
      failedDetails.delete(msg.key);
      if (msg.key === ui.selectedKey) renderDetails();
    } else if (msg.type === 'fieldUpdated') {
      const mods = detailCache.get(msg.key);
      if (!mods) return;
      const norm = v => (v == null ? null : v);
      const mod = mods.find(m => m.fieldId && m.fieldId.toLowerCase() === String(msg.fieldId).toLowerCase() &&
        norm(m.level) === norm(msg.level) && norm(m.dataPt) === norm(msg.dataPt));
      if (!mod) return;
      setModValue(mod, msg.editValue);
      if (msg.overridden != null) mod.overridden = msg.overridden;
      if (msg.key === ui.selectedKey) {
        const mi = mods.indexOf(mod);
        const anchor = details.querySelector('[data-mi="' + mi + '"]');
        const tr = anchor && anchor.closest('tr');
        if (tr) tr.classList.toggle('overridden', !!mod.overridden);
        updateFieldCell(mods, mod);
      }
    } else if (msg.type === 'selectObject' && msg.key) {
      // Cross-file rawcode jump landed on this already-open editor (see openObjectReference in
      // objModPreview.ts) — switch straight to the target object, same as clicking it in the tree.
      ui.selectedKey = msg.key;
      render();
    } else if (msg.type === 'objectUpdated' && msg.object && msg.object.key) {
      const index = objects.findIndex(obj => obj.key === msg.object.key);
      if (index < 0) return;
      const oldIcon = objects[index].iconPath || '';
      // Campaign/kind/race decide which tree branch this row lives under (see renderTree) — if editing
      // pushed it into a different branch, an in-place row swap would leave it under the wrong heading
      // until the next full render, so rebuild the tree instead of just patching this one row.
      const oldBranch = objects[index].race + ':' + objects[index].campaign + ':' + objects[index].kind;
      Object.assign(objects[index], msg.object);
      const newBranch = objects[index].race + ':' + objects[index].campaign + ':' + objects[index].kind;
      if (oldIcon !== (objects[index].iconPath || '')) {
        iconLoader.clearPrefix(objects[index].key + ':icon:');
      }
      if (oldBranch !== newBranch) renderTree();
      else updateObjectRow(objects[index]);
      updateDetailsHeader(objects[index]);
    } else if (msg.type === 'dirtyStateChanged') {
      const badge = document.getElementById('editable-badge');
      if (badge) {
        badge.classList.toggle('dirty', !!msg.isDirty);
        badge.textContent = msg.isDirty ? '● unsaved' : 'editable';
        badge.title = msg.isDirty
          ? 'Unsaved changes — click or Ctrl+S to save.'
          : 'Existing overrides can be edited. Click or Ctrl+S to save.';
      }
    } else if (msg.type === 'mdxModel') {
      mpvStatus('');
      if (mpvViewer()) { mpvViewer().loadModel(mpvB64ToArrayBuffer(msg.mdxBase64), msg.fileName || '', msg.format || 'mdx'); mpvSetPlaying(true); }
    } else if (msg.type === 'assetCatalog') {
      setAssetCatalog({ model: msg.models || [], icon: msg.icons || [], sound: msg.sounds || [], pathing: msg.pathing || [] });
      const ov = document.getElementById('ab-overlay');
      if (ov && !ov.hidden) renderAssetGrid();
    } else if (msg.type === 'assetCatalogFailed') {
      handleAssetCatalogFailed(msg.reason || '');
    } else if (msg.type === 'mdxModelMissing') {
      mpvStatus('Not found in map or game files:\\n' + (msg.path || '') + '\\n(tried .mdx/.mdl — see "Log (Extension Host)" for CASC details)');
    } else if (msg.type === 'mdxTexture') {
      handleMdxTextureMessage(msg);
    }
  });
}
