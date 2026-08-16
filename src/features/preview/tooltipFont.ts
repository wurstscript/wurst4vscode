'use strict';

interface SfntTable {
    directoryOffset: number;
    offset: number;
    length: number;
}

export interface TooltipFontRepair {
    bytes: Uint8Array;
    repairedFlags: number;
}

function readTable(bytes: Buffer, tag: string): SfntTable | undefined {
    if (bytes.length < 12) return undefined;
    const tableCount = bytes.readUInt16BE(4);
    if (12 + tableCount * 16 > bytes.length) return undefined;
    for (let i = 0; i < tableCount; i++) {
        const directoryOffset = 12 + i * 16;
        if (bytes.toString('ascii', directoryOffset, directoryOffset + 4) !== tag) continue;
        const offset = bytes.readUInt32BE(directoryOffset + 8);
        const length = bytes.readUInt32BE(directoryOffset + 12);
        if (offset > bytes.length || length > bytes.length - offset) return undefined;
        return { directoryOffset, offset, length };
    }
    return undefined;
}

function glyphLocations(bytes: Buffer, head: SfntTable, maxp: SfntTable, loca: SfntTable): number[] | undefined {
    if (head.length < 54 || maxp.length < 6) return undefined;
    const glyphCount = bytes.readUInt16BE(maxp.offset + 4);
    const longLocations = bytes.readInt16BE(head.offset + 50) === 1;
    const entrySize = longLocations ? 4 : 2;
    if ((glyphCount + 1) * entrySize > loca.length) return undefined;
    const locations: number[] = [];
    for (let i = 0; i <= glyphCount; i++) {
        const entryOffset = loca.offset + i * entrySize;
        locations.push(longLocations ? bytes.readUInt32BE(entryOffset) : bytes.readUInt16BE(entryOffset) * 2);
    }
    return locations;
}

function simpleGlyphFlagOffset(bytes: Buffer, start: number, end: number, contourCount: number): { offset: number; points: number } | undefined {
    const endPointsOffset = start + 10;
    const instructionLengthOffset = endPointsOffset + contourCount * 2;
    if (instructionLengthOffset + 2 > end) return undefined;
    const lastEndPointOffset = instructionLengthOffset - 2;
    const points = contourCount === 0 ? 0 : bytes.readUInt16BE(lastEndPointOffset) + 1;
    const flagsOffset = instructionLengthOffset + 2 + bytes.readUInt16BE(instructionLengthOffset);
    return flagsOffset <= end ? { offset: flagsOffset, points } : undefined;
}

function reservedSimpleGlyphFlagOffsets(bytes: Buffer, start: number, end: number): number[] {
    if (end - start < 10) return [];
    const contourCount = bytes.readInt16BE(start);
    if (contourCount < 0) return [];
    const flags = simpleGlyphFlagOffset(bytes, start, end, contourCount);
    if (!flags) return [];

    let offset = flags.offset;
    let point = 0;
    const reservedOffsets: number[] = [];
    while (point < flags.points) {
        if (offset >= end) return [];
        const flag = bytes[offset];
        if ((flag & 0xc0) !== 0) reservedOffsets.push(offset);
        offset++;
        if ((flag & 0x08) !== 0) {
            if (offset >= end) return [];
            point += bytes[offset] + 1;
            offset++;
        } else {
            point++;
        }
    }
    return point === flags.points ? reservedOffsets : [];
}

function checksum(bytes: Buffer, offset = 0, length = bytes.length): number {
    let sum = 0;
    const end = offset + length;
    for (let i = offset; i < end; i += 4) {
        let word = 0;
        for (let j = 0; j < 4; j++) word = (word << 8) | (i + j < end ? bytes[i + j] : 0);
        sum = (sum + (word >>> 0)) >>> 0;
    }
    return sum;
}

function updateChecksums(bytes: Buffer, head: SfntTable, glyf: SfntTable): void {
    bytes.writeUInt32BE(0, head.offset + 8);
    bytes.writeUInt32BE(checksum(bytes, glyf.offset, glyf.length), glyf.directoryOffset + 4);
    bytes.writeUInt32BE(checksum(bytes, head.offset, head.length), head.directoryOffset + 4);
    bytes.writeUInt32BE((0xb1b0afba - checksum(bytes)) >>> 0, head.offset + 8);
}

/**
 * Clears reserved bits 6/7 from simple-glyph flags in otherwise usable TrueType fonts.
 * Warcraft III accepts fonts containing these bits, while Chromium's OpenType sanitizer rejects
 * the entire face. The returned bytes are a copy; unsupported or already-valid fonts are unchanged.
 */
export function repairTooltipTrueTypeFont(source: Uint8Array): TooltipFontRepair {
    const bytes = Buffer.from(source);
    const head = readTable(bytes, 'head');
    const maxp = readTable(bytes, 'maxp');
    const loca = readTable(bytes, 'loca');
    const glyf = readTable(bytes, 'glyf');
    if (!head || !maxp || !loca || !glyf) return { bytes: source, repairedFlags: 0 };
    const locations = glyphLocations(bytes, head, maxp, loca);
    if (!locations) return { bytes: source, repairedFlags: 0 };

    let repairedFlags = 0;
    for (let i = 0; i + 1 < locations.length; i++) {
        const start = glyf.offset + locations[i];
        const end = glyf.offset + locations[i + 1];
        if (start < glyf.offset || end < start || end > glyf.offset + glyf.length) {
            return { bytes: source, repairedFlags: 0 };
        }
        const reservedOffsets = reservedSimpleGlyphFlagOffsets(bytes, start, end);
        for (const offset of reservedOffsets) bytes[offset] &= 0x3f;
        repairedFlags += reservedOffsets.length;
    }
    if (repairedFlags === 0) return { bytes: source, repairedFlags: 0 };
    updateChecksums(bytes, head, glyf);
    return { bytes, repairedFlags };
}
