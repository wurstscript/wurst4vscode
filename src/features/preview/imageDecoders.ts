'use strict';

/**
 * Glue layer over `casc-ts/formats` for the extension's asset previewers.
 * The pure BLP / DDS / TGA decoders live in casc-ts; this file adds the
 * wurst4vscode-specific bits: the MDX passthrough variant, the extension-
 * -dispatched `decodePreview` helpers, and the JPEG-to-disk writer used by
 * the inline decoration thumbnail cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodeBlp, decodeDds as decodeCascDds, decodeTga, DecodedRasterImage } from 'casc-ts/formats';

export { decodeBlp, decodeTga };
export type { DecodedRasterImage };

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

export type DecodedBlpImage = DecodedRasterImage | DecodedMdxRaw;

const DDS_MAGIC = 0x20534444;
const DDPF_FOURCC = 0x4;

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

/** Decode BLP/DDS/TGA directly to RGBA; used by the hover preview. */
export function decodeToRgba(bytes: Uint8Array, ext: string): { width: number; height: number; rgba: Uint8Array; description: string } {
    const result = ext === '.dds' ? decodeDds(bytes)
                 : ext === '.tga' ? decodeTga(bytes)
                 : decodeBlp(bytes);
    if (result.mode !== 'rgba') throw new Error('jpeg-mode BLP not supported for hover preview');
    return {
        width: result.width,
        height: result.height,
        rgba: Buffer.from(result.rgbaBase64, 'base64'),
        description: result.description,
    };
}

/** Decode BLP/DDS/TGA for preview display (either rgba or jpeg). */
export function decodeRasterPreview(bytes: Uint8Array, ext: string): DecodedRasterImage {
    return ext === '.dds' ? decodeDds(bytes)
         : ext === '.tga' ? decodeTga(bytes)
         : decodeBlp(bytes);
}

/** Persist a base64-encoded JPEG to disk (used by the inline-thumbnail cache). */
export async function writeJpegPreviewFile(jpegBase64: string, outputPath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from(jpegBase64, 'base64'));
}
