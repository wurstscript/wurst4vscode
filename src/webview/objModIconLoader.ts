import { base64ToBytes, esc } from './objModWebviewUtils';

type IconMessage = {
  key?: string;
  mode?: 'jpeg' | 'rgba';
  jpegBase64?: string;
  rgbaBase64?: string;
  width?: number;
  height?: number;
};

type VscodeApi = {
  postMessage(message: unknown): void;
};

export interface IconLoader {
  observe(root?: ParentNode | null): void;
  handleLoaded(message: IconMessage): void;
  handleMissing(key: string): void;
  clearPrefix(prefix: string): void;
}

export function createIconLoader(vscodeApi: VscodeApi): IconLoader {
  const pending = new Set<string>();
  const loaded = new Map<string, string>();
  const missing = new Set<string>();
  let observer: IntersectionObserver | undefined;

  function setLoaded(el: Element, uri: string): void {
    el.classList.remove('loading', 'missing');
    el.innerHTML = '<img loading="lazy" src="' + esc(uri) + '" alt="' + esc(el.getAttribute('data-icon') || '') + '">';
  }

  function setMissing(el: Element): void {
    el.classList.remove('loading');
    el.classList.add('missing');
    el.innerHTML = '';
  }

  function updateElements(key: string, updater: (el: Element) => void): void {
    for (const el of Array.from(document.querySelectorAll('.object-icon'))) {
      if ((el.getAttribute('data-key') || '') === key) updater(el);
    }
  }

  function request(el: Element): void {
    const key = el.getAttribute('data-key') || '';
    const iconPath = el.getAttribute('data-icon') || '';
    if (!key || !iconPath || pending.has(key) || loaded.has(key) || missing.has(key)) return;
    pending.add(key);
    vscodeApi.postMessage({ type: 'loadObjectIcon', key, iconPath });
  }

  function observe(root?: ParentNode | null): void {
    if (!observer) {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          request(entry.target);
        }
      }, { root: null, rootMargin: '120px' });
    }

    for (const el of Array.from((root || document).querySelectorAll('.object-icon[data-icon]'))) {
      const key = el.getAttribute('data-key') || '';
      const uri = loaded.get(key);
      if (uri) {
        setLoaded(el, uri);
      } else if (missing.has(key)) {
        setMissing(el);
      } else {
        observer.observe(el);
      }
    }
  }

  async function renderDataUrl(data: IconMessage): Promise<string | null> {
    try {
      const w = data.width || 0;
      const h = data.height || 0;
      const full = document.createElement('canvas');
      full.width = w;
      full.height = h;
      const fctx = full.getContext('2d');
      if (!fctx) return null;
      if (data.mode === 'rgba' && data.rgbaBase64) {
        const rgba = base64ToBytes(data.rgbaBase64);
        fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
      } else if (data.jpegBase64) {
        const jpeg = base64ToBytes(data.jpegBase64);
        const jpegBytes = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
        const bmp = await createImageBitmap(new Blob([jpegBytes], { type: 'image/jpeg' }));
        fctx.drawImage(bmp, 0, 0, w, h);
        const id = fctx.getImageData(0, 0, w, h);
        const px = id.data;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i];
          px[i] = px[i + 2];
          px[i + 2] = r;
        }
        fctx.putImageData(id, 0, 0);
      } else {
        return null;
      }
      const out = document.createElement('canvas');
      out.width = 48;
      out.height = 48;
      const octx = out.getContext('2d');
      if (!octx) return null;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(full, 0, 0, 48, 48);
      return out.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  function handleLoaded(message: IconMessage): void {
    const key = message.key || '';
    if (!key) return;
    pending.delete(key);
    void renderDataUrl(message).then(url => {
      if (!url) {
        missing.add(key);
        updateElements(key, setMissing);
        return;
      }
      loaded.set(key, url);
      updateElements(key, el => setLoaded(el, url));
    });
  }

  function handleMissing(key: string): void {
    pending.delete(key);
    missing.add(key);
    updateElements(key, setMissing);
  }

  function clearPrefix(prefix: string): void {
    for (const key of [...pending]) if (key.startsWith(prefix)) pending.delete(key);
    for (const key of [...loaded.keys()]) if (key.startsWith(prefix)) loaded.delete(key);
    for (const key of [...missing]) if (key.startsWith(prefix)) missing.delete(key);
  }

  return { observe, handleLoaded, handleMissing, clearPrefix };
}
