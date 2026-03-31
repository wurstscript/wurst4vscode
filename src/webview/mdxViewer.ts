import { parseMDX, ModelRenderer, decodeBLP, getBLPImageData } from 'war3-model';

// ─── types ──────────────────────────────────────────────────────────────────

export interface SequenceInfo {
    name: string;
    start: number;
    end: number;
    looping: boolean;
}

export interface ModelLoadedInfo {
    name: string;
    geosetCount: number;
    textureCount: number;
    sequences: SequenceInfo[];
    texturePaths: string[];
}

export interface War3ViewerCallbacks {
    onModelLoaded(info: ModelLoadedInfo): void;
    onFrameUpdate(frame: number, seqStart: number, seqEnd: number): void;
    onDebug(msg: string): void;
}

export interface War3ViewerInitOptions {
    canvas3d: HTMLCanvasElement;
    gizmo: HTMLCanvasElement;
    viewport: HTMLElement;
    vscodeApi: { postMessage(msg: unknown): void };
    callbacks: War3ViewerCallbacks;
}

// ─── module state ────────────────────────────────────────────────────────────

let renderer: ModelRenderer | null = null;
let gl: WebGL2RenderingContext | null = null;
let canvas: HTMLCanvasElement | null = null;
let gizmoCanvas: HTMLCanvasElement | null = null;
let vscodeApi: { postMessage(msg: unknown): void } | null = null;
let callbacks: War3ViewerCallbacks | null = null;
let animLoopHandle = 0;
let lastTimestamp = 0;
let autoplay = true;
let war3ModelConsoleHooked = false;
let originalConsoleLog: typeof console.log | null = null;

function isWar3ModelDebugEnabled(): boolean {
    const runtime = window as Window & typeof globalThis & {
        __WAR3_MODEL_DEBUG?: boolean | string | number;
    };
    const debugFlag = runtime.__WAR3_MODEL_DEBUG;
    if (debugFlag === true || debugFlag === '1' || debugFlag === 1 || debugFlag === 'true') {
        return true;
    }
    try {
        if (/(?:\?|&)war3ModelDebug=(?:1|true)(?:&|$)/i.test(window.location.search)) {
            return true;
        }
    } catch {
        // ignore URL access issues
    }
    try {
        const storedValue = window.localStorage.getItem('war3-model-debug');
        if (storedValue === '1' || storedValue === 'true') {
            return true;
        }
    } catch {
        // ignore storage access issues
    }
    return false;
}

// camera (Z-up, WC3 space)
let yaw = Math.PI * 0.5;
let pitch = -0.3;
let distance = 3.0;
const center: [number, number, number] = [0, 0, 0];

let wireframe = false;
let currentSeqs: SequenceInfo[] = [];
let currentSeqIndex = 0;
const initialCenter: [number, number, number] = [0, 0, 0];
let initialDistance = 3.0;

function hookWar3ModelConsole() {
    if (war3ModelConsoleHooked) return;
    war3ModelConsoleHooked = true;
    originalConsoleLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
        originalConsoleLog?.(...args);
        if (args[0] === '[war3-model]' && isWar3ModelDebugEnabled()) {
            const msg = args.slice(1).map((part) => {
                if (typeof part === 'string') return part;
                try {
                    return JSON.stringify(part);
                } catch {
                    return String(part);
                }
            }).join(' ');
            callbacks?.onDebug(`[war3-model] ${msg}`);
        }
    };
}

// ─── matrix math ─────────────────────────────────────────────────────────────

function mat4Perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, (2 * far * near) * nf, 0,
    ]);
}

