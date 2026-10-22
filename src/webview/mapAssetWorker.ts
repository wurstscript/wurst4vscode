import { parseMDX, parseMDL, decodeBLP, getBLPImageData } from 'war3-model';
import { base64ToBytes } from './webviewUtils';
import { textureSource } from './modelTextureSource';

const scope: any = self;
let scene: MessagePort;
function post(message: any, transfers: Transferable[] = []): void { (scene || scope).postMessage(message, transfers); }
function transfer(message: any): void {
  const buffers = new Set<ArrayBuffer>();
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (ArrayBuffer.isView(value)) { buffers.add(value.buffer as ArrayBuffer); return; }
    if (value instanceof ArrayBuffer) { buffers.add(value); return; }
    if (value instanceof ImageData) { buffers.add(value.data.buffer as ArrayBuffer); return; }
    for (const key of Object.keys(value)) if (key !== 'Keys') visit(value[key]);
  };
  visit(message);
  const transfers = [...buffers];
  post({ ...message, transfers }, transfers);
}
scope.onmessage = (event: MessageEvent) => {
  const message = event.data;
  if (message.type === 'scenePort') { scene = message.port; return; }
  try {
    if (message.type === 'parse') {
      const bytes = base64ToBytes(message.mdxBase64).buffer;
      const model = message.format === 'mdl' ? parseMDL(new TextDecoder().decode(bytes)) : parseMDX(bytes);
      if (!model.Sequences.length) model.Sequences.push({ ...model.Info, Name: 'Static',
        Interval: new Uint32Array([0, 1]), MoveSpeed: 0, NonLooping: false, Rarity: 0 });
      transfer({ type: 'parsedModel', path: message.path, model });
    } else if (message.type === 'decodeComplete') {
      post({ type: 'decodedTexturesComplete', thumbKey: message.thumbKey });
    } else if (message.type === 'decode') {
      if (message.missing || message.error || message.unsupported) throw new Error('Texture unavailable');
      let source = textureSource(message);
      if (source.type === 'blp') {
        const blp = decodeBLP(source.buffer);
        const level = Math.min(blp.mipmaps.length - 1, Math.max(0, Math.ceil(Math.log2(Math.max(blp.width, blp.height) / 256))));
        const image = getBLPImageData(blp, level);
        source = { type: 'imageData', imageData: [new ImageData(new Uint8ClampedArray(image.data), image.width, image.height)] };
      }
      transfer({ type: 'decodedTexture', path: message.path, thumbKey: message.thumbKey, source });
    }
  } catch (error) {
    post({ type: message.type === 'parse' ? 'modelFailed' : 'decodedTexture', path: message.path,
      thumbKey: message.thumbKey, error: String(error) });
  }
};
scope.postMessage({ type: 'ready' });
