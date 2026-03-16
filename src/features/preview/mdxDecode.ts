'use strict';

export type MdxSequenceInfo = {
    name: string;
    intervalStart: number;
    intervalEnd: number;
    looping: boolean;
};

export type DecodedMdxModel = {
    kind: 'model';
    modelName: string;
    nodesCount: number;
    geosetsCount: number;
    trianglesCount: number;
    activeSequenceIndex: number;
    sampledFrame: number;
    sequences: MdxSequenceInfo[];
    sequenceTrackSummaries: SequenceTrackSummary[];
    activeNodeTrackObjectIds: number[];
    activeGeosetAlphaIds: number[];
    positionsBase64: string;
    normalsBase64: string;
    indicesBase64: string;
    nodeDebugPositionsBase64: string;
    nodeDebugParentIndexBase64: string;
    nodeDebugAnimatedBase64: string;
    nodeDebugMovedBase64: string;
    warnings: string[];
    description: string;
};

export type SequenceTrackSummary = {
    sequenceIndex: number;
    nodeChannels: number;
    nodeKeys: number;
    geosetAlphaChannels: number;
    geosetAlphaKeys: number;
};

type MdxNode = {
    objectId: number;
    parentId: number;
    flags: number;
    translationKeys: Vec3Track;
    rotationKeys: QuatTrack;
    scalingKeys: Vec3Track;
    pivot: [number, number, number];
};

type TrackInterpolation = 0 | 1 | 2 | 3;
type Vec3Key = { frame: number; value: [number, number, number] };
type QuatKey = { frame: number; value: [number, number, number, number] };
type FloatKey = { frame: number; value: number };
type Vec3Track = { interpolation: TrackInterpolation; keys: Vec3Key[] };
type QuatTrack = { interpolation: TrackInterpolation; keys: QuatKey[] };
type FloatTrack = { interpolation: TrackInterpolation; keys: FloatKey[] };

type GeosetAnim = {
    geosetId: number;
    alpha: number;
    alphaTrack: FloatTrack;
};

const NODE_DONT_INHERIT_TRANSLATION = 0x1;
const NODE_DONT_INHERIT_ROTATION = 0x2;
const NODE_DONT_INHERIT_SCALING = 0x4;

type ParsedGeoset = {
    vertices: number[];
    normals: number[];
    indices: number[];
    vertexGroupByVertex: number[];
    matrixGroupCounts: number[];
    matrixIndices: number[];
};

