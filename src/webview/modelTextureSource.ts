import type { TextureSource } from 'war3-model';
import { base64ToBytes } from './webviewUtils';

function parseDdsInfo(buffer: ArrayBuffer): any {
    const view = new DataView(buffer);
    if (view.byteLength < 128 || view.getUint32(0, true) !== 0x20534444) throw new Error('invalid DDS');
    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const mipMapCount = Math.max(1, view.getUint32(28, true) || 1);
    const fourCc = String.fromCharCode(view.getUint8(84), view.getUint8(85), view.getUint8(86), view.getUint8(87)).toUpperCase();
    const blockBytes = fourCc === 'DXT1' ? 8 : (fourCc === 'DXT3' || fourCc === 'DXT5' ? 16 : 0);
    if (!blockBytes) throw new Error(`unsupported DDS ${fourCc}`);
    const images: any[] = [];
    let offset = 128;
    let levelWidth = width;
    let levelHeight = height;
    for (let level = 0; level < mipMapCount && offset < view.byteLength; level++) {
        const length = Math.max(1, Math.ceil(levelWidth / 4)) * Math.max(1, Math.ceil(levelHeight / 4)) * blockBytes;
        images.push({ offset, length, shape: { width: levelWidth, height: levelHeight } });
        offset += length;
        levelWidth = Math.max(1, levelWidth >> 1);
        levelHeight = Math.max(1, levelHeight >> 1);
    }
    return {
        shape: { width, height },
        images,
        format: fourCc === 'DXT1' ? 'dxt1' : fourCc === 'DXT3' ? 'dxt3' : 'dxt5',
        flags: view.getUint32(8, true),
    };
}

export function textureSource(message: any): TextureSource {
    const buffer: ArrayBuffer = message.textureBytes instanceof ArrayBuffer
        ? message.textureBytes
        : ArrayBuffer.isView(message.textureBytes) ? message.textureBytes.buffer.slice(message.textureBytes.byteOffset, message.textureBytes.byteOffset + message.textureBytes.byteLength)
        : message.textureBytes ? new Uint8Array(Object.values(message.textureBytes) as number[]).buffer
        : base64ToBytes(message.blpBase64 || message.ddsBase64 || message.rgbaBase64 || '').buffer;
    if (message.textureExt === 'blp' || message.blpBase64) return { type: 'blp', buffer };
    if (message.textureExt === 'dds' || message.ddsBase64) {
        const info = parseDdsInfo(buffer);
        return { type: 'dds', buffer, info,
            format: info.format === 'dxt1' ? 0x83F0 : info.format === 'dxt3' ? 0x83F2 : 0x83F3 };
    }
    if (message.rgbaBase64 && message.width && message.height) {
        return { type: 'imageData', imageData: [new ImageData(new Uint8ClampedArray(buffer), message.width, message.height)] };
    }
    throw new Error('unsupported texture payload');
}
