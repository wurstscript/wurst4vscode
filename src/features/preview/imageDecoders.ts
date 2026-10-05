'use strict';

/**
 * Glue layer over `casc-ts/formats` for the extension's asset previewers.
 * The pure BLP / DDS / TGA decoders live in casc-ts; this file adds the
 * wurst4vscode-specific bits: the MDX passthrough variant, the extension-
 * -dispatched preview helpers, normalization of every raster format to
 * RGBA for all extension-side consumers, and decoders for the layouts
 * casc-ts does not handle yet (BC4/BC5 DDS, DXT-compressed BLP2).
 */

import { decodeBlp as decodeCascBlp, decodeDds as decodeCascDds, decodeTga, DecodedRasterImage } from 'casc-ts/formats';

// war3-model publishes a CommonJS entry alongside its ESM package marker. The
// extension host is CommonJS, so describe the two decoder exports we consume
// without making TypeScript emit an incompatible ESM import.
type War3ModelDecoder = {
    decodeBLP(source: ArrayBuffer): unknown;
    getBLPImageData(blp: unknown, mipmapLevel: number): {
        width: number;
        height: number;
        data: Uint8Array | Uint8ClampedArray;
    };
};
let war3Model: War3ModelDecoder | undefined;

function getWar3ModelDecoder(): War3ModelDecoder {
    if (!war3Model) war3Model = require('war3-model') as War3ModelDecoder;
    return war3Model;
}

export { decodeTga };
export type { DecodedRasterImage };
export type DecodedRgbaImage = Extract<DecodedRasterImage, { mode: 'rgba' }>;

/**
 * MDX files are passed through as-is — they're decoded in the webview via the
 * `war3-model` package. Keeps the preview-dispatcher return type uniform.
 */
export type DecodedMdxRaw = {
    kind: 'mdx-raw';
    mdxBase64: string;
    fileName: string;
    format: 'mdx' | 'mdl';
};

export type DecodedBlpImage = DecodedRgbaImage | DecodedMdxRaw;

const DDS_MAGIC = 0x20534444;
const DDPF_FOURCC = 0x4;
const BLP2_MAGIC = 0x32504c42;
const BLP2_PIXMAP_DXT = 2;

function readU32LE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function fourCc(bytes: Uint8Array): string {
    const value = readU32LE(bytes, 84);
    return String.fromCharCode(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function decodeBcAlphaBlock(bytes: Uint8Array, offset: number): Uint8Array {
    const out = new Uint8Array(16);
    const palette = new Uint8Array(8);
    palette[0] = bytes[offset] ?? 0;
    palette[1] = bytes[offset + 1] ?? 0;
    if (palette[0] > palette[1]) {
        palette[2] = Math.floor((6 * palette[0] + palette[1]) / 7);
        palette[3] = Math.floor((5 * palette[0] + 2 * palette[1]) / 7);
        palette[4] = Math.floor((4 * palette[0] + 3 * palette[1]) / 7);
        palette[5] = Math.floor((3 * palette[0] + 4 * palette[1]) / 7);
        palette[6] = Math.floor((2 * palette[0] + 5 * palette[1]) / 7);
        palette[7] = Math.floor((palette[0] + 6 * palette[1]) / 7);
    } else {
        palette[2] = Math.floor((4 * palette[0] + palette[1]) / 5);
        palette[3] = Math.floor((3 * palette[0] + 2 * palette[1]) / 5);
        palette[4] = Math.floor((2 * palette[0] + 3 * palette[1]) / 5);
        palette[5] = Math.floor((palette[0] + 4 * palette[1]) / 5);
        palette[6] = 0;
        palette[7] = 255;
    }

    let bits = 0;
    let bitCount = 0;
    let src = offset + 2;
    for (let i = 0; i < 16; i++) {
        while (bitCount < 3) {
            bits |= (bytes[src++] ?? 0) << bitCount;
            bitCount += 8;
        }
        out[i] = palette[bits & 0x7];
        bits >>>= 3;
        bitCount -= 3;
    }
    return out;
}

function reconstructNormalZ(xByte: number, yByte: number): number {
    const x = xByte / 127.5 - 1;
    const y = yByte / 127.5 - 1;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    return Math.max(0, Math.min(255, Math.round((z * 0.5 + 0.5) * 255)));
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- TODO(lint-cleanup): pre-existing, tracked for a dedicated decomposition pass rather than a rushed refactor here.
function decodeBc4Bc5Dds(bytes: Uint8Array): DecodedRasterImage | undefined {
    if (bytes.length < 128 || readU32LE(bytes, 0) !== DDS_MAGIC || (readU32LE(bytes, 80) & DDPF_FOURCC) === 0) {
        return undefined;
    }
    const width = readU32LE(bytes, 16);
    const height = readU32LE(bytes, 12);
    if (width <= 0 || height <= 0) return undefined;
    const mipMapCount = Math.max(1, readU32LE(bytes, 28) || 1);
    const format = fourCc(bytes).toUpperCase();
    const isBc4 = format === 'ATI1' || format === 'BC4U' || format === 'BC4S';
    const isBc5 = format === 'ATI2' || format === 'BC5U' || format === 'BC5S';
    if (!isBc4 && !isBc5) return undefined;

    const blockBytes = isBc5 ? 16 : 8;
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const rgba = new Uint8Array(width * height * 4);
    let offset = 128;

    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const r = decodeBcAlphaBlock(bytes, offset);
            const g = isBc5 ? decodeBcAlphaBlock(bytes, offset + 8) : r;
            offset += blockBytes;
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const src = py * 4 + px;
                    const dst = (y * width + x) * 4;
                    rgba[dst] = r[src];
                    rgba[dst + 1] = g[src];
                    rgba[dst + 2] = isBc5 ? reconstructNormalZ(r[src], g[src]) : r[src];
                    rgba[dst + 3] = 255;
                }
            }
        }
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings: [],
        description: `DDS ${format} | mipmaps: ${mipMapCount}`,
    };
}

