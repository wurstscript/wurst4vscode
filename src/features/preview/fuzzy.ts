'use strict';

/**
 * Typo-tolerant search used by every webview search box.
 *
 * Pure, dependency-free, and self-contained on purpose: `webviewShared.ts` ships this exact function
 * to the webview via `fuzzyMatch.toString()`, and `scripts/test-fuzzy.js` unit-tests it. Do not add
 * imports or closures it can't carry into the webview.
 *
 * Strategy: case-insensitive substring (fast path), else an approximate-substring edit distance —
 * the minimum edits to turn `query` into SOME substring of `text` (row 0 = all zeros lets the match
 * start anywhere). This finds "brilliance" inside "BTNBrillianceAura" for the query "billiance",
 * which a word-length-bounded check would miss. The budget stays low (≤2 edits) so it only forgives
 * small typos, not loose matches.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
export function fuzzyMatch(query: string, text: string): boolean {
    query = String(query === null || query === undefined ? '' : query).toLowerCase().trim();
    if (!query) return true;
    text = String(text === null || text === undefined ? '' : text).toLowerCase();
    if (text.indexOf(query) >= 0) return true;

    const max = Math.min(2, Math.floor(query.length / 4));
    if (max <= 0) return false;

    const n = query.length;
    const m = text.length;
    let prev = new Array(m + 1).fill(0); // matching the empty query against any prefix costs 0
    for (let i = 1; i <= n; i++) {
        const cur = new Array(m + 1);
        cur[0] = i;
        let best = i;
        const qi = query.charCodeAt(i - 1);
        for (let j = 1; j <= m; j++) {
            const cost = qi === text.charCodeAt(j - 1) ? 0 : 1;
            const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
            cur[j] = v;
            if (v < best) best = v;
        }
        if (best > max) return false; // row min is non-decreasing → budget exhausted, give up early
        prev = cur;
    }
    let min = Infinity;
    for (let j = 0; j <= m; j++) if (prev[j] < min) min = prev[j];
    return min <= max;
}

/**
 * Relevance score for asset-picker entries. Lower is better; Infinity means no match.
 *
 * Keep this dependency-free and reference only `fuzzyMatch`: the code-asset picker ships both
 * functions into its webview with `.toString()`. Search individual fields instead of one joined
 * haystack so a query cannot be assembled from unrelated letters across a label, path, and detail.
 */
export function assetSearchScore(query: string, label: string, value: string, detail = ''): number {
    const q = String(query === null || query === undefined ? '' : query).toLowerCase().trim();
    if (!q) return 0;

    const rawLabel = String(label === null || label === undefined ? '' : label);
    const normalizedValue = String(value === null || value === undefined ? '' : value).replace(/\\/g, '/');
    const basename = normalizedValue.slice(normalizedValue.lastIndexOf('/') + 1).toLowerCase();
    const stem = basename.replace(/\.[^.]+$/, '');
    const normalizedLabel = rawLabel.toLowerCase().trim();
    const labelStem = normalizedLabel.replace(/\.[^.]+$/, '');
    const labelWords = rawLabel.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    const valueWords = normalizedValue.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

    if (labelStem === q || stem === q) return 0;
    if (labelStem.startsWith(q) || stem.startsWith(q)) return 10;
    if (normalizedLabel.includes(q) || basename.includes(q)) return 20;
    if (labelWords.includes(q)) return 30;
    if (valueWords.includes(q)) return 40;
    if (String(detail === null || detail === undefined ? '' : detail).toLowerCase().includes(q)) return 50;
    if (fuzzyMatch(q, labelStem) || fuzzyMatch(q, stem)) return 80;
    return Number.POSITIVE_INFINITY;
}
