// @ts-nocheck
import { base64ToBytes } from '../objModWebviewUtils';
import { details, detailCache, pendingDetails, failedDetails, objects, ui, iconLoader } from './state';
import { setModValue } from './fieldDisplay';
import { renderDetails, updateFieldCell } from './detailsPanel';
import { updateObjectRow, updateDetailsHeader, selectObject, renderTree } from './objectTree';
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

// The in-game tooltip fill texture (see requestTooltipBackdrop in imageAssetSupport.ts) — decoded once
// into a data URL and set as a CSS var, so every tooltip preview box picks it up for free via the
// `background-image: var(--wc3-tip-bg-image, none)` fallback chain already in its CSS. Left unset
// (falling through to the plain --wc3-tip-bg color) if the game data can't be found.
function applyTooltipBackdrop(msg) {
  try {
    if (msg.mode !== 'rgba' || !msg.rgbaBase64 || !msg.width || !msg.height) {
      console.error('[wurst-tooltip-backdrop] malformed tooltipBackdropLoaded message', msg);
      return;
    }
    const rgba = base64ToBytes(msg.rgbaBase64);
    const canvas = document.createElement('canvas');
    canvas.width = msg.width;
    canvas.height = msg.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), msg.width, msg.height), 0, 0);
    document.documentElement.style.setProperty('--wc3-tip-bg-image', 'url(' + canvas.toDataURL('image/png') + ')');
    console.log('[wurst-tooltip-backdrop] applied', msg.width, 'x', msg.height);
  } catch (err) {
    // Leave --wc3-tip-bg-image unset — the plain --wc3-tip-bg color fallback already covers this.
    console.error('[wurst-tooltip-backdrop] failed to apply', err);
  }
}

// Copies one 16x16 tile out of the wider tile-strip atlas (see TOOLTIP_BORDER_PATH in
// imageAssetSupport.ts), at tile index `i` (0-based, tiles run left to right).
function sliceBorderTile(atlasData, atlasWidth, i) {
  const out = new ImageData(16, 16);
  const sx0 = i * 16;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const srcIdx = (y * atlasWidth + (sx0 + x)) * 4;
      const dstIdx = (y * 16 + x) * 4;
      out.data[dstIdx] = atlasData.data[srcIdx];
      out.data[dstIdx + 1] = atlasData.data[srcIdx + 1];
      out.data[dstIdx + 2] = atlasData.data[srcIdx + 2];
      out.data[dstIdx + 3] = atlasData.data[srcIdx + 3];
    }
  }
  return out;
}

// The atlas only has vertical edge tiles (left/right) — no horizontal top/bottom tile exists on its
// own, because both the left-edge tile (given its content doesn't vary by row) and the top-edge tile
// (which shouldn't vary by column) are the same shape once you swap their axes: a matrix transpose,
// dst(x,y) = src(y,x). Confirmed by inspecting the corner tiles, whose top/bottom bevel exactly matches
// the left-edge tile's stripe once transposed. This is what lets one tile asset serve both edges,
// exactly like the game's own frame engine does (just done here in a canvas instead of the FDF engine).
function transposeBorderTile(imgData) {
  const out = new ImageData(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const srcIdx = (x * 16 + y) * 4;
      const dstIdx = (y * 16 + x) * 4;
      out.data[dstIdx] = imgData.data[srcIdx];
      out.data[dstIdx + 1] = imgData.data[srcIdx + 1];
      out.data[dstIdx + 2] = imgData.data[srcIdx + 2];
      out.data[dstIdx + 3] = imgData.data[srcIdx + 3];
    }
  }
  return out;
}

function borderTileDataUrl(imgData) {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  canvas.getContext('2d').putImageData(imgData, 0, 0);
  return canvas.toDataURL('image/png');
}

// Slices the gold-border tile atlas (see TOOLTIP_BORDER_PATH in imageAssetSupport.ts) into the 4
// corners + 4 edges a real 9-slice border needs, and sets each as its own CSS var — the tooltip-box
// CSS layers all 8 as separate `background-image`s (see .tt-collapsed/.tt-preview) positioned at their
// respective corner/edge, painted over the plain fill texture. This is a hand-reconstructed
// approximation of the game's own frame-engine rendering (tile positions/thicknesses read off the
// decoded atlas, not off the original FDF frame definition), so it may not line up pixel-for-pixel with
// the real in-game border — but it's the same gold tile artwork, assembled the same way.
function applyTooltipBorder(msg) {
  try {
    if (msg.mode !== 'rgba' || !msg.rgbaBase64 || !msg.width || !msg.height) {
      console.error('[wurst-tooltip-border] malformed tooltipBorderLoaded message', msg);
      return;
    }
    const rgba = base64ToBytes(msg.rgbaBase64);
    const atlas = new ImageData(new Uint8ClampedArray(rgba), msg.width, msg.height);
    const edgeLeft = sliceBorderTile(atlas, msg.width, 0);
    const edgeRight = sliceBorderTile(atlas, msg.width, 1);
    const cornerTL = sliceBorderTile(atlas, msg.width, 4);
    const cornerTR = sliceBorderTile(atlas, msg.width, 5);
    const cornerBL = sliceBorderTile(atlas, msg.width, 6);
    const cornerBR = sliceBorderTile(atlas, msg.width, 7);
    const edgeTop = transposeBorderTile(edgeLeft);
    const edgeBottom = transposeBorderTile(edgeRight);

    const root = document.documentElement.style;
    root.setProperty('--wc3-tip-corner-tl', 'url(' + borderTileDataUrl(cornerTL) + ')');
    root.setProperty('--wc3-tip-corner-tr', 'url(' + borderTileDataUrl(cornerTR) + ')');
    root.setProperty('--wc3-tip-corner-bl', 'url(' + borderTileDataUrl(cornerBL) + ')');
    root.setProperty('--wc3-tip-corner-br', 'url(' + borderTileDataUrl(cornerBR) + ')');
    root.setProperty('--wc3-tip-edge-left', 'url(' + borderTileDataUrl(edgeLeft) + ')');
    root.setProperty('--wc3-tip-edge-right', 'url(' + borderTileDataUrl(edgeRight) + ')');
    root.setProperty('--wc3-tip-edge-top', 'url(' + borderTileDataUrl(edgeTop) + ')');
    root.setProperty('--wc3-tip-edge-bottom', 'url(' + borderTileDataUrl(edgeBottom) + ')');
    console.log('[wurst-tooltip-border] applied');
  } catch (err) {
    console.error('[wurst-tooltip-border] failed to apply', err);
  }
}

export function setupMessageHandler() {
  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type === 'objectIconLoaded') {
      iconLoader.handleLoaded(msg);
    } else if (msg.type === 'tooltipBackdropLoaded') {
      applyTooltipBackdrop(msg);
    } else if (msg.type === 'tooltipBackdropMissing') {
      console.log('[wurst-tooltip-backdrop] not found — keeping the plain background color');
    } else if (msg.type === 'tooltipBorderLoaded') {
      applyTooltipBorder(msg);
    } else if (msg.type === 'tooltipBorderMissing') {
      console.log('[wurst-tooltip-border] not found — keeping the plain border');
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
      // selectObject() moves the highlight and writes ui.selectedKey; the details panel's reactive
      // effect (see setupDetails() in detailsPanel.ts) re-renders itself in response.
      selectObject(msg.key);
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
