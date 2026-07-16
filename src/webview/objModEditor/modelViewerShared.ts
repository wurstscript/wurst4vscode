import { base64ToBytes } from '../objModWebviewUtils';

export function mpvViewer(): any { return window.War3Viewer || null; }

export function mpvB64ToArrayBuffer(b64) {
  const bytes = base64ToBytes(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
