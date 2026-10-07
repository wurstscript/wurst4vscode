import { esc } from './webviewUtils';

export function assetDisplayName(label: string, value: string): string {
    const name = String(label || '').trim();
    if (name && name !== value && !/[\\/]/.test(name)) return name;
    return String(value || '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || name || 'Unnamed asset';
}

export function assetCardActions(canUse: boolean): string {
    const actions = [
        ['copy', 'Copy path', '<rect x="8" y="8" width="11" height="12" rx="1"/><path d="M15 8V4H4v12h4"/>'],
        ['open', 'Open in viewer', '<path d="M14 3h7v7M21 3l-11 11M10 5H4v15h15v-6"/>'],
        ...(canUse ? [['use', 'Use asset', '<path d="m4 12 5 5L20 6"/>']] : []),
    ];
    return '<span class="asset-actions">' + actions.map(([action, title, shape]) =>
        '<button class="asset-action" type="button" data-action="' + action + '" title="' + esc(title) + '" aria-label="' + esc(title) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + shape + '</svg></button>',
    ).join('') + '</span>';
}
