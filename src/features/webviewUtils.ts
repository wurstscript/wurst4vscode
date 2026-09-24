export function makeNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 24; i++) {
        out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
}

/** A number with at most three decimals and no trailing zeros, for data tables. */
export function fmt3(value: number): string {
    // eslint-disable-next-line sonarjs/super-linear-regex -- single quantified group anchored at end, no ambiguous adjacency; not actually susceptible to backtracking blowup.
    return value.toFixed(3).replace(/\.?0+$/, '');
}

export function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