export function decodeDds(bytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeCascDds(bytes);
    } catch (err) {
        const decoded = decodeBc4Bc5Dds(bytes);
        if (decoded) return decoded;
        throw err;
    }
}

function expand565(color: number): number[] {
    return [
        Math.floor((255 * ((color >> 11) & 0x1f) + 15) / 31),
        Math.floor((255 * ((color >> 5) & 0x3f) + 31) / 63),
        Math.floor((255 * (color & 0x1f) + 15) / 31),
    ];
}

/** The four RGBA colours of a DXT colour block; a DXT1 block with c0 <= c1 is in three-colour mode. */
function decodeDxtColorBlock(bytes: Uint8Array, offset: number, dxt1: boolean): number[][] {
    const c0 = bytes[offset] | (bytes[offset + 1] << 8);
    const c1 = bytes[offset + 2] | (bytes[offset + 3] << 8);
    const [r0, g0, b0] = expand565(c0);
    const [r1, g1, b1] = expand565(c1);
    if (dxt1 && c0 <= c1) {
        return [
            [r0, g0, b0, 255],
            [r1, g1, b1, 255],
            [(r0 + r1) >> 1, (g0 + g1) >> 1, (b0 + b1) >> 1, 255],
            [0, 0, 0, 0],
        ];
    }
    return [
        [r0, g0, b0, 255],
        [r1, g1, b1, 255],
        [Math.floor((2 * r0 + r1) / 3), Math.floor((2 * g0 + g1) / 3), Math.floor((2 * b0 + b1) / 3), 255],
        [Math.floor((r0 + 2 * r1) / 3), Math.floor((g0 + 2 * g1) / 3), Math.floor((b0 + 2 * b1) / 3), 255],
    ];
}

/** One 4x4 block of a DXT1/3/5 mipmap as 16 RGBA pixels, row by row. */
function decodeDxtBlock(bytes: Uint8Array, offset: number, dxt: 1 | 3 | 5): Uint8Array {
    const colorOffset = dxt === 1 ? offset : offset + 8;
    const colors = decodeDxtColorBlock(bytes, colorOffset, dxt === 1);
    const indices = readU32LE(bytes, colorOffset + 4);
    const block = new Uint8Array(64);
    for (let i = 0; i < 16; i++) block.set(colors[(indices >>> (2 * i)) & 3], i * 4);
    if (dxt === 5) {
        const alpha = decodeBcAlphaBlock(bytes, offset);
        for (let i = 0; i < 16; i++) block[i * 4 + 3] = alpha[i];
    } else if (dxt === 3) {
        for (let i = 0; i < 16; i++) block[i * 4 + 3] = ((bytes[offset + (i >> 1)] >> ((i & 1) * 4)) & 0xf) * 17;
    }
    return block;
}

/**
 * Header of a BLP2 whose mipmaps are DXT-compressed (pixmapType 2). alphaBits 0 or 1 means DXT1,
 * 4 means DXT3, and 8 means DXT5 when the preferred-format byte is 7, else DXT3.
 */
