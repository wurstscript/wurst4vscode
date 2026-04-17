'use strict';

import * as fs from 'fs';
import * as path from 'path';

const CONTENT_JPEG = 0;
const CONTENT_DIRECT = 1;
const MAX_DIMENSION = 65535;
const DDS_MAGIC = 0x20534444;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_FOURCC = 0x4;
const DDPF_RGB = 0x40;

export type DecodedRasterImage =
    | {
          kind: 'raster';
          mode: 'rgba';
          width: number;
          height: number;
          rgbaBase64: string;
          warnings: string[];
          description: string;
      }
    | {
          kind: 'raster';
          mode: 'jpeg';
          width: number;
          height: number;
          jpegBase64: string;
          warnings: string[];
          description: string;
      };

export type DecodedMdxRaw = {
    kind: 'mdx-raw';
    mdxBase64: string;
    fileName: string;
};

export type DecodedBlpImage = DecodedRasterImage | DecodedMdxRaw;

export class ByteReader {
    private pos = 0;

    constructor(private readonly bytes: Uint8Array) {}

    readChar4(): string {
        const chunk = this.readStrict(4, 'magic');
        return String.fromCharCode(chunk[0], chunk[1], chunk[2], chunk[3]);
    }

    readU8(name: string): number {
        return this.readStrict(1, name)[0];
    }

    readI32LE(name: string): number {
        const chunk = this.readStrict(4, name);
        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        return view.getInt32(0, true);
    }

    readPadded(size: number, _fieldName: string): Uint8Array {
        const safeSize = Math.max(0, size);
        const available = Math.min(safeSize, this.remaining());
        const out = new Uint8Array(safeSize);
        const read = this.read(available);
        out.set(read, 0);
        return out;
    }

    read(size: number): Uint8Array {
        const safeSize = Math.max(0, size);
        const available = Math.min(safeSize, this.remaining());
        const out = new Uint8Array(available);
        out.set(this.bytes.subarray(this.pos, this.pos + available), 0);
        this.pos += available;
        return out;
    }

    remaining(): number {
        return this.bytes.length - this.pos;
    }

    size(): number {
        return this.bytes.length;
    }

    copy(offset: number, size: number): Uint8Array {
        if (offset < 0 || size <= 0 || offset >= this.bytes.length) {
            return new Uint8Array(0);
        }
        const available = Math.min(size, this.bytes.length - offset);
        return this.bytes.slice(offset, offset + available);
    }

    private readStrict(size: number, fieldName: string): Uint8Array {
        if (size < 0 || this.remaining() < size) {
            throw new Error(`${fieldName} is truncated`);
        }
        return this.read(size);
    }
}

/** Exported for use by imagePreviewHover — decodes BLP/DDS/TGA to raw RGBA. */
export function decodeToRgba(bytes: Uint8Array, ext: string): { width: number; height: number; rgba: Uint8Array; description: string } {
    const result = ext === '.dds' ? decodeDds(bytes)
                 : ext === '.tga' ? decodeTga(bytes)
                 : decodeBlp(bytes);
    if (result.mode !== 'rgba') throw new Error('jpeg-mode BLP not supported for hover preview');
    return { width: result.width, height: result.height, rgba: Buffer.from(result.rgbaBase64, 'base64'), description: result.description };
}

export function decodeRasterPreview(bytes: Uint8Array, ext: string): DecodedRasterImage {
    return ext === '.dds' ? decodeDds(bytes)
         : ext === '.tga' ? decodeTga(bytes)
         : decodeBlp(bytes);
}

export async function writeJpegPreviewFile(jpegBase64: string, outputPath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from(jpegBase64, 'base64'));
}

export function decodeBlp(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeBlpInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading BLP: ${message}`);
    }
}

export function decodeDds(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeDdsInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading DDS: ${message}`);
    }
}

