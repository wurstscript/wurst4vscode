/** All static model previews use the worker's warm war3-model ThumbnailSession. */
export async function createModelThumbnailWorker(uri: string): Promise<Worker> {
    const response = await fetch(uri);
    if (!response.ok) throw new Error('worker bundle fetch ' + response.status);
    const source = await response.text();
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
        return await new Promise<Worker>((resolve, reject) => {
            const worker = new Worker(url, { name: 'wurst-model-thumbnails' });
            const ready = (event: MessageEvent) => {
                if (event.data?.type !== 'ready') return;
                worker.removeEventListener('message', ready);
                worker.removeEventListener('error', failed);
                resolve(worker);
            };
            const failed = (event: ErrorEvent) => {
                worker.terminate();
                reject(new Error(event.message || 'thumbnail worker startup failed'));
            };
            worker.addEventListener('message', ready);
            worker.addEventListener('error', failed);
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

export function postThumbnailTexture(worker: Worker, message: any): void {
    if (message.textureBytes) {
        const source = message.textureBytes instanceof Uint8Array
            ? message.textureBytes : new Uint8Array(message.textureBytes);
        const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
        worker.postMessage({ ...message, type: 'texture', textureBytes: buffer }, [buffer]);
    } else {
        worker.postMessage({ ...message, type: 'texture' });
    }
}