function mat4LookAt(
    ex: number, ey: number, ez: number,
    tx: number, ty: number, tz: number,
    ux: number, uy: number, uz: number
): Float32Array {
    let z0 = ex - tx, z1 = ey - ty, z2 = ez - tz;
    let len = Math.sqrt(z0 * z0 + z1 * z1 + z2 * z2);
    if (len === 0) { z2 = 1; } else { z0 /= len; z1 /= len; z2 /= len; }
    let x0 = uy * z2 - uz * z1, x1 = uz * z0 - ux * z2, x2 = ux * z1 - uy * z0;
    len = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    if (len !== 0) { x0 /= len; x1 /= len; x2 /= len; }
    const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
    return new Float32Array([
        x0, y0, z0, 0,
        x1, y1, z1, 0,
        x2, y2, z2, 0,
        -(x0 * ex + x1 * ey + x2 * ez),
        -(y0 * ex + y1 * ey + y2 * ez),
        -(z0 * ex + z1 * ey + z2 * ez),
        1,
    ]);
}

// ─── render loop ─────────────────────────────────────────────────────────────

function clampPitch(p: number): number {
    const limit = Math.PI * 0.5 - 0.02;
    return Math.max(-limit, Math.min(limit, p));
}

function renderFrame(ts: number) {
    animLoopHandle = requestAnimationFrame(renderFrame);
    if (!canvas || !gl) { lastTimestamp = ts; return; }

    const delta = Math.min(ts - lastTimestamp, 100);
    lastTimestamp = ts;

    if (renderer && autoplay) {
        renderer.update(delta);
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(canvas.clientWidth * pixelRatio));
    const h = Math.max(2, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    if (renderer) {
        const proj = mat4Perspective(50 * Math.PI / 180, w / h, 1, 100000);
        // Z-up orbit camera
        const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
        const ex = center[0] + distance * Math.cos(yaw) * cosP;
        const ey = center[1] + distance * Math.sin(yaw) * cosP;
        const ez = center[2] + distance * sinP;
        const mv = mat4LookAt(ex, ey, ez, center[0], center[1], center[2], 0, 0, 1);
        renderer.render(mv as unknown as import('gl-matrix').mat4, proj as unknown as import('gl-matrix').mat4, { wireframe });

        // report frame to inline script for slider
        if (callbacks && currentSeqs.length > 0) {
            const seq = currentSeqs[currentSeqIndex];
            if (seq) {
                callbacks.onFrameUpdate(renderer.getFrame(), seq.start, seq.end);
            }
        }
    }

    renderGizmo();
}

// ─── gizmo ────────────────────────────────────────────────────────────────────

function renderGizmo() {
    if (!gizmoCanvas) return;
    const g = gizmoCanvas.getContext('2d');
    if (!g) return;
    const w = gizmoCanvas.width, h = gizmoCanvas.height;
    const cx = w / 2, cy = h / 2;
    g.clearRect(0, 0, w, h);

    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const cosX = Math.cos(pitch), sinX = Math.sin(pitch);

    const axes: Array<{ name: string; color: string; v: [number, number, number] }> = [
        { name: 'X', color: '#e35d6a', v: [1, 0, 0] },
        { name: 'Y', color: '#68c07a', v: [0, 1, 0] },
        { name: 'Z', color: '#5ca0e3', v: [0, 0, 1] },
    ];

    function rot(vx: number, vy: number, vz: number): [number, number, number] {
        const x1 = vx * cosY - vy * sinY;
        const y1 = vx * sinY * (-sinX) + vy * cosY * (-sinX) + vz * cosX;
        const z2 = vx * sinY * cosX + vy * (-cosY) * cosX + vz * sinX;
        return [x1, y1, z2];
    }

    axes.sort((a, b) => rot(...a.v)[2] - rot(...b.v)[2]);
    for (const axis of axes) {
        const r = rot(...axis.v);
        const sx = cx + r[0] * 24;
        const sy = cy - r[1] * 24;
        g.strokeStyle = axis.color;
        g.fillStyle = axis.color;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(cx, cy);
        g.lineTo(sx, sy);
        g.stroke();
        g.font = '11px sans-serif';
        g.fillText(axis.name, sx + 3, sy - 3);
    }
    g.fillStyle = '#888b';
    g.beginPath();
    g.arc(cx, cy, 3, 0, Math.PI * 2);
    g.fill();
}

// ─── camera orbit input ───────────────────────────────────────────────────────

function setupOrbitCamera(vp: HTMLElement) {
    // button 0 = orbit, button 1 = pan (middle), button 2 = pan (right)
    const ORBIT = 0, PAN_BTN1 = 1, PAN_BTN2 = 2;
    let orbitActive = false;
    let panActive = false;
    let lastX = 0, lastY = 0;

    vp.addEventListener('contextmenu', (ev) => ev.preventDefault());

    vp.addEventListener('pointerdown', (ev) => {
        if (ev.button === ORBIT) {
            orbitActive = true;
        } else if (ev.button === PAN_BTN1 || ev.button === PAN_BTN2) {
            panActive = true;
        } else { return; }
        lastX = ev.clientX;
        lastY = ev.clientY;
        vp.setPointerCapture(ev.pointerId);
        vp.classList.add('dragging');
    });

    vp.addEventListener('pointermove', (ev) => {
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;

        if (orbitActive) {
            yaw -= dx * 0.008;
            pitch = clampPitch(pitch + dy * 0.008);
        } else if (panActive) {
            // Pan: move center in camera right/up plane
            const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
            const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
            // Camera right (in world XY plane)
            const rx = -sinY, ry = cosY;
            // Camera up (perpendicular to right and view direction)
            const ux = -cosY * sinP, uy = -sinY * sinP, uz = cosP;
            const scale = distance * 0.001;
            center[0] += (-dx * rx + dy * ux) * scale;
            center[1] += (-dx * ry + dy * uy) * scale;
            center[2] += dy * uz * scale;
        }
    });

    function stopDrag(ev: PointerEvent) {
        if (!orbitActive && !panActive) return;
        orbitActive = false;
        panActive = false;
        vp.classList.remove('dragging');
        try { vp.releasePointerCapture(ev.pointerId); } catch { /* ok */ }
    }
    vp.addEventListener('pointerup', stopDrag);
    vp.addEventListener('pointercancel', stopDrag);

    vp.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY > 0 ? 1.12 : 1 / 1.12;
        distance = Math.max(1, Math.min(200000, distance * factor));
    }, { passive: false });
}