function readDxtBlpHeader(bytes: Uint8Array) {
    if (bytes.length < 148 || readU32LE(bytes, 0) !== BLP2_MAGIC || bytes[8] !== BLP2_PIXMAP_DXT) return undefined;
    const alphaBits = bytes[9];
    let dxt: 1 | 3 | 5 = 5;
    if (alphaBits <= 1) dxt = 1;
    else if (alphaBits === 4 || bytes[10] !== 7) dxt = 3;
    let mipmaps = 0;
    while (mipmaps < 16 && readU32LE(bytes, 20 + mipmaps * 4) !== 0) mipmaps++;
    return { dxt, width: readU32LE(bytes, 12), height: readU32LE(bytes, 16), offset: readU32LE(bytes, 20), mipmaps };
}

/** DXT-compressed BLP2, which casc-ts does not decode yet. Like its other BLP modes, only mipmap 0 is read. */
function decodeDxtBlp(bytes: Uint8Array): DecodedRasterImage | undefined {
    const header = readDxtBlpHeader(bytes);
    if (!header) return undefined;
    const { dxt, width, height, mipmaps } = header;
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const blockBytes = dxt === 1 ? 8 : 16;
    let offset = header.offset;
    if (width <= 0 || height <= 0 || offset + blocksWide * blocksHigh * blockBytes > bytes.length) {
        throw new Error(`BLP2 DXT${dxt} mipmap 0 is truncated (${width}x${height})`);
    }

    const rgba = new Uint8Array(width * height * 4);
    for (let by = 0; by < blocksHigh; by++) {
        const rows = Math.min(4, height - by * 4);
        for (let bx = 0; bx < blocksWide; bx++) {
            const block = decodeDxtBlock(bytes, offset, dxt);
            offset += blockBytes;
            const columns = Math.min(4, width - bx * 4);
            for (let py = 0; py < rows; py++) {
                rgba.set(block.subarray(py * 16, py * 16 + columns * 4), ((by * 4 + py) * width + bx * 4) * 4);
            }
        }
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings: [],
        description: `BLP2 DXT${dxt} | mipmaps: ${mipmaps}`,
    };
}

export function decodeBlp(bytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeCascBlp(bytes);
    } catch (err) {
        const decoded = decodeDxtBlp(bytes);
        if (decoded) return decoded;
        throw err;
    }
}

function normalizeToRgba(result: DecodedRasterImage, sourceBytes: Uint8Array): DecodedRgbaImage {
    if (result.mode === 'rgba') return result;

    // Warcraft JPEG-content BLPs can contain non-standard 4-component JPEGs.
    // war3-model carries the custom decoder used by the model renderer; reuse
    // that implementation instead of passing the reconstructed JPEG to a
    // standards-only decoder.
    const source = sourceBytes.buffer.slice(
        sourceBytes.byteOffset,
        sourceBytes.byteOffset + sourceBytes.byteLength,
    ) as ArrayBuffer;
    const decoder = getWar3ModelDecoder();
    const decoded = decoder.getBLPImageData(decoder.decodeBLP(source), 0);
    if (decoded.width !== result.width || decoded.height !== result.height) {
        throw new Error(
            `BLP JPEG dimensions do not match header (${decoded.width}x${decoded.height}, expected ${result.width}x${result.height})`
        );
    }
    const rgba = new Uint8Array(decoded.data);
    return {
        kind: 'raster',
        mode: 'rgba',
        width: result.width,
        height: result.height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings: result.warnings,
        description: result.description,
    };
}

/** Decode BLP/DDS/TGA directly to normalized RGBA. */
export function decodeToRgba(bytes: Uint8Array, ext: string): { width: number; height: number; rgba: Uint8Array; description: string } {
    const result = decodeRasterPreview(bytes, ext);
    return {
        width: result.width,
        height: result.height,
        rgba: Buffer.from(result.rgbaBase64, 'base64'),
        description: result.description,
    };
}

/** Decode BLP/DDS/TGA for preview display through one normalized RGBA path. */
export function decodeRasterPreview(bytes: Uint8Array, ext: string): DecodedRgbaImage {
    let decoded;
    if (ext === '.dds') decoded = decodeDds(bytes);
    else if (ext === '.tga') decoded = decodeTga(bytes);
    else decoded = decodeBlp(bytes);
    return normalizeToRgba(decoded, bytes);
}