export function decodeTga(sourceBytes: Uint8Array): DecodedRasterImage {
    try {
        return decodeTgaInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading TGA: ${message}`);
    }
}

function decodeTgaInternal(src: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    if (src.length < 18) throw new Error('TGA header is truncated');

    const idLen        = src[0];
    const colorMapType = src[1];
    const imageType    = src[2];
    // image descriptor bytes
    const width  = src[12] | (src[13] << 8);
    const height = src[14] | (src[15] << 8);
    const bpp    = src[16]; // bits per pixel
    const descriptor = src[17];
    const originTop  = (descriptor & 0x20) !== 0; // bit 5: top-left origin

    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`invalid TGA dimensions ${width}x${height}`);
    }
    if (colorMapType !== 0) throw new Error('colour-mapped TGA not supported');

    // Supported types: 2 = uncompressed RGB/RGBA, 3 = uncompressed greyscale,
    //                  10 = RLE RGB/RGBA, 11 = RLE greyscale
    const isRle       = imageType === 10 || imageType === 11;
    const isGrey      = imageType === 3  || imageType === 11;
    const isRgb       = imageType === 2  || imageType === 10;
    if (!isRgb && !isGrey) throw new Error(`unsupported TGA image type ${imageType}`);

    const bytesPerPixel = bpp >> 3; // 3 = BGR, 4 = BGRA, 1 = grey
    if (bytesPerPixel !== 1 && bytesPerPixel !== 3 && bytesPerPixel !== 4) {
        throw new Error(`unsupported TGA bpp ${bpp}`);
    }

    let offset = 18 + idLen; // skip header + image ID
    const pixelCount = width * height;
    const rgba = new Uint8Array(pixelCount * 4);

    const readPixel = (dst: Uint8Array, dstOff: number): void => {
        if (isGrey) {
            const v = src[offset++];
            dst[dstOff]     = v;
            dst[dstOff + 1] = v;
            dst[dstOff + 2] = v;
            dst[dstOff + 3] = 255;
        } else if (bytesPerPixel === 3) {
            dst[dstOff]     = src[offset + 2]; // R
            dst[dstOff + 1] = src[offset + 1]; // G
            dst[dstOff + 2] = src[offset];     // B
            dst[dstOff + 3] = 255;
            offset += 3;
        } else {
            dst[dstOff]     = src[offset + 2]; // R
            dst[dstOff + 1] = src[offset + 1]; // G
            dst[dstOff + 2] = src[offset];     // B
            dst[dstOff + 3] = src[offset + 3]; // A
            offset += 4;
        }
    };

    if (!isRle) {
        for (let i = 0; i < pixelCount; i++) readPixel(rgba, i * 4);
    } else {
        let i = 0;
        while (i < pixelCount) {
            const rep = src[offset++];
            const count = (rep & 0x7f) + 1;
            if (rep & 0x80) {
                // RLE packet — read one pixel, repeat it
                const tmp = new Uint8Array(4);
                readPixel(tmp, 0);
                for (let c = 0; c < count && i < pixelCount; c++, i++) {
                    rgba[i * 4]     = tmp[0];
                    rgba[i * 4 + 1] = tmp[1];
                    rgba[i * 4 + 2] = tmp[2];
                    rgba[i * 4 + 3] = tmp[3];
                }
            } else {
                // Raw packet
                for (let c = 0; c < count && i < pixelCount; c++, i++) readPixel(rgba, i * 4);
            }
        }
    }

    // TGA default origin is bottom-left; flip vertically unless top-left flag is set
    if (!originTop) {
        const rowBytes = width * 4;
        const tmp = new Uint8Array(rowBytes);
        for (let y = 0; y < Math.floor(height / 2); y++) {
            const top = y * rowBytes;
            const bot = (height - 1 - y) * rowBytes;
            tmp.set(rgba.subarray(top, top + rowBytes));
            rgba.copyWithin(top, bot, bot + rowBytes);
            rgba.set(tmp, bot);
        }
    }

    const hasAlpha = bytesPerPixel === 4;
    if (!hasAlpha) warnings.push('No alpha channel — opacity set to 100%.');

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `TGA ${isRle ? 'RLE ' : ''}${isGrey ? 'Greyscale' : bpp === 32 ? 'RGBA' : 'RGB'} ${width}×${height}`,
    };
}

function decodeDdsInternal(sourceBytes: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    const warn = (msg: string) => warnings.push(msg);
    const readU32 = (offset: number, label: string): number => {
        if (offset < 0 || offset + 4 > sourceBytes.length) {
            throw new Error(`${label} is truncated`);
        }
        const view = new DataView(sourceBytes.buffer, sourceBytes.byteOffset + offset, 4);
        return view.getUint32(0, true);
    };

    if (sourceBytes.length < 128) {
        throw new Error('DDS header is truncated');
    }
    const magic = readU32(0, 'magic');
    if (magic !== DDS_MAGIC) {
        throw new Error('invalid DDS magic');
    }

    const headerSize = readU32(4, 'headerSize');
    if (headerSize !== 124) {
        warn(`Unexpected DDS header size ${headerSize}, expected 124.`);
    }

    const height = readU32(12, 'height');
    const width = readU32(16, 'width');
    if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`invalid DDS dimensions ${width}x${height}`);
    }

    const mipMapCountRaw = readU32(28, 'mipMapCount');
    const mipMapCount = Math.max(1, mipMapCountRaw || 1);

    const pfSize = readU32(76, 'pixelFormatSize');
    const pfFlags = readU32(80, 'pixelFormatFlags');
    const fourCC = readU32(84, 'fourCC');
    const rgbBitCount = readU32(88, 'rgbBitCount');
    const rMask = readU32(92, 'rMask');
    const gMask = readU32(96, 'gMask');
    const bMask = readU32(100, 'bMask');
    const aMask = readU32(104, 'aMask');

    if (pfSize !== 32) {
        warn(`Unexpected DDS pixel format size ${pfSize}, expected 32.`);
    }

    const payload = sourceBytes.subarray(128);

    if ((pfFlags & DDPF_FOURCC) !== 0) {
        const fourCCText = fourCCToText(fourCC);
        let rgba: Uint8Array;
        if (fourCCText === 'DXT1') {
            rgba = decodeDxt1(payload, width, height, warn);
        } else if (fourCCText === 'DXT3') {
            rgba = decodeDxt3(payload, width, height, warn);
        } else if (fourCCText === 'DXT5') {
            rgba = decodeDxt5(payload, width, height, warn);
        } else {
            throw new Error(`unsupported DDS compression ${fourCCText}`);
        }
        return {
            kind: 'raster',
            mode: 'rgba',
            width,
            height,
            rgbaBase64: Buffer.from(rgba).toString('base64'),
            warnings,
            description: `DDS ${fourCCText} | mipmaps: ${mipMapCount}`,
        };
    }

    if ((pfFlags & DDPF_RGB) === 0 || rgbBitCount !== 32) {
        throw new Error(`unsupported DDS pixel format (flags=${pfFlags}, rgbBitCount=${rgbBitCount})`);
    }

    const pixelCount = safePixelCount(width, height);
    const expectedSize = pixelCount * 4;
    const pixelBytes = resizeChunk(payload, expectedSize, 'DDS RGBA payload', warn);
    const rgba = new Uint8Array(expectedSize);
    const alphaDefault = (pfFlags & DDPF_ALPHAPIXELS) !== 0 ? 0 : 255;

    for (let i = 0; i < pixelCount; i++) {
        const base = i * 4;
        const px = readU32FromArray(pixelBytes, base);
        rgba[base] = extractMaskedChannel(px, rMask, 255);
        rgba[base + 1] = extractMaskedChannel(px, gMask, 255);
        rgba[base + 2] = extractMaskedChannel(px, bMask, 255);
        rgba[base + 3] = extractMaskedChannel(px, aMask, alphaDefault);
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `DDS RGBA${(pfFlags & DDPF_ALPHAPIXELS) !== 0 ? '' : ' (opaque)'} | mipmaps: ${mipMapCount}`,
    };
}

function decodeBlpInternal(sourceBytes: Uint8Array): DecodedRasterImage {
    const warnings: string[] = [];
    const reader = new ByteReader(sourceBytes);
    const warn = (msg: string) => warnings.push(msg);

    const startToken = reader.readChar4();
    if (!startToken.startsWith('BLP')) {
        throw new Error(`Invalid BLP magic: ${startToken}`);
    }

    const version = startToken.charCodeAt(3) - '0'.charCodeAt(0);
    if (version < 0 || version > 2) {
        throw new Error(`Unsupported BLP version ${version}`);
    }
    if (version === 0) {
        throw new Error('BLP0 is not supported (external bXX mipmap files required)');
    }

    const typeRaw = reader.readI32LE('contentType');
    let type = typeRaw;
    if (type !== CONTENT_JPEG && type !== CONTENT_DIRECT) {
        warn(`Invalid content type ${typeRaw}; defaulting to JPEG.`);
        type = CONTENT_JPEG;
    }

    let hasMipmaps = false;
    let pixmapType = 1;
    let alphaBits = 0;
    if (version >= 2) {
        pixmapType = reader.readU8('pixmapType');
        if (pixmapType < 1 || pixmapType > 3) {
            warn(`Invalid pixmapType ${pixmapType} for BLP2, continuing.`);
        }
        alphaBits = normalizeAlphaBits(reader.readU8('alphaBits'), type, warn);
        reader.readU8('sampleType');
        hasMipmaps = reader.readU8('hasMipmaps') !== 0;
    } else {
        const rawAlphaBits = reader.readI32LE('alphaBits');
        let normalizedRawBits = rawAlphaBits;
        if (rawAlphaBits !== 0 && rawAlphaBits !== 1 && rawAlphaBits !== 4 && rawAlphaBits !== 8) {
            if ((rawAlphaBits & 0x8) > 0) {
                warn(`BLP1 alphaBits ${rawAlphaBits} looked flag-encoded; treating as 8-bit alpha.`);
                normalizedRawBits = 8;
            }
        }
        alphaBits = normalizeAlphaBits(normalizedRawBits, type, warn);
    }

    const width = validateDimension('width', reader.readI32LE('width'), version);
    const height = validateDimension('height', reader.readI32LE('height'), version);
    const hasAlpha = alphaBits > 0;

    if (version < 2) {
        reader.readI32LE('unknownField');
        hasMipmaps = reader.readI32LE('hasMipmaps') !== 0;
    }
    const mipmapCount = getMipmapLevelCount(width, height, hasMipmaps);

    const mipmapOffsets = new Array<number>(16).fill(0);
    const mipmapSizes = new Array<number>(16).fill(0);
    for (let i = 0; i < 16; i++) {
        mipmapOffsets[i] = reader.readI32LE(`mipmapOffset${i}`);
    }
    for (let i = 0; i < 16; i++) {
        mipmapSizes[i] = reader.readI32LE(`mipmapSize${i}`);
    }

    if (type === CONTENT_JPEG) {
        const headerSize = reader.readI32LE('jpegHeaderSize');
        if (headerSize < 0) {
            throw new Error(`Invalid JPEG header size: ${headerSize}`);
        }
        if (headerSize > 0x270) {
            warn(`JPEG header size ${headerSize} exceeds recommended max of 624 bytes.`);
        }
        const headerBytes = reader.readPadded(headerSize, 'jpegHeader');
        const mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
        if (mipmapData0.length === 0) {
            throw new Error('Missing or invalid JPEG mipmap level 0.');
        }
        const jpegBytes = new Uint8Array(headerBytes.length + mipmapData0.length);
        jpegBytes.set(headerBytes, 0);
        jpegBytes.set(mipmapData0, headerBytes.length);

        return {
            kind: 'raster',
            mode: 'jpeg',
            width,
            height,
            jpegBase64: Buffer.from(jpegBytes).toString('base64'),
            warnings,
            description: `BLP${version} JPEG | mipmaps: ${mipmapCount}`,
        };
    }

    if (version >= 2 && pixmapType === 3) {
        const pixelCount = safePixelCount(width, height);
        const expectedChunkSize = pixelCount * 4;
        let mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
        if (mipmapData0.length === 0) {
            throw new Error('Missing or invalid BGRA mipmap level 0.');
        }
        mipmapData0 = resizeChunk(mipmapData0, expectedChunkSize, 'BGRA mipmap 0 payload', warn);

        const rgba = new Uint8Array(expectedChunkSize);
        for (let src = 0, dst = 0; src < mipmapData0.length; src += 4, dst += 4) {
            const blue = mipmapData0[src];
            const green = mipmapData0[src + 1];
            const red = mipmapData0[src + 2];
            const alpha = mipmapData0[src + 3];
            rgba[dst] = red;
            rgba[dst + 1] = green;
            rgba[dst + 2] = blue;
            rgba[dst + 3] = alpha;
        }

        return {
            kind: 'raster',
            mode: 'rgba',
            width,
            height,
            rgbaBase64: Buffer.from(rgba).toString('base64'),
            warnings,
            description: `BLP${version} direct BGRA | mipmaps: ${mipmapCount}`,
        };
    }

    if (version >= 2 && pixmapType === 2) {
        throw new Error('BLP2 compressed sample (pixmapType=2) is not supported yet.');
    }

    const colorTableBytes = reader.readPadded(256 * 4, 'direct color table');

    const pixelCount = safePixelCount(width, height);
    const alphaSize = hasAlpha ? Math.floor((pixelCount * alphaBits + 7) / 8) : 0;
    const expectedChunkSize = pixelCount + alphaSize;

    let mipmapData0 = getMipmapChunk(reader, mipmapOffsets, mipmapSizes, 0, warn);
    if (mipmapData0.length === 0) {
        throw new Error('Missing or invalid direct mipmap level 0.');
    }
    mipmapData0 = resizeChunk(mipmapData0, expectedChunkSize, 'direct mipmap 0 payload', warn);

    const indexList = mipmapData0.subarray(0, pixelCount);
    const alphaList = hasAlpha ? mipmapData0.subarray(pixelCount, pixelCount + alphaSize) : new Uint8Array(0);
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        const colorIndex = indexList[i] & 0xff;
        const paletteOffset = colorIndex * 4;
        rgba[i * 4] = colorTableBytes[paletteOffset + 2];
        rgba[i * 4 + 1] = colorTableBytes[paletteOffset + 1];
        rgba[i * 4 + 2] = colorTableBytes[paletteOffset];
        rgba[i * 4 + 3] = hasAlpha ? readAlpha(alphaList, i, alphaBits) : 0xff;
    }

    return {
        kind: 'raster',
        mode: 'rgba',
        width,
        height,
        rgbaBase64: Buffer.from(rgba).toString('base64'),
        warnings,
        description: `BLP${version} indexed direct | mipmaps: ${mipmapCount}`,
    };
}

function readAlpha(alphaData: Uint8Array, pixelIndex: number, alphaBits: number): number {
    if (alphaBits <= 0) return 0xff;
    if (alphaBits === 1) {
        const byteIndex = Math.floor(pixelIndex / 8);
        if (byteIndex >= alphaData.length) return 0xff;
        const bit = (alphaData[byteIndex] >> (pixelIndex % 8)) & 0x1;
        return bit === 0 ? 0x00 : 0xff;
    }
    if (alphaBits === 4) {
        const byteIndex = Math.floor(pixelIndex / 2);
        if (byteIndex >= alphaData.length) return 0xff;
        const nibble = pixelIndex % 2 === 0 ? alphaData[byteIndex] & 0x0f : (alphaData[byteIndex] >> 4) & 0x0f;
        return Math.floor((nibble * 0xff) / 0x0f);
    }
    if (pixelIndex >= alphaData.length) return 0xff;
    return alphaData[pixelIndex] & 0xff;
}

function normalizeAlphaBits(rawAlphaBits: number, contentType: number, warn: (msg: string) => void): number {
    if (contentType === CONTENT_JPEG) {
        if (rawAlphaBits === 0 || rawAlphaBits === 8) return rawAlphaBits;
        warn(`Invalid alphaBits ${rawAlphaBits} for JPEG; treating as 0.`);
        return 0;
    }
    if (rawAlphaBits === 0 || rawAlphaBits === 1 || rawAlphaBits === 4 || rawAlphaBits === 8) {
        return rawAlphaBits;
    }
    warn(`Invalid alphaBits ${rawAlphaBits} for direct content; treating as 0.`);
    return 0;
}

function getMipmapLevelCount(width: number, height: number, hasMipmaps: boolean): number {
    if (!hasMipmaps) return 1;
    let levels = 1;
    let maxDim = Math.max(width, height);
    while (maxDim > 1 && levels < 16) {
        maxDim = Math.max(1, Math.floor(maxDim / 2));
        levels++;
    }
    return levels;
}

function validateDimension(fieldName: string, value: number, version: number): number {
    if (value <= 0) {
        throw new Error(`${fieldName} ${value} is invalid`);
    }
    if (value > MAX_DIMENSION) {
        throw new Error(`${fieldName} ${value} exceeds max ${MAX_DIMENSION}`);
    }
    if (version === 0 && value > 512) {
        // BLP0 is unsupported anyway; this mirrors the Java diagnostic behavior.
    }
    return value;
}

function safePixelCount(width: number, height: number): number {
    const pixelCount = width * height;
    if (!Number.isFinite(pixelCount) || pixelCount <= 0 || pixelCount > 0x7fffffff) {
        throw new Error(`pixelCount ${pixelCount} is too large`);
    }
    return pixelCount;
}

function getMipmapChunk(
    reader: ByteReader,
    mipmapOffsets: number[],
    mipmapSizes: number[],
    mipmapLevel: number,
    warn: (msg: string) => void
): Uint8Array {
    if (mipmapLevel < 0 || mipmapLevel >= 16) return new Uint8Array(0);
    const offset = mipmapOffsets[mipmapLevel];
    const size = mipmapSizes[mipmapLevel];
    if (offset <= 0 || size <= 0) {
        warn(`Mipmap ${mipmapLevel} has invalid location offset=${offset} size=${size}.`);
        return new Uint8Array(0);
    }
    if (offset >= reader.size()) {
        warn(`Mipmap ${mipmapLevel} offset ${offset} is past EOF ${reader.size()}.`);
        return new Uint8Array(0);
    }
    const available = Math.min(size, reader.size() - offset);
    if (available < size) {
        warn(`Mipmap ${mipmapLevel} truncated at EOF (expected ${size}, got ${available}).`);
    }
    return reader.copy(offset, available);
}

function resizeChunk(
    src: Uint8Array,
    expectedSize: number,
    label: string,
    warn: (msg: string) => void
): Uint8Array {
    if (src.length === expectedSize) return src;
    if (src.length < expectedSize) {
        warn(`${label} smaller than expected (expected ${expectedSize}, got ${src.length}), padding with zeros.`);
    } else {
        warn(`${label} larger than expected (expected ${expectedSize}, got ${src.length}), truncating.`);
    }
    const out = new Uint8Array(expectedSize);
    out.set(src.subarray(0, Math.min(src.length, expectedSize)), 0);
    return out;
}

function fourCCToText(fourCC: number): string {
    const a = String.fromCharCode(fourCC & 0xff);
    const b = String.fromCharCode((fourCC >> 8) & 0xff);
    const c = String.fromCharCode((fourCC >> 16) & 0xff);
    const d = String.fromCharCode((fourCC >> 24) & 0xff);
    return `${a}${b}${c}${d}`;
}

function readU16FromArray(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readU32FromArray(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decode565(v: number): [number, number, number] {
    const r = (v >> 11) & 0x1f;
    const g = (v >> 5) & 0x3f;
    const b = v & 0x1f;
    return [
        Math.floor((r * 255 + 15) / 31),
        Math.floor((g * 255 + 31) / 63),
        Math.floor((b * 255 + 15) / 31),
    ];
}

function decodeDxtColors(c0: number, c1: number, transparentIfLte: boolean): Array<[number, number, number, number]> {
    const [r0, g0, b0] = decode565(c0);
    const [r1, g1, b1] = decode565(c1);
    const colors: Array<[number, number, number, number]> = [
        [r0, g0, b0, 255],
        [r1, g1, b1, 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
    ];

    if (transparentIfLte && c0 <= c1) {
        colors[2] = [Math.floor((r0 + r1) / 2), Math.floor((g0 + g1) / 2), Math.floor((b0 + b1) / 2), 255];
        colors[3] = [0, 0, 0, 0];
    } else {
        colors[2] = [
            Math.floor((2 * r0 + r1) / 3),
            Math.floor((2 * g0 + g1) / 3),
            Math.floor((2 * b0 + b1) / 3),
            255,
        ];
        colors[3] = [
            Math.floor((r0 + 2 * r1) / 3),
            Math.floor((g0 + 2 * g1) / 3),
            Math.floor((b0 + 2 * b1) / 3),
            255,
        ];
    }

    return colors;
}

function decodeDxt1(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 8;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT1 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const c0 = readU16FromArray(data, p);
            const c1 = readU16FromArray(data, p + 2);
            const idx = readU32FromArray(data, p + 4);
            p += 8;

            const colors = decodeDxtColors(c0, c1, true);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const code = (idx >> (2 * (py * 4 + px))) & 0x03;
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = c[3];
                }
            }
        }
    }
    return rgba;
}

function decodeDxt3(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 16;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT3 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const alphaLo = readU32FromArray(data, p);
            const alphaHi = readU32FromArray(data, p + 4);
            const c0 = readU16FromArray(data, p + 8);
            const c1 = readU16FromArray(data, p + 10);
            const idx = readU32FromArray(data, p + 12);
            p += 16;

            const colors = decodeDxtColors(c0, c1, false);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const pix = py * 4 + px;
                    const code = (idx >> (2 * pix)) & 0x03;
                    const alphaNybble = pix < 8
                        ? (alphaLo >> (4 * pix)) & 0x0f
                        : (alphaHi >> (4 * (pix - 8))) & 0x0f;
                    const alpha = Math.floor((alphaNybble * 255) / 15);
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = alpha;
                }
            }
        }
    }
    return rgba;
}

function decodeDxt5(payload: Uint8Array, width: number, height: number, warn: (msg: string) => void): Uint8Array {
    const blocksWide = Math.max(1, Math.ceil(width / 4));
    const blocksHigh = Math.max(1, Math.ceil(height / 4));
    const expectedSize = blocksWide * blocksHigh * 16;
    const data = resizeChunk(payload, expectedSize, 'DDS DXT5 payload', warn);
    const rgba = new Uint8Array(width * height * 4);

    let p = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            const a0 = data[p];
            const a1 = data[p + 1];
            const alphaIdx = data.subarray(p + 2, p + 8);
            const c0 = readU16FromArray(data, p + 8);
            const c1 = readU16FromArray(data, p + 10);
            const idx = readU32FromArray(data, p + 12);
            p += 16;

            const alphas = new Uint8Array(8);
            alphas[0] = a0;
            alphas[1] = a1;
            if (a0 > a1) {
                alphas[2] = Math.floor((6 * a0 + a1) / 7);
                alphas[3] = Math.floor((5 * a0 + 2 * a1) / 7);
                alphas[4] = Math.floor((4 * a0 + 3 * a1) / 7);
                alphas[5] = Math.floor((3 * a0 + 4 * a1) / 7);
                alphas[6] = Math.floor((2 * a0 + 5 * a1) / 7);
                alphas[7] = Math.floor((a0 + 6 * a1) / 7);
            } else {
                alphas[2] = Math.floor((4 * a0 + a1) / 5);
                alphas[3] = Math.floor((3 * a0 + 2 * a1) / 5);
                alphas[4] = Math.floor((2 * a0 + 3 * a1) / 5);
                alphas[5] = Math.floor((a0 + 4 * a1) / 5);
                alphas[6] = 0;
                alphas[7] = 255;
            }

            const alphaBitsLo = (alphaIdx[0] | (alphaIdx[1] << 8) | (alphaIdx[2] << 16)) >>> 0;
            const alphaBitsHi = (alphaIdx[3] | (alphaIdx[4] << 8) | (alphaIdx[5] << 16)) >>> 0;

            const colors = decodeDxtColors(c0, c1, false);
            for (let py = 0; py < 4; py++) {
                for (let px = 0; px < 4; px++) {
                    const x = bx * 4 + px;
                    const y = by * 4 + py;
                    if (x >= width || y >= height) continue;
                    const pix = py * 4 + px;
                    const code = (idx >> (2 * pix)) & 0x03;
                    const bitPos = 3 * pix;
                    let aCode: number;
                    if (bitPos <= 21) {
                        aCode = (alphaBitsLo >> bitPos) & 0x07;
                    } else if (bitPos >= 24) {
                        aCode = (alphaBitsHi >> (bitPos - 24)) & 0x07;
                    } else {
                        const lowPart = (alphaBitsLo >> bitPos) & 0x03;
                        const highPart = (alphaBitsHi & 0x01) << 2;
                        aCode = lowPart | highPart;
                    }
                    const out = (y * width + x) * 4;
                    const c = colors[code];
                    rgba[out] = c[0];
                    rgba[out + 1] = c[1];
                    rgba[out + 2] = c[2];
                    rgba[out + 3] = alphas[aCode];
                }
            }
        }
    }
    return rgba;
}

function trailingZeroBits(mask: number): number {
    let shift = 0;
    let m = mask >>> 0;
    while (shift < 32 && (m & 1) === 0) {
        m >>>= 1;
        shift++;
    }
    return shift;
}

function bitCount(mask: number): number {
    let m = mask >>> 0;
    let count = 0;
    while (m !== 0) {
        count += m & 1;
        m >>>= 1;
    }
    return count;
}

function extractMaskedChannel(pixel: number, mask: number, fallback: number): number {
    if (mask === 0) return fallback;
    const shift = trailingZeroBits(mask);
    const bits = bitCount(mask);
    if (bits <= 0) return fallback;
    const value = (pixel & mask) >>> shift;
    const max = (1 << bits) - 1;
    if (max <= 0) return fallback;
    return Math.floor((value * 255 + Math.floor(max / 2)) / max);
}