// ─── public API ───────────────────────────────────────────────────────────────

const War3Viewer = {
    init(opts: War3ViewerInitOptions) {
        canvas = opts.canvas3d;
        gizmoCanvas = opts.gizmo;
        vscodeApi = opts.vscodeApi;
        callbacks = opts.callbacks;
        hookWar3ModelConsole();
        setupOrbitCamera(opts.viewport);
        if (!animLoopHandle) {
            lastTimestamp = performance.now();
            animLoopHandle = requestAnimationFrame(renderFrame);
        }
    },

    loadModel(buffer: ArrayBuffer, fileName: string) {
        const cb = callbacks;
        try {
            if (renderer) { renderer.destroy(); renderer = null; }
            gl = null;

            const model = parseMDX(buffer);

            if (!canvas) throw new Error('canvas not initialized');
            const newGl = canvas.getContext('webgl2', { antialias: true, alpha: true, depth: true });
            if (!newGl) throw new Error('WebGL2 unavailable');
            gl = newGl;

            renderer = new ModelRenderer(model);
            renderer.initGL(gl);

            // camera from model bounds
            const info = model.Info;
            const min = info.MinimumExtent, max = info.MaximumExtent;
            center[0] = (min[0] + max[0]) / 2;
            center[1] = (min[1] + max[1]) / 2;
            center[2] = (min[2] + max[2]) / 2;
            initialCenter[0] = center[0]; initialCenter[1] = center[1]; initialCenter[2] = center[2];
            const radius = info.BoundsRadius > 0 ? info.BoundsRadius
                : Math.sqrt(Math.pow(max[0] - min[0], 2) + Math.pow(max[1] - min[1], 2) + Math.pow(max[2] - min[2], 2)) / 2 || 100;
            distance = Math.max(1, radius * 2.5);
            initialDistance = distance;
            yaw = Math.PI * 0.5;
            pitch = -0.3;

            // sequences
            currentSeqs = model.Sequences.map(s => ({
                name: s.Name.replace(/\0/g, '').trim(),
                start: s.Interval[0],
                end: s.Interval[1],
                looping: !s.NonLooping,
            }));
            currentSeqIndex = currentSeqs.length > 0 ? 0 : -1;
            if (currentSeqIndex >= 0) {
                renderer.setSequence(currentSeqIndex);
            }
            autoplay = true;

            // texture paths (skip replaceable textures like team color)
            const texturePaths = model.Textures
                .filter(t => !t.ReplaceableId && t.Image)
                .map(t => t.Image);

            // Log every texture slot for diagnostics
            model.Textures.forEach((t, i) => {
                cb?.onDebug(`tex[${i}] replaceableId=${t.ReplaceableId} image="${t.Image}"`);
            });

            const loadedInfo: ModelLoadedInfo = {
                name: (info.Name || fileName).replace(/\0/g, '').trim(),
                geosetCount: model.Geosets.length,
                textureCount: model.Textures.length,
                sequences: currentSeqs,
                texturePaths,
            };

            cb?.onModelLoaded(loadedInfo);

            if (texturePaths.length > 0 && vscodeApi) {
                cb?.onDebug(`requesting ${texturePaths.length} texture(s): ${texturePaths.join(', ')}`);
                vscodeApi.postMessage({ type: 'requestTextures', paths: texturePaths });
            } else {
                cb?.onDebug(`no non-replaceable textures to request (${model.Textures.length} total slots)`);
            }
        } catch (e) {
            cb?.onDebug('loadModel error: ' + String(e));
        }
    },

    onTexture(texPath: string, buffer: ArrayBuffer | null) {
        if (!renderer) return;
        if (!buffer) {
            callbacks?.onDebug('texture not found: ' + texPath);
            return;
        }
        try {
            const blp = decodeBLP(buffer);
            const like = getBLPImageData(blp, 0);
            const imageData = new ImageData(
                new Uint8ClampedArray(like.data as unknown as ArrayBuffer),
                like.width,
                like.height
            );
            renderer.setTextureImageData(texPath, [imageData]);
            callbacks?.onDebug('texture ok: ' + texPath);
        } catch (e) {
            callbacks?.onDebug('texture decode error (' + texPath + '): ' + String(e));
        }
    },

    onTextureImageData(texPath: string, imageData: ImageData) {
        if (!renderer) return;
        renderer.setTextureImageData(texPath, [imageData]);
        callbacks?.onDebug('texture (rgba) ok: ' + texPath);
    },

    setSequence(index: number) {
        if (!renderer) return;
        currentSeqIndex = Math.max(-1, index);
        renderer.setSequence(currentSeqIndex);
    },

    setFrame(frame: number) {
        if (!renderer) return;
        autoplay = false;
        renderer.setFrame(frame);
    },

    setAutoplay(enabled: boolean) {
        autoplay = enabled;
    },

    setRenderMode(mode: string) {
        wireframe = mode === 'wire';
    },

    setTeamColor(hex: string) {
        if (!renderer) return;
        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        renderer.setTeamColor(new Float32Array([r, g, b]) as unknown as import('gl-matrix').vec3);
    },

    resetCamera() {
        yaw = Math.PI * 0.5;
        pitch = -0.3;
        distance = initialDistance;
        center[0] = initialCenter[0]; center[1] = initialCenter[1]; center[2] = initialCenter[2];
    },

    zoomIn() {
        distance = Math.max(1, distance * 0.88);
    },

    zoomOut() {
        distance = Math.min(200000, distance * 1.12);
    },
};

// Expose globally for the inline script
(window as unknown as Record<string, unknown>).War3Viewer = War3Viewer;
