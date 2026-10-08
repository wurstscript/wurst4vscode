const normalize = (value: string) => value.replace(/\//g, '\\').toLowerCase();

function indexFamilies(paths: readonly string[]): Map<string, Map<number, string>> {
    const families = new Map<string, Map<number, string>>();
    for (const assetPath of paths) {
        if (!/\.(mdx|mdl)$/i.test(assetPath)) continue;
        const name = normalize(assetPath).slice(0, -4);
        let end = name.length;
        while (end > 0 && name.charCodeAt(end - 1) >= 48 && name.charCodeAt(end - 1) <= 57) end--;
        if (end === name.length) continue;
        const stem = name.slice(0, end);
        let variants = families.get(stem);
        if (!variants) {
            variants = new Map();
            families.set(stem, variants);
        }
        const index = Number(name.slice(end));
        if (!variants.has(index) || /\.mdx$/i.test(assetPath)) variants.set(index, assetPath);
    }
    return families;
}

/** Expand metadata family stems using files that actually exist in the game archive. */
export function expandModelVariants<T extends { value: string; label: string; detail?: string }>(options: Iterable<T>, paths: readonly string[]): T[] {
    const available = new Set(paths.map((value) => normalize(value).replace(/\.(mdx|mdl)$/i, '')));
    const families = indexFamilies(paths);
    const result = new Map<string, T>();
    for (const option of options) {
        const stem = normalize(option.value).replace(/\.(mdx|mdl)$/i, '');
        const variants = families.get(stem);
        if (!variants || available.has(stem)) result.set(normalize(option.value), option);
        if (!variants) continue;
        for (const [index, value] of [...variants].sort(([a], [b]) => a - b)) {
            const key = normalize(value);
            if (!result.has(key)) result.set(key, { ...option, value,
                label: `${option.label} (variation ${index})`, detail: option.detail ? `${option.detail} - ${value}` : value });
        }
    }
    return [...result.values()];
}
