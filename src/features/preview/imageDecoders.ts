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
import { decodeBlp, decodeDds, decodeTga, DecodedRasterImage } from 'casc-ts/formats';

export { decodeBlp, decodeDds, decodeTga };
export type { DecodedRasterImage };

/**
 * MDX files are passed through as-is — they're decoded in the webview via the
 * `war3-model` package. Keeps the preview-dispatcher return type uniform.
 */
export type DecodedMdxRaw = {
    kind: 'mdx-raw';
    mdxBase64: string;
    fileName: string;
};

export type DecodedBlpImage = DecodedRasterImage | DecodedMdxRaw;

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
