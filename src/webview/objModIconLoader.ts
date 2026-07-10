import { base64ToBytes, esc } from './objModWebviewUtils';

type IconMessage = {
  key?: string;
  mode?: 'rgba';
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
  const keyToIconPath = new Map<string, string>();
  const pendingByIconPath = new Map<string, Set<string>>();
  const loadedByIconPath = new Map<string, string>();
  const missingIconPaths = new Set<string>();
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

  function elementsForKey(key: string): Element[] {
    return Array.from(document.querySelectorAll('.object-icon[data-key]'))
      .filter(el => (el.getAttribute('data-key') || '') === key);
  }

  function elementsForIconPath(iconPath: string): Element[] {
    return Array.from(document.querySelectorAll('.object-icon[data-icon]'))
      .filter(el => (el.getAttribute('data-icon') || '') === iconPath);
  }

  function updateElements(key: string, updater: (el: Element) => void): void {
    for (const el of elementsForKey(key)) updater(el);
  }

  function keysForIconPath(iconPath: string): Set<string> {
    let keys = pendingByIconPath.get(iconPath);
    if (!keys) {
      keys = new Set<string>();
      pendingByIconPath.set(iconPath, keys);
    }
    return keys;
  }

  function request(el: Element): void {
    const key = el.getAttribute('data-key') || '';
    const iconPath = el.getAttribute('data-icon') || '';
    if (!key || !iconPath || pending.has(key) || loaded.has(key) || missing.has(key)) return;
    keyToIconPath.set(key, iconPath);
    const pathUri = loadedByIconPath.get(iconPath);
    if (pathUri) {
      loaded.set(key, pathUri);
      setLoaded(el, pathUri);
      return;
    }
    if (missingIconPaths.has(iconPath)) {
      missing.add(key);
      setMissing(el);
      return;
    }
    if (pendingByIconPath.has(iconPath)) {
      pending.add(key);
      keysForIconPath(iconPath).add(key);
      return;
    }
    pending.add(key);
    keysForIconPath(iconPath).add(key);
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
      const iconPath = el.getAttribute('data-icon') || '';
      const uri = loaded.get(key) || loadedByIconPath.get(iconPath);
      if (uri) {
        if (key) loaded.set(key, uri);
        setLoaded(el, uri);
      } else if (missing.has(key) || missingIconPaths.has(iconPath)) {
        if (key) missing.add(key);
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
      if (data.mode !== 'rgba' || !data.rgbaBase64) return null;
      const rgba = base64ToBytes(data.rgbaBase64);
      fctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
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
    const iconPath = keyToIconPath.get(key) || elementsForKey(key)[0]?.getAttribute('data-icon') || '';
    const pathKeys = iconPath ? keysForIconPath(iconPath) : new Set([key]);
    pathKeys.add(key);
    for (const pathKey of pathKeys) pending.delete(pathKey);
    if (iconPath) pendingByIconPath.delete(iconPath);
    void renderDataUrl(message).then(url => {
      if (!url) {
        for (const pathKey of pathKeys) missing.add(pathKey);
        if (iconPath) missingIconPaths.add(iconPath);
        for (const pathKey of pathKeys) updateElements(pathKey, setMissing);
        if (iconPath) for (const el of elementsForIconPath(iconPath)) setMissing(el);
        return;
      }
      for (const pathKey of pathKeys) loaded.set(pathKey, url);
      if (iconPath) loadedByIconPath.set(iconPath, url);
      for (const pathKey of pathKeys) updateElements(pathKey, el => setLoaded(el, url));
      if (iconPath) for (const el of elementsForIconPath(iconPath)) setLoaded(el, url);
    });
  }

  function handleMissing(key: string): void {
    const iconPath = keyToIconPath.get(key) || elementsForKey(key)[0]?.getAttribute('data-icon') || '';
    const pathKeys = iconPath ? keysForIconPath(iconPath) : new Set([key]);
    pathKeys.add(key);
    for (const pathKey of pathKeys) {
      pending.delete(pathKey);
      missing.add(pathKey);
      updateElements(pathKey, setMissing);
    }
    if (iconPath) {
      pendingByIconPath.delete(iconPath);
      missingIconPaths.add(iconPath);
      for (const el of elementsForIconPath(iconPath)) setMissing(el);
    }
  }

  function clearPrefix(prefix: string): void {
    for (const key of [...pending]) if (key.startsWith(prefix)) pending.delete(key);
    for (const key of [...loaded.keys()]) if (key.startsWith(prefix)) loaded.delete(key);
    for (const key of [...missing]) if (key.startsWith(prefix)) missing.delete(key);
    for (const key of [...keyToIconPath.keys()]) if (key.startsWith(prefix)) keyToIconPath.delete(key);
    for (const [iconPath, keys] of pendingByIconPath) {
      for (const key of [...keys]) if (key.startsWith(prefix)) keys.delete(key);
      if (!keys.size) pendingByIconPath.delete(iconPath);
    }
  }

  return { observe, handleLoaded, handleMissing, clearPrefix };
}
