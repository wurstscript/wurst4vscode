export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch] ?? ch));
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function renderWc3Colors(text: unknown): string {
  const s = String(text == null ? '' : text);
  let html = '';
  let depth = 0;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '|') {
      const next = s[i + 1];
      if (next === 'c' || next === 'C') {
        const hex = s.substr(i + 2, 8);
        if (/^[0-9a-fA-F]{8}$/.test(hex)) {
          html += '<span style="color:#' + hex.substr(2) + '">';
          depth++;
          i += 10;
          continue;
        }
      } else if (next === 'r' || next === 'R') {
        if (depth > 0) {
          html += '</span>';
          depth--;
        }
        i += 2;
        continue;
      } else if (next === 'n') {
        html += '<br>';
        i += 2;
        continue;
      } else if (next === '|') {
        html += '|';
        i += 2;
        continue;
      }
    }
    html += esc(ch);
    i++;
  }
  while (depth > 0) {
    html += '</span>';
    depth--;
  }
  return html;
}