export function decodeMdx(sourceBytes: Uint8Array, sequenceIndex = -1, sequenceFrame?: number): DecodedMdxModel {
    try {
        return decodeMdxInternal(sourceBytes, sequenceIndex, sequenceFrame);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading MDX: ${message}`);
    }
}

function decodeMdxInternal(sourceBytes: Uint8Array, sequenceIndex: number, sequenceFrame?: number): DecodedMdxModel {
    const warnings: string[] = [];
    const warnOnceSet = new Set<string>();
    const warn = (msg: string) => warnings.push(msg);
    const warnOnce = (msg: string) => {
        if (warnOnceSet.has(msg)) return;
        warnOnceSet.add(msg);
        warn(msg);
    };
    const readU32 = (offset: number, label: string): number => {
        if (offset < 0 || offset + 4 > sourceBytes.length) {
            throw new Error(`${label} is truncated`);
        }
        const view = new DataView(sourceBytes.buffer, sourceBytes.byteOffset + offset, 4);
        return view.getUint32(0, true);
    };

    if (sourceBytes.length < 4 || readAscii4(sourceBytes, 0) !== 'MDLX') {
        throw new Error('invalid MDX magic');
    }

    let modelName = 'Unnamed Model';
    let modelVersion = readModelVersion(sourceBytes);
    const sequences: MdxSequenceInfo[] = [];
    const allPositions: number[] = [];
    const allNormals: number[] = [];
    const allIndices: number[] = [];
    let geosetsCount = 0;

    const pivots: Array<[number, number, number]> = [];
    const nodeMap = new Map<number, MdxNode>();
    const geosets: ParsedGeoset[] = [];
    const geosetAnims = new Map<number, GeosetAnim>();

    let pos = 4;
    while (pos + 8 <= sourceBytes.length) {
        const token = readAscii4(sourceBytes, pos);
        const size = readU32(pos + 4, `${token}.size`);
        pos += 8;
        if (pos + size > sourceBytes.length) {
            warn(`Chunk ${token} size ${size} exceeds file bounds.`);
            break;
        }
        const chunk = sourceBytes.subarray(pos, pos + size);
        pos += size;

        if (token === 'MODL') {
            if (chunk.length >= 80) {
                modelName = readAsciiZ(chunk, 0, 80) || modelName;
            }
            continue;
        }

        if (token === 'VERS') {
            if (chunk.length >= 4) {
                modelVersion = readU32FromArray(chunk, 0);
            } else {
                warn('VERS chunk is truncated.');
            }
            continue;
        }

        if (token === 'SEQS') {
            const stride = 132;
            if (chunk.length % stride !== 0) {
                warn(`SEQS chunk size ${chunk.length} is not aligned to ${stride}.`);
            }
            for (let off = 0; off + stride <= chunk.length; off += stride) {
                const name = readAsciiZ(chunk, off, 80) || `Sequence ${sequences.length}`;
                const intervalStart = readU32FromArray(chunk, off + 80);
                const intervalEnd = readU32FromArray(chunk, off + 84);
                const flags = readU32FromArray(chunk, off + 92);
                sequences.push({
                    name,
                    intervalStart,
                    intervalEnd,
                    looping: (flags & 0x1) === 0,
                });
            }
            continue;
        }

        if (token === 'PIVT') {
            if (chunk.length % 12 !== 0) {
                warn(`PIVT chunk size ${chunk.length} is not aligned to 12.`);
            }
            for (let off = 0; off + 12 <= chunk.length; off += 12) {
                pivots.push([
                    readF32FromArray(chunk, off),
                    readF32FromArray(chunk, off + 4),
                    readF32FromArray(chunk, off + 8),
                ]);
            }
            continue;
        }

        if (token === 'BONE') {
            parseNodeEntriesForVersion(chunk, modelVersion, 8, warn, (entry) => {
                nodeMap.set(entry.objectId, entry);
            });
            continue;
        }

        if (token === 'HELP') {
            parseNodeEntriesForVersion(chunk, modelVersion, 0, warn, (entry) => {
                nodeMap.set(entry.objectId, entry);
            });
            continue;
        }

        if (token === 'GEOA') {
            parseGeosetAnims(chunk, modelVersion, warn, (anim) => {
                geosetAnims.set(anim.geosetId, anim);
            });
            continue;
        }

        if (token !== 'GEOS') continue;

        let gpos = 0;
        while (gpos + 4 <= chunk.length) {
            const maybeToken = readAscii4(chunk, gpos);
            if (maybeToken === 'VRTX') {
                const parsed = parseMdxGeoset(chunk.subarray(gpos), warn, modelVersion);
                geosets.push(parsed);
                geosetsCount++;
                gpos += Math.max(1, parsed.consumedBytes);
                continue;
            }

            const inclusiveSize = readU32FromArray(chunk, gpos);
            let geosetEnd = gpos + inclusiveSize;
            if (geosetEnd <= gpos + 4 || geosetEnd > chunk.length) {
                geosetEnd = gpos + 4 + inclusiveSize;
            }
            if (inclusiveSize <= 0 || geosetEnd > chunk.length) {
                warn(`GEOS geoset has invalid inclusiveSize ${inclusiveSize}.`);
                break;
            }

            geosetsCount++;
            const geoset = chunk.subarray(gpos + 4, geosetEnd);
            const parsed = parseMdxGeoset(geoset, warn, modelVersion);
            const leftover = geoset.length - parsed.consumedBytes;
            if (leftover > 0 && !(leftover <= 4 && isAllZero(geoset.subarray(parsed.consumedBytes)))) {
                warn(`GEOS geoset payload parsed ${parsed.consumedBytes} of ${geoset.length} bytes.`);
            }
            geosets.push(parsed);
            gpos = geosetEnd;
        }
    }

    for (const node of nodeMap.values()) {
        const pivot = node.objectId >= 0 && node.objectId < pivots.length ? pivots[node.objectId] : [0, 0, 0];
        node.pivot = [pivot[0], pivot[1], pivot[2]];
    }

    // Backfill missing node ids referenced by matrix indices so skinning relations are always resolvable.
    backfillMissingNodesFromGeosets(geosets, nodeMap, warn);

    const activeSequenceIndex = sequenceIndex >= 0 && sequenceIndex < sequences.length ? sequenceIndex : -1;
    const sampleFrame = activeSequenceIndex >= 0
        ? (Number.isFinite(sequenceFrame)
            ? Math.floor(sequenceFrame as number)
            : Math.floor((sequences[activeSequenceIndex].intervalStart + sequences[activeSequenceIndex].intervalEnd) * 0.5))
        : 0;
    const sequenceTrackSummaries = buildSequenceTrackSummaries(sequences, nodeMap, geosetAnims);
    const activeNodeTrackObjectIds = activeSequenceIndex >= 0
        ? collectActiveNodeTrackObjectIds(nodeMap, sequences[activeSequenceIndex].intervalStart, sequences[activeSequenceIndex].intervalEnd)
        : [];
    const activeGeosetAlphaIds = activeSequenceIndex >= 0
        ? collectActiveGeosetAlphaIds(geosetAnims, sequences[activeSequenceIndex].intervalStart, sequences[activeSequenceIndex].intervalEnd)
        : [];
    const animatedNodeCount = Array.from(nodeMap.values()).filter(
        (n) => n.translationKeys.keys.length > 0 || n.rotationKeys.keys.length > 0 || n.scalingKeys.keys.length > 0
    ).length;
    if (activeSequenceIndex >= 0) {
        warn(`Animation debug: frame=${sampleFrame}, nodes=${nodeMap.size}, animatedNodes=${animatedNodeCount}.`);
    }

    for (let i = 0; i < geosets.length; i++) {
        const geoset = geosets[i];
        if (!isGeosetVisible(i, sampleFrame, geosetAnims)) {
            continue;
        }
        applyPoseSkinning(geoset, nodeMap, sampleFrame, warnOnce);
        const baseVertex = allPositions.length / 3;
        for (const v of geoset.vertices) allPositions.push(v);
        for (const n of geoset.normals) allNormals.push(n);
        for (const idx of geoset.indices) allIndices.push(baseVertex + idx);
    }

    const positions = new Float32Array(allPositions);
    const normals = new Float32Array(allNormals);
    const indices = new Uint32Array(allIndices);
    const nodeDebug = buildNodeDebugPayload(nodeMap, sampleFrame, warnOnce);
    return {
        kind: 'model',
        modelName,
        nodesCount: nodeMap.size,
        geosetsCount,
        trianglesCount: Math.floor(indices.length / 3),
        activeSequenceIndex,
        sampledFrame: sampleFrame,
        sequences,
        sequenceTrackSummaries,
        activeNodeTrackObjectIds,
        activeGeosetAlphaIds,
        positionsBase64: Buffer.from(positions.buffer).toString('base64'),
        normalsBase64: Buffer.from(normals.buffer).toString('base64'),
        indicesBase64: Buffer.from(indices.buffer).toString('base64'),
        nodeDebugPositionsBase64: nodeDebug.positionsBase64,
        nodeDebugParentIndexBase64: nodeDebug.parentIndexBase64,
        nodeDebugAnimatedBase64: nodeDebug.animatedBase64,
        nodeDebugMovedBase64: nodeDebug.movedBase64,
        warnings,
        description: activeSequenceIndex >= 0
            ? `MDX sequence pose: ${sequences[activeSequenceIndex].name}`
            : 'MDX static geosets (bind-pose skinning)',
    };
}

function buildNodeDebugPayload(
    nodeMap: Map<number, MdxNode>,
    frame: number,
    warnOnce: (msg: string) => void
): { positionsBase64: string; parentIndexBase64: string; animatedBase64: string; movedBase64: string } {
    const nodes = Array.from(nodeMap.values()).sort((a, b) => a.objectId - b.objectId);
    const indexById = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) indexById.set(nodes[i].objectId, i);

    const positions = new Float32Array(nodes.length * 3);
    const parents = new Int32Array(nodes.length);
    const animated = new Uint8Array(nodes.length);
    const moved = new Uint8Array(nodes.length);

    const cacheNow = new Map<number, Float32Array>();
    const cacheNext = new Map<number, Float32Array>();
    const nextFrame = frame + 1;

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const worldNow = getNodeWorldMatrix(node, nodeMap, frame, warnOnce, new Set<number>(), cacheNow);
        const worldNext = getNodeWorldMatrix(node, nodeMap, nextFrame, warnOnce, new Set<number>(), cacheNext);
        const pNow = transformPoint(worldNow, 0, 0, 0);
        const pNext = transformPoint(worldNext, 0, 0, 0);
        positions[i * 3] = pNow[0];
        positions[i * 3 + 1] = pNow[1];
        positions[i * 3 + 2] = pNow[2];

        parents[i] = node.parentId >= 0 && indexById.has(node.parentId) ? (indexById.get(node.parentId) as number) : -1;
        animated[i] = (node.translationKeys.keys.length > 0 || node.rotationKeys.keys.length > 0 || node.scalingKeys.keys.length > 0) ? 1 : 0;
        const dx = pNext[0] - pNow[0];
        const dy = pNext[1] - pNow[1];
        const dz = pNext[2] - pNow[2];
        moved[i] = (dx * dx + dy * dy + dz * dz) > 1e-10 ? 1 : 0;
    }

    return {
        positionsBase64: Buffer.from(positions.buffer).toString('base64'),
        parentIndexBase64: Buffer.from(parents.buffer).toString('base64'),
        animatedBase64: Buffer.from(animated.buffer).toString('base64'),
        movedBase64: Buffer.from(moved.buffer).toString('base64'),
    };
}

function buildSequenceTrackSummaries(
    sequences: MdxSequenceInfo[],
    nodeMap: Map<number, MdxNode>,
    geosetAnims: Map<number, GeosetAnim>
): SequenceTrackSummary[] {
    const out: SequenceTrackSummary[] = [];
    for (let i = 0; i < sequences.length; i++) {
        const seq = sequences[i];
        let nodeChannels = 0;
        let nodeKeys = 0;
        for (const node of nodeMap.values()) {
            const t = countKeysInIntervalVec3(node.translationKeys, seq.intervalStart, seq.intervalEnd);
            const r = countKeysInIntervalQuat(node.rotationKeys, seq.intervalStart, seq.intervalEnd);
            const s = countKeysInIntervalVec3(node.scalingKeys, seq.intervalStart, seq.intervalEnd);
            if (t > 0) nodeChannels++;
            if (r > 0) nodeChannels++;
            if (s > 0) nodeChannels++;
            nodeKeys += t + r + s;
        }
        let geosetAlphaChannels = 0;
        let geosetAlphaKeys = 0;
        for (const anim of geosetAnims.values()) {
            const c = countKeysInIntervalFloat(anim.alphaTrack, seq.intervalStart, seq.intervalEnd);
            if (c > 0) geosetAlphaChannels++;
            geosetAlphaKeys += c;
        }
        out.push({ sequenceIndex: i, nodeChannels, nodeKeys, geosetAlphaChannels, geosetAlphaKeys });
    }
    return out;
}

function collectActiveNodeTrackObjectIds(nodeMap: Map<number, MdxNode>, start: number, end: number): number[] {
    const ids: number[] = [];
    for (const node of nodeMap.values()) {
        if (
            countKeysInIntervalVec3(node.translationKeys, start, end) > 0 ||
            countKeysInIntervalQuat(node.rotationKeys, start, end) > 0 ||
            countKeysInIntervalVec3(node.scalingKeys, start, end) > 0
        ) {
            ids.push(node.objectId);
        }
    }
    ids.sort((a, b) => a - b);
    return ids;
}

function collectActiveGeosetAlphaIds(geosetAnims: Map<number, GeosetAnim>, start: number, end: number): number[] {
    const ids: number[] = [];
    for (const [geosetId, anim] of geosetAnims.entries()) {
        if (countKeysInIntervalFloat(anim.alphaTrack, start, end) > 0) {
            ids.push(geosetId);
        }
    }
    ids.sort((a, b) => a - b);
    return ids;
}

function countKeysInIntervalVec3(track: Vec3Track, start: number, end: number): number {
    let count = 0;
    for (const key of track.keys) {
        if (key.frame >= start && key.frame <= end) count++;
    }
    return count;
}

function countKeysInIntervalQuat(track: QuatTrack, start: number, end: number): number {
    let count = 0;
    for (const key of track.keys) {
        if (key.frame >= start && key.frame <= end) count++;
    }
    return count;
}

function countKeysInIntervalFloat(track: FloatTrack, start: number, end: number): number {
    let count = 0;
    for (const key of track.keys) {
        if (key.frame >= start && key.frame <= end) count++;
    }
    return count;
}

function isAllZero(bytes: Uint8Array): boolean {
    for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 0) return false;
    }
    return true;
}

function readModelVersion(sourceBytes: Uint8Array): number {
    let pos = 4;
    while (pos + 8 <= sourceBytes.length) {
        const token = readAscii4(sourceBytes, pos);
        const size = readU32FromArray(sourceBytes, pos + 4);
        pos += 8;
        if (size <= 0 || pos + size > sourceBytes.length) {
            break;
        }
        if (token === 'VERS' && size >= 4) {
            return readU32FromArray(sourceBytes, pos);
        }
        pos += size;
    }
    return 800;
}

function parseNodeEntriesLegacy(
    chunk: Uint8Array,
    trailingBytesAfterNode: number,
    warn: (msg: string) => void,
    onNode: (node: MdxNode) => void
): void {
    let pos = 0;
    while (pos + 4 <= chunk.length) {
        const size = readU32FromArray(chunk, pos);
        if (size === 0 && chunk.subarray(pos).every((b) => b === 0)) {
            break;
        }
        if (size <= 0 || pos + size > chunk.length) {
            warn(`Node chunk has invalid entry size ${size}.`);
            break;
        }

        const nodeStart = pos + 4;
        const nodeEnd = pos + size;
        const entryEnd = nodeEnd + trailingBytesAfterNode;
        if (nodeStart + 92 > nodeEnd) {
            warn(`Node entry size ${size} is too small.`);
            pos = Math.min(chunk.length, entryEnd);
            continue;
        }
        if (entryEnd > chunk.length) {
            warn(`Node entry overruns chunk (size ${size}, trailing ${trailingBytesAfterNode}).`);
            break;
        }

        const objectId = readU32FromArray(chunk, nodeStart + 80);
        const parentId = readI32FromArray(chunk, nodeStart + 84);

        const tracks = parseNodeTracks(chunk, nodeStart + 92, nodeEnd, warn);
        if (tracks.nextPos > nodeEnd) {
            warn(`Node ${objectId} entry is truncated (expected ${trailingBytesAfterNode} trailing bytes).`);
        }
        onNode({
            objectId,
            parentId,
            flags: readU32FromArray(chunk, nodeStart + 88),
            translationKeys: tracks.translationKeys,
            rotationKeys: tracks.rotationKeys,
            scalingKeys: tracks.scalingKeys,
            pivot: [0, 0, 0],
        });

        pos = entryEnd;
    }
}

function parseObjectEntriesModern(
    chunk: Uint8Array,
    trailingBytesAfterObject: number,
    warn: (msg: string) => void,
    onNode: (node: MdxNode) => void
): void {
    let pos = 0;
    while (pos + 4 <= chunk.length) {
        const entrySize = readU32FromArray(chunk, pos);
        if (entrySize === 0 && chunk.subarray(pos).every((b) => b === 0)) {
            break;
        }
        if (entrySize <= 0 || pos + 4 + entrySize > chunk.length) {
            warn(`Object chunk has invalid entry size ${entrySize}.`);
            break;
        }
        const entryStart = pos + 4;
        const entryEnd = entryStart + entrySize;
        const objectEnd = entryEnd - trailingBytesAfterObject;
        if (objectEnd < entryStart + 92) {
            warn(`Object entry size ${entrySize} is too small.`);
            pos = entryEnd;
            continue;
        }

        const objectId = readU32FromArray(chunk, entryStart + 80);
        const parentId = readI32FromArray(chunk, entryStart + 84);
        const flags = readU32FromArray(chunk, entryStart + 88);
        const tracks = parseNodeTracks(chunk, entryStart + 92, objectEnd, warn);

        onNode({
            objectId,
            parentId,
            flags,
            translationKeys: tracks.translationKeys,
            rotationKeys: tracks.rotationKeys,
            scalingKeys: tracks.scalingKeys,
            pivot: [0, 0, 0],
        });

        pos = entryEnd;
    }
}

function parseObjectEntriesBare(
    chunk: Uint8Array,
    trailingBytesAfterObject: number,
    warn: (msg: string) => void,
    onNode: (node: MdxNode) => void
): void {
    let pos = 0;
    while (pos + 92 + trailingBytesAfterObject <= chunk.length) {
        const objectStart = pos;
        const objectId = readU32FromArray(chunk, objectStart + 80);
        const parentId = readI32FromArray(chunk, objectStart + 84);
        const flags = readU32FromArray(chunk, objectStart + 88);
        const tracks = parseNodeTracks(chunk, objectStart + 92, chunk.length, warn);
        const objectEnd = tracks.nextPos;
        const entryEnd = objectEnd + trailingBytesAfterObject;
        if (entryEnd > chunk.length) {
            warn(`Object entry overruns chunk (trailing ${trailingBytesAfterObject}).`);
            break;
        }

        onNode({
            objectId,
            parentId,
            flags,
            translationKeys: tracks.translationKeys,
            rotationKeys: tracks.rotationKeys,
            scalingKeys: tracks.scalingKeys,
            pivot: [0, 0, 0],
        });

        if (entryEnd <= pos) {
            warn('Object parser made no forward progress.');
            break;
        }
        pos = entryEnd;
    }
}

function parseNodeEntriesForVersion(
    chunk: Uint8Array,
    modelVersion: number,
    trailingBytesAfterObject: number,
    warn: (msg: string) => void,
    onNode: (node: MdxNode) => void
): void {
    const first = readU32FromArray(chunk, 0);
    const hasSizedEntries = first > 0 && first + 4 <= chunk.length;
    const isLikelyBare = !hasSizedEntries;

    if (isLikelyBare) {
        parseObjectEntriesBare(chunk, trailingBytesAfterObject, warn, onNode);
        return;
    }
    if (modelVersion >= 1000) {
        parseObjectEntriesModern(chunk, trailingBytesAfterObject, warn, onNode);
        return;
    }
    parseNodeEntriesLegacy(chunk, trailingBytesAfterObject, warn, onNode);
}

function backfillMissingNodesFromGeosets(geosets: ParsedGeoset[], nodeMap: Map<number, MdxNode>, warn: (msg: string) => void): void {
    const needed = new Set<number>();
    for (const geoset of geosets) {
        for (const idx of geoset.matrixIndices) {
            if (idx >= 0) needed.add(idx);
        }
    }
    let added = 0;
    for (const nodeId of needed) {
        if (nodeMap.has(nodeId)) continue;
        nodeMap.set(nodeId, {
            objectId: nodeId,
            parentId: -1,
            flags: 0,
            translationKeys: { interpolation: 0, keys: [] },
            rotationKeys: { interpolation: 0, keys: [] },
            scalingKeys: { interpolation: 0, keys: [] },
            pivot: [0, 0, 0],
        });
        added++;
    }
    if (added > 0) {
        warn(`Backfilled ${added} missing node references as identity nodes.`);
    }
}

function parseNodeTracks(
    bytes: Uint8Array,
    start: number,
    end: number,
    warn: (msg: string) => void
): {
    nextPos: number;
    translationKeys: Vec3Track;
    rotationKeys: QuatTrack;
    scalingKeys: Vec3Track;
} {
    const translationKeys: Vec3Track = { interpolation: 0, keys: [] };
    const rotationKeys: QuatTrack = { interpolation: 0, keys: [] };
    const scalingKeys: Vec3Track = { interpolation: 0, keys: [] };

    let pos = start;
    while (pos + 16 <= end) {
        const token = readAscii4(bytes, pos);
        if (token !== 'KGTR' && token !== 'KGRT' && token !== 'KGSC') {
            break;
        }
        const tracksCount = readU32FromArray(bytes, pos + 4);
        const interpolationType = Math.min(3, readU32FromArray(bytes, pos + 8)) as TrackInterpolation;
        const blockStart = pos + 16;
        const entryBytes = token === 'KGRT' ? 20 : 16; // frame + quat / frame + vec3
        const tanBytes = token === 'KGRT' ? 32 : 24; // in/out tangents for hermite/bezier
        const totalBytes = tracksCount * (entryBytes + (interpolationType > 1 ? tanBytes : 0));
        const blockEnd = blockStart + totalBytes;
        if (blockEnd > end) {
            warn(`Node track ${token} payload exceeds node bounds.`);
            break;
        }

        if (token === 'KGTR') {
            const track = readTrackVec3(bytes, pos + 4, blockEnd);
            if (track) {
                translationKeys.interpolation = track.interpolation;
                translationKeys.keys = track.keys;
            }
        } else if (token === 'KGRT') {
            const track = readTrackQuat(bytes, pos + 4, blockEnd);
            if (track) {
                rotationKeys.interpolation = track.interpolation;
                rotationKeys.keys = track.keys;
            }
        } else if (token === 'KGSC') {
            const track = readTrackVec3(bytes, pos + 4, blockEnd);
            if (track) {
                scalingKeys.interpolation = track.interpolation;
                scalingKeys.keys = track.keys;
            }
        }

        pos = blockEnd;
    }

    return { nextPos: pos, translationKeys, rotationKeys, scalingKeys };
}

function readTrackVec3(bytes: Uint8Array, start: number, end: number): Vec3Track | null {
    if (start + 12 > end) return null;
    const tracksCount = readU32FromArray(bytes, start);
    const interpolationType = Math.min(3, readU32FromArray(bytes, start + 4)) as TrackInterpolation;
    let pos = start + 12;
    const keys: Vec3Key[] = [];
    for (let i = 0; i < tracksCount; i++) {
        if (pos + 16 > end) break;
        const frame = readI32FromArray(bytes, pos);
        pos += 4;
        const value: [number, number, number] = [readF32FromArray(bytes, pos), readF32FromArray(bytes, pos + 4), readF32FromArray(bytes, pos + 8)];
        pos += 12;
        keys.push({ frame, value });
        if (interpolationType > 1) {
            if (pos + 24 > end) break;
            pos += 24;
        }
    }
    return { interpolation: interpolationType, keys };
}

function readTrackQuat(bytes: Uint8Array, start: number, end: number): QuatTrack | null {
    if (start + 12 > end) return null;
    const tracksCount = readU32FromArray(bytes, start);
    const interpolationType = Math.min(3, readU32FromArray(bytes, start + 4)) as TrackInterpolation;
    let pos = start + 12;
    const keys: QuatKey[] = [];
    for (let i = 0; i < tracksCount; i++) {
        if (pos + 20 > end) break;
        const frame = readI32FromArray(bytes, pos);
        pos += 4;
        const q: [number, number, number, number] = normalizeQuat([
            readF32FromArray(bytes, pos),
            readF32FromArray(bytes, pos + 4),
            readF32FromArray(bytes, pos + 8),
            readF32FromArray(bytes, pos + 12),
        ]);
        pos += 16;
        keys.push({ frame, value: q });
        if (interpolationType > 1) {
            if (pos + 32 > end) break;
            pos += 32;
        }
    }
    return { interpolation: interpolationType, keys };
}

function parseGeosetAnims(
    chunk: Uint8Array,
    _modelVersion: number,
    warn: (msg: string) => void,
    onAnim: (anim: GeosetAnim) => void
): void {
    let pos = 0;
    while (pos + 4 <= chunk.length) {
        const inclusiveSize = readU32FromArray(chunk, pos);
        let entryEnd = pos + inclusiveSize;
        if (entryEnd <= pos + 4 || entryEnd > chunk.length) {
            entryEnd = pos + 4 + inclusiveSize;
        }
        if (inclusiveSize <= 0 || entryEnd > chunk.length) {
            warn(`GEOA has invalid entry size ${inclusiveSize}.`);
            break;
        }
        const entryStart = pos + 4;
        if (entryStart + 24 > entryEnd) {
            warn(`GEOA entry size ${inclusiveSize} too small.`);
            pos = entryEnd;
            continue;
        }

        const alpha = readF32FromArray(chunk, entryStart);
        const geosetId = readU32FromArray(chunk, entryStart + 16);
        let alphaTrack: FloatTrack = { interpolation: 0, keys: [] };

        let tpos = entryStart + 20;
        while (tpos + 16 <= entryEnd) {
            const token = readAscii4(chunk, tpos);
            if (token !== 'KGAO') break;
            const tracksCount = readU32FromArray(chunk, tpos + 4);
            const interpolationType = Math.min(3, readU32FromArray(chunk, tpos + 8)) as TrackInterpolation;
            const blockStart = tpos + 16;
            const entryBytes = 8; // frame + float
            const tanBytes = 8; // in/out float
            const totalBytes = tracksCount * (entryBytes + (interpolationType > 1 ? tanBytes : 0));
            const blockEnd = blockStart + totalBytes;
            if (blockEnd > entryEnd) {
                warn(`GEOA track ${token} payload exceeds entry bounds.`);
                break;
            }
            const track = readTrackFloat(chunk, tpos + 4, blockEnd);
            if (track) alphaTrack = track;
            tpos = blockEnd;
        }

        onAnim({ geosetId, alpha, alphaTrack });
        pos = entryEnd;
    }
}

function isGeosetVisible(geosetId: number, frame: number, geosetAnims: Map<number, GeosetAnim>): boolean {
    const anim = geosetAnims.get(geosetId);
    if (!anim) return true;
    const alpha = evalFloatTrack(anim.alphaTrack, frame, anim.alpha);
    return alpha > 0.01;
}

function applyPoseSkinning(geoset: ParsedGeoset, nodeMap: Map<number, MdxNode>, frame: number, warnOnce: (msg: string) => void): void {
    const worldByNodeId = new Map<number, Float32Array>();
    const resolveWorld = (nodeId: number): Float32Array | null => {
        const existing = worldByNodeId.get(nodeId);
        if (existing) return existing;
        const node = nodeMap.get(nodeId);
        if (!node) return null;
        const world = getNodeWorldMatrix(node, nodeMap, frame, warnOnce, new Set<number>(), worldByNodeId);
        return world;
    };

    const groupOffsets: number[] = new Array(geoset.matrixGroupCounts.length);
    let cursor = 0;
    for (let i = 0; i < geoset.matrixGroupCounts.length; i++) {
        groupOffsets[i] = cursor;
        cursor += geoset.matrixGroupCounts[i];
    }

    for (let vi = 0; vi < geoset.vertices.length / 3; vi++) {
        const groupId = vi < geoset.vertexGroupByVertex.length ? geoset.vertexGroupByVertex[vi] : 0;
        if (groupId < 0 || groupId >= geoset.matrixGroupCounts.length) continue;
        const matrixCount = geoset.matrixGroupCounts[groupId];
        if (matrixCount <= 0) continue;

        const start = groupOffsets[groupId];
        const px = geoset.vertices[vi * 3];
        const py = geoset.vertices[vi * 3 + 1];
        const pz = geoset.vertices[vi * 3 + 2];
        const nx = geoset.normals[vi * 3];
        const ny = geoset.normals[vi * 3 + 1];
        const nz = geoset.normals[vi * 3 + 2];

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let snx = 0;
        let sny = 0;
        let snz = 0;
        let used = 0;

        if (matrixCount > 1) {
            warnOnce('Some geoset matrix groups use multiple nodes; viewer applies equal-weight bind-pose blend.');
        }

        for (let mi = 0; mi < matrixCount; mi++) {
            const matrixIndexOffset = start + mi;
            if (matrixIndexOffset >= geoset.matrixIndices.length) break;
            const nodeId = geoset.matrixIndices[matrixIndexOffset];
            const world = resolveWorld(nodeId);
            if (!world) {
                warnOnce(`Missing node ${nodeId} referenced by geoset matrix group.`);
                continue;
            }
            const p = transformPoint(world, px, py, pz);
            const n = transformDirection(world, nx, ny, nz);
            sx += p[0];
            sy += p[1];
            sz += p[2];
            snx += n[0];
            sny += n[1];
            snz += n[2];
            used++;
        }

        if (used > 0) {
            const inv = 1 / used;
            geoset.vertices[vi * 3] = sx * inv;
            geoset.vertices[vi * 3 + 1] = sy * inv;
            geoset.vertices[vi * 3 + 2] = sz * inv;

            const nnx = snx * inv;
            const nny = sny * inv;
            const nnz = snz * inv;
            const nlen = Math.sqrt(nnx * nnx + nny * nny + nnz * nnz) || 1;
            geoset.normals[vi * 3] = nnx / nlen;
            geoset.normals[vi * 3 + 1] = nny / nlen;
            geoset.normals[vi * 3 + 2] = nnz / nlen;
        }
    }
}

function getNodeWorldMatrix(
    node: MdxNode,
    nodeMap: Map<number, MdxNode>,
    frame: number,
    warnOnce: (msg: string) => void,
    chain: Set<number>,
    cache: Map<number, Float32Array>
): Float32Array {
    const cached = cache.get(node.objectId);
    if (cached) return cached;

    if (chain.has(node.objectId)) {
        warnOnce(`Cycle detected in node hierarchy at objectId ${node.objectId}.`);
        const cyc = mat4FromTRSP(
            evalVec3Track(node.translationKeys, frame, [0, 0, 0]),
            evalQuatTrack(node.rotationKeys, frame, [0, 0, 0, 1]),
            evalVec3Track(node.scalingKeys, frame, [1, 1, 1]),
            node.pivot
        );
        cache.set(node.objectId, cyc);
        return cyc;
    }

    chain.add(node.objectId);
    const local = mat4FromTRSP(
        evalVec3Track(node.translationKeys, frame, [0, 0, 0]),
        evalQuatTrack(node.rotationKeys, frame, [0, 0, 0, 1]),
        evalVec3Track(node.scalingKeys, frame, [1, 1, 1]),
        node.pivot
    );
    let world = local;
    if (node.parentId >= 0) {
        const parent = nodeMap.get(node.parentId);
        if (parent) {
            const parentWorld = getNodeWorldMatrix(parent, nodeMap, frame, warnOnce, chain, cache);
            world = mat4Multiply(buildParentInheritedMatrix(parentWorld, node.flags), local);
        } else {
            warnOnce(`Node ${node.objectId} references missing parent ${node.parentId}.`);
        }
    }
    chain.delete(node.objectId);
    cache.set(node.objectId, world);
    return world;
}

function buildParentInheritedMatrix(parentWorld: Float32Array, childFlags: number): Float32Array {
    const parentT = extractTranslation(parentWorld);
    const parentS = extractScale(parentWorld);
    const parentR = extractRotation(parentWorld, parentS);
    const t: [number, number, number] =
        (childFlags & NODE_DONT_INHERIT_TRANSLATION) !== 0 ? [0, 0, 0] : parentT;
    const r: [number, number, number, number] =
        (childFlags & NODE_DONT_INHERIT_ROTATION) !== 0 ? [0, 0, 0, 1] : parentR;
    const s: [number, number, number] =
        (childFlags & NODE_DONT_INHERIT_SCALING) !== 0 ? [1, 1, 1] : parentS;
    return mat4FromTRSP(t, r, s, [0, 0, 0]);
}

function parseMdxGeoset(geoset: Uint8Array, warn: (msg: string) => void, modelVersion: number): ParsedGeoset & { consumedBytes: number } {
    let pos = 0;

    const expectChunk = (token: string): { count: number; start: number } => {
        if (pos + 8 > geoset.length) throw new Error(`geoset missing ${token} header`);
        const got = readAscii4(geoset, pos);
        if (got !== token) throw new Error(`geoset expected ${token} but found ${got}`);
        const count = readU32FromArray(geoset, pos + 4);
        pos += 8;
        return { count, start: pos };
    };

    const vrtx = expectChunk('VRTX');
    const vertexCount = vrtx.count;
    const vertexBytes = vertexCount * 12;
    if (vrtx.start + vertexBytes > geoset.length) throw new Error('VRTX payload is truncated');
    const vertices: number[] = [];
    for (let i = 0; i < vertexCount; i++) {
        const off = vrtx.start + i * 12;
        vertices.push(readF32FromArray(geoset, off), readF32FromArray(geoset, off + 4), readF32FromArray(geoset, off + 8));
    }
    pos += vertexBytes;

    const nrms = expectChunk('NRMS');
    const normalBytes = nrms.count * 12;
    if (nrms.start + normalBytes > geoset.length) throw new Error('NRMS payload is truncated');
    const normals: number[] = [];
    for (let i = 0; i < nrms.count; i++) {
        const off = nrms.start + i * 12;
        normals.push(readF32FromArray(geoset, off), readF32FromArray(geoset, off + 4), readF32FromArray(geoset, off + 8));
    }
    if (nrms.count !== vertexCount) {
        warn(`NRMS count ${nrms.count} differs from VRTX count ${vertexCount}.`);
        while (normals.length < vertices.length) normals.push(0, 0, 1);
        if (normals.length > vertices.length) normals.length = vertices.length;
    }
    pos += normalBytes;

    const ptyp = expectChunk('PTYP');
    const ptypBytes = ptyp.count * 4;
    if (ptyp.start + ptypBytes > geoset.length) throw new Error('PTYP payload is truncated');
    const faceTypes: number[] = [];
    for (let i = 0; i < ptyp.count; i++) {
        faceTypes.push(readU32FromArray(geoset, ptyp.start + i * 4));
    }
    pos += ptypBytes;

    const pcnt = expectChunk('PCNT');
    const pcntBytes = pcnt.count * 4;
    if (pcnt.start + pcntBytes > geoset.length) throw new Error('PCNT payload is truncated');
    const faceGroups: number[] = [];
    for (let i = 0; i < pcnt.count; i++) {
        faceGroups.push(readU32FromArray(geoset, pcnt.start + i * 4));
    }
    pos += pcntBytes;

    const pvtx = expectChunk('PVTX');
    const pvtxBytes = pvtx.count * 2;
    if (pvtx.start + pvtxBytes > geoset.length) throw new Error('PVTX payload is truncated');
    const faceIndices: number[] = [];
    for (let i = 0; i < pvtx.count; i++) {
        faceIndices.push(readU16FromArray(geoset, pvtx.start + i * 2));
    }
    pos += pvtxBytes;

    const gndx = expectChunk('GNDX');
    if (gndx.start + gndx.count > geoset.length) throw new Error('GNDX payload is truncated');
    const vertexGroupByVertex: number[] = [];
    for (let i = 0; i < gndx.count; i++) {
        vertexGroupByVertex.push(geoset[gndx.start + i]);
    }
    pos += gndx.count;

    const mtgc = expectChunk('MTGC');
    const mtgcBytes = mtgc.count * 4;
    if (mtgc.start + mtgcBytes > geoset.length) throw new Error('MTGC payload is truncated');
    const matrixGroupCounts: number[] = [];
    for (let i = 0; i < mtgc.count; i++) {
        matrixGroupCounts.push(readU32FromArray(geoset, mtgc.start + i * 4));
    }
    pos += mtgcBytes;

    const mats = expectChunk('MATS');
    const matsBytes = mats.count * 4;
    if (mats.start + matsBytes > geoset.length) throw new Error('MATS payload is truncated');
    const matrixIndices: number[] = [];
    for (let i = 0; i < mats.count; i++) {
        matrixIndices.push(readU32FromArray(geoset, mats.start + i * 4));
    }
    pos += matsBytes;

    const tailEnd = parseGeosetTail(geoset, pos, modelVersion);
    if (tailEnd < 0) {
        throw new Error('geoset fixed fields are truncated or unsupported');
    }
    pos = tailEnd;

    const triangles = buildTriangles(faceTypes, faceGroups, faceIndices, warn);
    return { vertices, normals, indices: triangles, vertexGroupByVertex, matrixGroupCounts, matrixIndices, consumedBytes: pos };
}

function parseGeosetTail(geoset: Uint8Array, start: number, modelVersion: number): number {
    let pos = start;
    if (pos + 12 > geoset.length) return -1;
    pos += 12; // materialId, selectionGroup, selectionFlags

    if (modelVersion > 800) {
        if (pos + 84 > geoset.length) return -1;
        pos += 84; // lod + lodName[80]
    }

    if (pos + 28 + 4 > geoset.length) return -1;
    pos += 28; // extent

    const extentsCount = readU32FromArray(geoset, pos);
    pos += 4;
    const extentsBytes = extentsCount * 28;
    if (pos + extentsBytes > geoset.length) return -1;
    pos += extentsBytes;

    if (modelVersion > 800 && modelVersion < 1200) {
        // Optional HD blocks before UVAS.
        while (pos + 8 <= geoset.length) {
            const token = readAscii4(geoset, pos);
            if (token === 'UVAS') break;
            const count = readU32FromArray(geoset, pos + 4);
            if (token === 'TANG') {
                const bytes = count * 16;
                if (pos + 8 + bytes > geoset.length) return -1;
                pos += 8 + bytes;
                continue;
            }
            if (token === 'SKIN') {
                if (pos + 8 + count > geoset.length) return -1;
                pos += 8 + count;
                continue;
            }
            return -1;
        }
    }

    if (pos + 8 > geoset.length || readAscii4(geoset, pos) !== 'UVAS') return -1;
    const setCount = readU32FromArray(geoset, pos + 4);
    pos += 8;
    for (let i = 0; i < setCount; i++) {
        if (pos + 8 > geoset.length || readAscii4(geoset, pos) !== 'UVBS') return -1;
        const uvCount = readU32FromArray(geoset, pos + 4);
        pos += 8;
        const uvBytes = uvCount * 8;
        if (pos + uvBytes > geoset.length) return -1;
        pos += uvBytes;
    }
    return pos;
}

function buildTriangles(faceTypes: number[], faceGroups: number[], faceIndices: number[], warn: (msg: string) => void): number[] {
    const out: number[] = [];
    let cursor = 0;
    for (let i = 0; i < faceGroups.length; i++) {
        const groupCount = faceGroups[i];
        const type = faceTypes.length === 1 ? faceTypes[0] : (i < faceTypes.length ? faceTypes[i] : 4);
        const group = faceIndices.slice(cursor, cursor + groupCount);
        cursor += groupCount;

        if (type === 4) {
            for (let j = 0; j + 2 < group.length; j += 3) out.push(group[j], group[j + 1], group[j + 2]);
        } else if (type === 5) {
            for (let j = 0; j + 2 < group.length; j++) {
                if ((j & 1) === 0) out.push(group[j], group[j + 1], group[j + 2]);
                else out.push(group[j + 1], group[j], group[j + 2]);
            }
        } else if (type === 6 || type === 9) {
            for (let j = 1; j + 1 < group.length; j++) out.push(group[0], group[j], group[j + 1]);
        } else if (type === 7) {
            for (let j = 0; j + 3 < group.length; j += 4) {
                out.push(group[j], group[j + 1], group[j + 2]);
                out.push(group[j], group[j + 2], group[j + 3]);
            }
        } else if (type === 8) {
            for (let j = 0; j + 3 < group.length; j += 2) {
                out.push(group[j], group[j + 1], group[j + 2]);
                out.push(group[j + 1], group[j + 3], group[j + 2]);
            }
        } else {
            warn(`Unsupported face type ${type}, using triangle-list fallback for group ${i}.`);
            for (let j = 0; j + 2 < group.length; j += 3) out.push(group[j], group[j + 1], group[j + 2]);
        }
    }
    return out;
}

function readTrackFloat(bytes: Uint8Array, start: number, end: number): FloatTrack | null {
    if (start + 12 > end) return null;
    const tracksCount = readU32FromArray(bytes, start);
    const interpolationType = Math.min(3, readU32FromArray(bytes, start + 4)) as TrackInterpolation;
    let pos = start + 12;
    const keys: FloatKey[] = [];
    for (let i = 0; i < tracksCount; i++) {
        if (pos + 8 > end) break;
        const frame = readI32FromArray(bytes, pos);
        pos += 4;
        const value = readF32FromArray(bytes, pos);
        pos += 4;
        keys.push({ frame, value });
        if (interpolationType > 1) {
            if (pos + 8 > end) break;
            pos += 8;
        }
    }
    return { interpolation: interpolationType, keys };
}

function evalFloatTrack(track: FloatTrack, frame: number, fallback: number): number {
    if (!track.keys.length) return fallback;
    if (track.keys.length === 1) return track.keys[0].value;
    if (frame <= track.keys[0].frame) return track.keys[0].value;
    const last = track.keys[track.keys.length - 1];
    if (frame >= last.frame) return last.value;
    for (let i = 0; i + 1 < track.keys.length; i++) {
        const a = track.keys[i];
        const b = track.keys[i + 1];
        if (frame < a.frame || frame > b.frame) continue;
        if (track.interpolation === 0) return a.value;
        const t = (frame - a.frame) / Math.max(1e-6, b.frame - a.frame);
        return a.value + (b.value - a.value) * t;
    }
    return last.value;
}

function evalVec3Track(track: Vec3Track, frame: number, fallback: [number, number, number]): [number, number, number] {
    if (!track.keys.length) return fallback;
    if (track.keys.length === 1) return track.keys[0].value;
    if (frame <= track.keys[0].frame) return track.keys[0].value;
    const last = track.keys[track.keys.length - 1];
    if (frame >= last.frame) return last.value;
    for (let i = 0; i + 1 < track.keys.length; i++) {
        const a = track.keys[i];
        const b = track.keys[i + 1];
        if (frame < a.frame || frame > b.frame) continue;
        if (track.interpolation === 0) return a.value;
        const t = (frame - a.frame) / Math.max(1e-6, b.frame - a.frame);
        return [
            a.value[0] + (b.value[0] - a.value[0]) * t,
            a.value[1] + (b.value[1] - a.value[1]) * t,
            a.value[2] + (b.value[2] - a.value[2]) * t,
        ];
    }
    return last.value;
}

function evalQuatTrack(track: QuatTrack, frame: number, fallback: [number, number, number, number]): [number, number, number, number] {
    if (!track.keys.length) return fallback;
    if (track.keys.length === 1) return track.keys[0].value;
    if (frame <= track.keys[0].frame) return track.keys[0].value;
    const last = track.keys[track.keys.length - 1];
    if (frame >= last.frame) return last.value;
    for (let i = 0; i + 1 < track.keys.length; i++) {
        const a = track.keys[i];
        const b = track.keys[i + 1];
        if (frame < a.frame || frame > b.frame) continue;
        if (track.interpolation === 0) return a.value;
        const t = (frame - a.frame) / Math.max(1e-6, b.frame - a.frame);
        return slerpQuat(a.value, b.value, t);
    }
    return last.value;
}

function slerpQuat(
    a: [number, number, number, number],
    b: [number, number, number, number],
    t: number
): [number, number, number, number] {
    let ax = a[0], ay = a[1], az = a[2], aw = a[3];
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let cosHalfTheta = ax * bx + ay * by + az * bz + aw * bw;
    if (cosHalfTheta < 0) {
        bx = -bx; by = -by; bz = -bz; bw = -bw;
        cosHalfTheta = -cosHalfTheta;
    }
    if (cosHalfTheta > 0.9995) {
        return normalizeQuat([
            ax + (bx - ax) * t,
            ay + (by - ay) * t,
            az + (bz - az) * t,
            aw + (bw - aw) * t,
        ]);
    }
    const halfTheta = Math.acos(Math.max(-1, Math.min(1, cosHalfTheta)));
    const sinHalfTheta = Math.sqrt(1 - cosHalfTheta * cosHalfTheta);
    if (Math.abs(sinHalfTheta) < 0.001) {
        return normalizeQuat([
            ax * 0.5 + bx * 0.5,
            ay * 0.5 + by * 0.5,
            az * 0.5 + bz * 0.5,
            aw * 0.5 + bw * 0.5,
        ]);
    }
    const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
    const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;
    return normalizeQuat([
        ax * ratioA + bx * ratioB,
        ay * ratioA + by * ratioB,
        az * ratioA + bz * ratioB,
        aw * ratioA + bw * ratioB,
    ]);
}

function mat4Identity(): Float32Array {
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
    ]);
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            out[c * 4 + r] =
                a[0 * 4 + r] * b[c * 4 + 0] +
                a[1 * 4 + r] * b[c * 4 + 1] +
                a[2 * 4 + r] * b[c * 4 + 2] +
                a[3 * 4 + r] * b[c * 4 + 3];
        }
    }
    return out;
}

function mat4Translate(tx: number, ty: number, tz: number): Float32Array {
    const m = mat4Identity();
    m[12] = tx;
    m[13] = ty;
    m[14] = tz;
    return m;
}

function mat4Scale(sx: number, sy: number, sz: number): Float32Array {
    return new Float32Array([
        sx, 0, 0, 0,
        0, sy, 0, 0,
        0, 0, sz, 0,
        0, 0, 0, 1,
    ]);
}

function mat4FromQuaternion(x: number, y: number, z: number, w: number): Float32Array {
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;

    return new Float32Array([
        1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy), 0,
        2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx), 0,
        2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy), 0,
        0, 0, 0, 1,
    ]);
}

function mat4FromTRSP(
    translation: [number, number, number],
    rotation: [number, number, number, number],
    scaling: [number, number, number],
    pivot: [number, number, number]
): Float32Array {
    const t = mat4Translate(translation[0], translation[1], translation[2]);
    const tp = mat4Translate(pivot[0], pivot[1], pivot[2]);
    const r = mat4FromQuaternion(rotation[0], rotation[1], rotation[2], rotation[3]);
    const s = mat4Scale(scaling[0], scaling[1], scaling[2]);
    const tnp = mat4Translate(-pivot[0], -pivot[1], -pivot[2]);
    return mat4Multiply(mat4Multiply(mat4Multiply(mat4Multiply(t, tp), r), s), tnp);
}

function extractTranslation(m: Float32Array): [number, number, number] {
    return [m[12], m[13], m[14]];
}

function extractScale(m: Float32Array): [number, number, number] {
    const sx = Math.hypot(m[0], m[1], m[2]) || 1;
    const sy = Math.hypot(m[4], m[5], m[6]) || 1;
    const sz = Math.hypot(m[8], m[9], m[10]) || 1;
    return [sx, sy, sz];
}

function extractRotation(m: Float32Array, scale: [number, number, number]): [number, number, number, number] {
    const sx = scale[0] || 1;
    const sy = scale[1] || 1;
    const sz = scale[2] || 1;
    const r00 = m[0] / sx, r01 = m[4] / sy, r02 = m[8] / sz;
    const r10 = m[1] / sx, r11 = m[5] / sy, r12 = m[9] / sz;
    const r20 = m[2] / sx, r21 = m[6] / sy, r22 = m[10] / sz;

    const trace = r00 + r11 + r22;
    let x = 0, y = 0, z = 0, w = 1;
    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (r21 - r12) / s;
        y = (r02 - r20) / s;
        z = (r10 - r01) / s;
    } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
        w = (r21 - r12) / s;
        x = 0.25 * s;
        y = (r01 + r10) / s;
        z = (r02 + r20) / s;
    } else if (r11 > r22) {
        const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
        w = (r02 - r20) / s;
        x = (r01 + r10) / s;
        y = 0.25 * s;
        z = (r12 + r21) / s;
    } else {
        const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
        w = (r10 - r01) / s;
        x = (r02 + r20) / s;
        y = (r12 + r21) / s;
        z = 0.25 * s;
    }
    return normalizeQuat([x, y, z, w]);
}

function transformPoint(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
}

function transformDirection(m: Float32Array, x: number, y: number, z: number): [number, number, number] {
    const nx = m[0] * x + m[4] * y + m[8] * z;
    const ny = m[1] * x + m[5] * y + m[9] * z;
    const nz = m[2] * x + m[6] * y + m[10] * z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    return [nx / len, ny / len, nz / len];
}

function normalizeQuat(q: [number, number, number, number]): [number, number, number, number] {
    const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
    return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function readAscii4(bytes: Uint8Array, offset: number): string {
    if (offset < 0 || offset + 4 > bytes.length) return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readAsciiZ(bytes: Uint8Array, offset: number, length: number): string {
    const end = Math.min(bytes.length, offset + length);
    const chars: number[] = [];
    for (let i = offset; i < end; i++) {
        const b = bytes[i];
        if (b === 0) break;
        chars.push(b);
    }
    return String.fromCharCode(...chars).trim();
}

function readU16FromArray(bytes: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 2 > bytes.length) return 0;
    return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readU32FromArray(bytes: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > bytes.length) return 0;
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readI32FromArray(bytes: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > bytes.length) return -1;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return view.getInt32(0, true);
}

function readF32FromArray(bytes: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 4 > bytes.length) return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return view.getFloat32(0, true);
}
