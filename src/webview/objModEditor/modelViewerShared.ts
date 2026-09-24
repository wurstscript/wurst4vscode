import { base64ToBytes } from '../webviewUtils';

export function mpvViewer(): any { return window.War3Viewer || null; }

export function mpvB64ToArrayBuffer(b64) {
  const bytes = base64ToBytes(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Prefer the shortest sequence name containing "stand" (base Stand over Stand Ready / Stand Victory). */
export function pickStandSequence(seqs: Array<{ name?: string }>): number {
  let pick = 0, best = Infinity;
  seqs.forEach((s, i) => {
    const n = (s.name || '').toLowerCase();
    if (n.indexOf('stand') >= 0 && n.length < best) { best = n.length; pick = i; }
  });
  return pick;
}
