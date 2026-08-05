/** Canonical asset keys shared by the model viewer and thumbnail worker. */
export function normalizeAssetPath(value: unknown): string {
    return String(value ?? '')
        .replace(/\0/g, '')
        .replace(/^\uFEFF/, '')
        .replace(/[\\/]+/g, '\\')
        .replace(/^\\/, '')
        .replace(/\\$/, '')
        .toLowerCase();
}
