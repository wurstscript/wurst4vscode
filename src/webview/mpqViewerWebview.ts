'use strict';

// MPQ Viewer webview script — compiled separately and loaded via asWebviewUri.
// Messages FROM extension: { type:'init', entries, archiveSize, archiveName }
//                          { type:'error', message }
// Messages TO extension:   { type:'ready' }
//                          { type:'openFile', name }
//                          { type:'extractAll' }
//                          { type:'exportToMapFolder' }

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// ── DOM refs ──────────────────────────────────────────────────────────────────

const treeWrap      = document.getElementById('treeWrap')!;
const searchInput   = document.getElementById('searchInput') as HTMLInputElement;
const matchCount    = document.getElementById('matchCount')!;
const archiveNameEl = document.getElementById('archiveName')!;
const archiveStatsEl = document.getElementById('archiveStats')!;
const btnExtractAll  = document.getElementById('btnExtractAll')!;
const btnExportFolder = document.getElementById('btnExportFolder')!;

// ── utilities ─────────────────────────────────────────────────────────────────

function fmtSize(bytes: number): string {
    if (bytes < 1024)         return bytes + ' B';
    if (bytes < 1024 * 1024)  return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── badge colours ─────────────────────────────────────────────────────────────

const EXT_COLORS: Record<string, string> = {
    blp: '#3794ff', dds: '#3794ff', tga: '#3794ff', png: '#3794ff', jpg: '#3794ff', jpeg: '#3794ff',
    mdx: '#4ec9b0', mdl: '#4ec9b0',
    lua: '#dcdcaa', j: '#dcdcaa', ai: '#dcdcaa',
    mp3: '#c586c0', wav: '#c586c0', ogg: '#c586c0', flac: '#c586c0',
    w3i: '#6a9955', w3u: '#6a9955', w3t: '#6a9955', w3a: '#6a9955', w3b: '#6a9955',
    w3d: '#6a9955', w3h: '#6a9955', w3q: '#6a9955', w3o: '#6a9955', w3e: '#6a9955',
    w3r: '#6a9955', w3c: '#6a9955', w3s: '#6a9955', w3l: '#6a9955',
    wtg: '#ce9178', wct: '#ce9178', wts: '#ce9178',
    slk: '#ce9178', csv: '#ce9178', txt: '#9cdcfe',
    shd: '#858585', wpm: '#858585', mmp: '#858585', doo: '#858585',
};

function badgeColor(ext: string): string {
    return EXT_COLORS[ext.toLowerCase()] ?? '#666';
}

const FILE_DESCRIPTIONS: Record<string, string> = {
    w3i: 'Map info and player/force settings',
    w3u: 'Object editor unit data',
    w3t: 'Object editor item data',
    w3a: 'Object editor ability data',
    w3b: 'Object editor destructable data',
    w3d: 'Object editor doodad data',
    w3h: 'Object editor buff data',
    w3q: 'Object editor upgrade data',
    w3o: 'Imported object editor bundle',
    w3c: 'Custom camera data',
    w3e: 'Terrain height and tile data',
    w3r: 'Regions and triggers regions',
    w3s: 'Sound editor data',
    w3l: 'Custom text trigger list data',
    wpm: 'Pathing map data',
    shd: 'Shadowmap data',
    mmp: 'Minimap preview data',
    doo: 'Doodads and destructables placement',
    wtg: 'GUI trigger definitions',
    wct: 'Custom text triggers',
    wts: 'Trigger strings table',
    fdf: 'Frame definition data',
    toc: 'UI table of contents',
    slk: 'Spreadsheet object data',
    blp: 'Blizzard texture image',
    dds: 'Texture image',
    tga: 'Texture image',
    mdx: 'Compiled 3D model',
    mdl: 'Text 3D model',
    j: 'Map script',
    lua: 'Lua map script',
};

function fileDescription(fullPath: string, ext: string): string {
    const normalized = fullPath.replace(/\//g, '\\').toLowerCase();
    if (normalized.startsWith('war3map.') || normalized.startsWith('scripts\\war3map.')) {
        return FILE_DESCRIPTIONS[ext] ?? `${ext ? '.' + ext : 'File'} data`;
    }
    return FILE_DESCRIPTIONS[ext] ?? '';
}

// ── tree building ─────────────────────────────────────────────────────────────

interface Entry { name: string; normalSize: number; compressedSize: number; }

interface TreeNode {
    type: 'folder' | 'file';
    name: string;
    fullPath: string;
    children: TreeNode[];
    entry?: Entry;
    totalFiles: number;
    totalSize: number;
}

function buildTree(entries: Entry[]): TreeNode {
    const root: TreeNode = { type: 'folder', name: '', fullPath: '', children: [], totalFiles: 0, totalSize: 0 };
    for (const entry of entries) {
        const parts = entry.name.replace(/\//g, '\\').split('\\');
        insertNode(root, parts, 0, entry);
    }
    sortTree(root);
    calcStats(root);
    return root;
}

function insertNode(node: TreeNode, parts: string[], idx: number, entry: Entry): void {
    if (idx === parts.length - 1) {
        node.children.push({ type: 'file', name: parts[idx], fullPath: entry.name, children: [], entry, totalFiles: 0, totalSize: 0 });
        return;
    }
    let folder = node.children.find(c => c.type === 'folder' && c.name === parts[idx]);
    if (!folder) {
        folder = { type: 'folder', name: parts[idx], fullPath: parts.slice(0, idx + 1).join('\\'), children: [], totalFiles: 0, totalSize: 0 };
        node.children.push(folder);
    }
    insertNode(folder, parts, idx + 1, entry);
}

function sortTree(node: TreeNode): void {
    node.children.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    node.children.filter(c => c.type === 'folder').forEach(sortTree);
}

function calcStats(node: TreeNode): void {
    let files = 0, size = 0;
    for (const c of node.children) {
        if (c.type === 'file') { files++; size += c.entry!.normalSize; }
        else { calcStats(c); files += c.totalFiles; size += c.totalSize; }
    }
    node.totalFiles = files;
    node.totalSize = size;
}

// ── rendering ─────────────────────────────────────────────────────────────────

const ICON_CHEVRON = '<svg viewBox="0 0 10 10"><path d="M2 2l4 3-4 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FOLDER  = '<svg viewBox="0 0 16 16"><path d="M1 4.5A1.5 1.5 0 0 1 2.5 3h3.672a1.5 1.5 0 0 1 1.06.44l.83.83A1.5 1.5 0 0 0 9.12 4.7H13.5A1.5 1.5 0 0 1 15 6.2V12.5A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5V4.5z"/></svg>';
// Open file icon (arrow into box)
const ICON_OPEN    = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8.5 1a.5.5 0 0 0-1 0v6.793L5.354 5.646a.5.5 0 1 0-.708.708l3 3a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 7.793V1zM3 10.5a.5.5 0 0 0-1 0v3a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-1 0V13H3v-2.5z"/></svg>';

let selectedRow: HTMLElement | null = null;

function renderNode(node: TreeNode, indent: number, container: HTMLElement): void {
    if (node.type === 'folder') renderFolder(node, indent, container);
    else renderFile(node, indent, container);
}

function renderFolder(node: TreeNode, indent: number, container: HTMLElement): void {
    const wrapper = document.createElement('div');
    wrapper.dataset['type'] = 'folder';
    wrapper.dataset['name'] = node.name.toLowerCase();

    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = (indent * 16 + 6) + 'px';
    row.innerHTML =
        '<span class="chevron">' + ICON_CHEVRON + '</span>' +
        '<span class="folder-icon">' + ICON_FOLDER + '</span>' +
        '<span class="folder-name">' + esc(node.name) + '</span>' +
        '<span class="folder-meta">' + node.totalFiles + ' \u00b7 ' + fmtSize(node.totalSize) + '</span>';

    const children = document.createElement('div');
    children.className = 'children collapsed';

    for (const child of node.children) renderNode(child, indent + 1, children);

    row.addEventListener('click', () => {
        const collapsed = wrapper.classList.toggle('collapsed');
        children.classList.toggle('collapsed', collapsed);
    });

    wrapper.appendChild(row);
    wrapper.appendChild(children);
    wrapper.classList.add('collapsed');
    container.appendChild(wrapper);
}

function renderFile(node: TreeNode, indent: number, container: HTMLElement): void {
    const ext = node.name.includes('.') ? node.name.split('.').pop()! : '';
    const color = badgeColor(ext);
    const label = ext ? ext.toUpperCase().slice(0, 4) : '?';
    const description = fileDescription(node.fullPath, ext.toLowerCase());

    const row = document.createElement('div');
    row.className = 'row';
    row.style.paddingLeft = (indent * 16 + 22) + 'px';
    row.dataset['type'] = 'file';
    row.dataset['fullpath'] = node.fullPath;
    row.dataset['search'] = (node.fullPath + ' ' + description).toLowerCase();

    // Main content
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = color;
    badge.textContent = label;

    const fileMain = document.createElement('div');
    fileMain.className = 'file-main';
    fileMain.title = description ? `${node.fullPath}\n${description}` : node.fullPath;

    const fileName = document.createElement('span');
    fileName.className = 'file-name';
    fileName.textContent = node.name;

    fileMain.appendChild(fileName);

    if (description) {
        const fileDesc = document.createElement('span');
        fileDesc.className = 'file-desc';
        fileDesc.textContent = `.${ext.toLowerCase()} - ${description}`;
        fileMain.appendChild(fileDesc);
    }

    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = fmtSize(node.entry!.normalSize);

    // Action button — only visible on hover/selection
    const openBtn = document.createElement('button');
    openBtn.className = 'row-action';
    openBtn.title = 'Open in editor';
    openBtn.innerHTML = ICON_OPEN + '<span>Open</span>';
    openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openFile', name: node.fullPath });
    });

    row.appendChild(badge);
    row.appendChild(fileMain);
    row.appendChild(openBtn);
    row.appendChild(size);

    // Click selects the row (does NOT immediately open)
    row.addEventListener('click', () => {
        if (selectedRow) selectedRow.classList.remove('selected');
        row.classList.add('selected');
        selectedRow = row;
    });

    // Double-click opens
    row.addEventListener('dblclick', () => {
        vscode.postMessage({ type: 'openFile', name: node.fullPath });
    });

    container.appendChild(row);
}

// ── filter ────────────────────────────────────────────────────────────────────

function applyFilter(query: string): void {
    const q = query.toLowerCase().trim();
    const allFiles = treeWrap.querySelectorAll<HTMLElement>('[data-type="file"]');
    let shown = 0;

    if (!q) {
        allFiles.forEach(r => r.classList.remove('hidden'));
        treeWrap.querySelectorAll<HTMLElement>('[data-type="folder"]').forEach(f => f.classList.remove('hidden'));
        treeWrap.querySelectorAll<HTMLElement>('.children').forEach(c => c.classList.add('collapsed'));
        treeWrap.querySelectorAll<HTMLElement>('[data-type="folder"]').forEach(f => f.classList.add('collapsed'));
        matchCount.textContent = '';
        return;
    }

    allFiles.forEach(r => {
        const matches = (r.dataset['search'] ?? '').includes(q);
        r.classList.toggle('hidden', !matches);
        if (matches) shown++;
    });

    function updateFolder(el: HTMLElement): void {
        const files = el.querySelectorAll('[data-type="file"]');
        const anyVisible = Array.from(files).some((f: Element) => !(f as HTMLElement).classList.contains('hidden'));
        el.classList.toggle('hidden', !anyVisible);
        if (anyVisible) {
            el.classList.remove('collapsed');
            const childrenEl = el.querySelector('.children');
            if (childrenEl) childrenEl.classList.remove('collapsed');
        }
    }

    const allFolders = Array.from(treeWrap.querySelectorAll<HTMLElement>('[data-type="folder"]'));
    allFolders.reverse().forEach(updateFolder);
    matchCount.textContent = shown === 1 ? '1 match' : shown + ' matches';
}

searchInput.addEventListener('input', () => applyFilter(searchInput.value));

// ── toolbar buttons ───────────────────────────────────────────────────────────

btnExtractAll.addEventListener('click', () => {
    vscode.postMessage({ type: 'extractAll' });
});

btnExportFolder.addEventListener('click', () => {
    vscode.postMessage({ type: 'exportToMapFolder' });
});

// ── message handling ──────────────────────────────────────────────────────────

window.addEventListener('message', (e: MessageEvent) => {
    const msg = e.data as { type: string; message?: string; entries?: Entry[]; archiveSize?: number; archiveName?: string };
    if (!msg?.type) return;

    if (msg.type === 'error') {
        treeWrap.innerHTML = '<div class="state"><span>Failed to read archive</span><span class="err">' + esc(msg.message ?? '') + '</span></div>';
        btnExtractAll.setAttribute('disabled', '');
        btnExportFolder.setAttribute('disabled', '');
        return;
    }

    if (msg.type === 'init') {
        archiveNameEl.textContent = msg.archiveName ?? '';
        const entries = msg.entries ?? [];
        const totalSize = entries.reduce((s, e) => s + e.normalSize, 0);
        archiveStatsEl.textContent =
            entries.length + ' files \u00b7 ' +
            fmtSize(totalSize) + ' uncompressed \u00b7 ' +
            fmtSize(msg.archiveSize ?? 0) + ' on disk';

        btnExtractAll.removeAttribute('disabled');
        btnExportFolder.removeAttribute('disabled');

        if (entries.length === 0) {
            treeWrap.innerHTML = '<div class="state"><span>No files found in archive</span></div>';
            return;
        }

        const tree = buildTree(entries);
        treeWrap.innerHTML = '';
        for (const child of tree.children) renderNode(child, 0, treeWrap);
    }
});

// ── boot ──────────────────────────────────────────────────────────────────────

vscode.postMessage({ type: 'ready' });
