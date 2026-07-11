// @ts-nocheck
import { esc } from '../objModWebviewUtils';
import { vscodeApi } from './state';
import { mpvViewer, mpvB64ToArrayBuffer } from './modelViewerShared';
import { finishModelThumb, scheduleModelThumbQueues, resetModelThumbInited } from './modelThumbnails';

// ── Inline model preview (control-less docked square) ────────────────────────
let mpvInited = false;

export function resetMpvInited() {
  mpvInited = false;
}

export function mpvStatus(text) {
  const el = document.getElementById('mpv-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

export function mpvEnsureInit() {
  if (mpvInited) return mpvInited;
  const v = mpvViewer();
  if (!v) return false;
  resetModelThumbInited();
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
export function mpvFillAnims(seqs) {
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

export function showModelPreview(path) {
  if (!path) return;
  // Original code only called this when a model-thumb job was in flight; finishModelThumb() is
  // itself a no-op when there's no active job, so the equivalent guard is folded into the call —
  // modelThumbJob lives in modelThumbnails.ts and isn't exposed outside that module.
  finishModelThumb(false);
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

export function hideModelPreview() {
  const box = document.getElementById('mpv-box');
  if (box) box.hidden = true;
  if (mpvViewer() && mpvInited) { try { mpvViewer().setAutoplay(false); } catch (e) {} }
  scheduleModelThumbQueues(0);
}

export function mpvSetPlaying(on) {
  mpvPlaying = on;
  const v = mpvViewer();
  if (v && mpvInited) { try { v.setAutoplay(on); } catch (e) {} }
  const btn = document.getElementById('mpv-play');
  if (btn) { btn.textContent = on ? '⏸' : '▶'; btn.title = on ? 'Pause' : 'Play'; }
}

export function mpvRestart() {
  const v = mpvViewer();
  if (!v || !mpvInited) return;
  const anim = document.getElementById('mpv-anim');
  try { v.setSequence(Number(anim && anim.value) || 0); v.setAutoplay(true); } catch (e) {}
  mpvSetPlaying(true);
}

export function setupModelPreviewPanel() {
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
}
