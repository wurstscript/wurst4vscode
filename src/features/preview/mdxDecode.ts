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
    sequences: MdxSequenceInfo[];
    positionsBase64: string;
    normalsBase64: string;
    indicesBase64: string;
    warnings: string[];
    description: string;
};

type MdxNode = {
    objectId: number;
    parentId: number;
    translation: [number, number, number];
    rotation: [number, number, number, number];
    scaling: [number, number, number];
    pivot: [number, number, number];
    worldMatrix?: Float32Array;
};

type ParsedGeoset = {
    vertices: number[];
    normals: number[];
    indices: number[];
    vertexGroupByVertex: number[];
    matrixGroupCounts: number[];
    matrixIndices: number[];
};

export function decodeMdx(sourceBytes: Uint8Array): DecodedMdxModel {
    try {
        return decodeMdxInternal(sourceBytes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed reading MDX: ${message}`);
    }
}

function decodeMdxInternal(sourceBytes: Uint8Array): DecodedMdxModel {
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
    const sequences: MdxSequenceInfo[] = [];
    const allPositions: number[] = [];
    const allNormals: number[] = [];
    const allIndices: number[] = [];
    let geosetsCount = 0;

    const pivots: Array<[number, number, number]> = [];
    const nodeMap = new Map<number, MdxNode>();
    const geosets: ParsedGeoset[] = [];

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
                    looping: (flags & 0x1) > 0,
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
            parseNodeEntries(chunk, 8, warn, (entry) => {
                nodeMap.set(entry.objectId, entry);
            });
            continue;
        }

        if (token === 'HELP') {
            parseNodeEntries(chunk, 0, warn, (entry) => {
                nodeMap.set(entry.objectId, entry);
            });
            continue;
        }

        if (token !== 'GEOS') continue;

        let gpos = 0;
        while (gpos + 4 <= chunk.length) {
            const maybeToken = readAscii4(chunk, gpos);
            if (maybeToken === 'VRTX') {
                const parsed = parseMdxGeoset(chunk.subarray(gpos), warn);
                geosets.push(parsed);
                geosetsCount++;
                gpos += Math.max(1, parsed.consumedBytes);
                continue;
            }

            const inclusiveSize = readU32FromArray(chunk, gpos);
            const geosetEnd = gpos + 4 + inclusiveSize;
            if (inclusiveSize <= 0 || geosetEnd > chunk.length) {
                warn(`GEOS geoset has invalid inclusiveSize ${inclusiveSize}.`);
                break;
            }

            geosetsCount++;
            const geoset = chunk.subarray(gpos + 4, geosetEnd);
            const parsed = parseMdxGeoset(geoset, warn);
            if (parsed.consumedBytes !== geoset.length) {
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

    for (const geoset of geosets) {
        applyBindPoseSkinning(geoset, nodeMap, warnOnce);
        const baseVertex = allPositions.length / 3;
        for (const v of geoset.vertices) allPositions.push(v);
        for (const n of geoset.normals) allNormals.push(n);
        for (const idx of geoset.indices) allIndices.push(baseVertex + idx);
    }

    const positions = new Float32Array(allPositions);
    const normals = new Float32Array(allNormals);
    const indices = new Uint32Array(allIndices);
    return {
        kind: 'model',
        modelName,
        nodesCount: nodeMap.size,
        geosetsCount,
        trianglesCount: Math.floor(indices.length / 3),
        sequences,
        positionsBase64: Buffer.from(positions.buffer).toString('base64'),
        normalsBase64: Buffer.from(normals.buffer).toString('base64'),
        indicesBase64: Buffer.from(indices.buffer).toString('base64'),
        warnings,
        description: 'MDX static geosets (bind-pose skinning)',
    };
}

function parseNodeEntries(
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
        if (size <= 0 || pos + 4 + size > chunk.length) {
            warn(`Node chunk has invalid entry size ${size}.`);
            break;
        }

        const entryStart = pos + 4;
        const entryEnd = entryStart + size;
        if (entryStart + 96 > entryEnd) {
            warn(`Node entry size ${size} is too small.`);
            pos = entryEnd;
            continue;
        }

        const objectId = readU32FromArray(chunk, entryStart + 80);
        const parentId = readI32FromArray(chunk, entryStart + 84);

        const tracks = parseNodeTracks(chunk, entryStart + 96, entryEnd, warn);
        if (tracks.nextPos + trailingBytesAfterNode > entryEnd) {
            warn(`Node ${objectId} entry is truncated (expected ${trailingBytesAfterNode} trailing bytes).`);
        }
        onNode({
            objectId,
            parentId,
            translation: tracks.translation,
            rotation: tracks.rotation,
            scaling: tracks.scaling,
            pivot: [0, 0, 0],
        });

        pos = entryEnd;
    }
}

function parseNodeTracks(
    bytes: Uint8Array,
    start: number,
    end: number,
    warn: (msg: string) => void
): {
    nextPos: number;
    translation: [number, number, number];
    rotation: [number, number, number, number];
    scaling: [number, number, number];
} {
    const translation: [number, number, number] = [0, 0, 0];
    const rotation: [number, number, number, number] = [0, 0, 0, 1];
    const scaling: [number, number, number] = [1, 1, 1];

    let pos = start;
    while (pos + 8 <= end) {
        const token = readAscii4(bytes, pos);
        if (token !== 'KGTR' && token !== 'KGRT' && token !== 'KGSC') {
            break;
        }
        const size = readU32FromArray(bytes, pos + 4);
        const blockStart = pos + 8;
        const blockEnd = blockStart + size;
        if (size <= 0 || blockEnd > end) {
            warn(`Node track ${token} has invalid size ${size}.`);
            break;
        }

        if (token === 'KGTR') {
            const v = readTrackVec3(bytes, blockStart, blockEnd);
            if (v) translation[0] = v[0], translation[1] = v[1], translation[2] = v[2];
        } else if (token === 'KGRT') {
            const q = readTrackQuat(bytes, blockStart, blockEnd);
            if (q) rotation[0] = q[0], rotation[1] = q[1], rotation[2] = q[2], rotation[3] = q[3];
        } else if (token === 'KGSC') {
            const v = readTrackVec3(bytes, blockStart, blockEnd);
            if (v) scaling[0] = v[0], scaling[1] = v[1], scaling[2] = v[2];
        }

        pos = blockEnd;
    }

    return { nextPos: pos, translation, rotation: normalizeQuat(rotation), scaling };
}

function readTrackVec3(bytes: Uint8Array, start: number, end: number): [number, number, number] | null {
    if (start + 12 > end) return null;
    const tracksCount = readU32FromArray(bytes, start);
    const interpolationType = readU32FromArray(bytes, start + 4);
    let pos = start + 12;
    if (tracksCount <= 0 || pos + 4 + 12 > end) return null;

    pos += 4; // time
    const v: [number, number, number] = [readF32FromArray(bytes, pos), readF32FromArray(bytes, pos + 4), readF32FromArray(bytes, pos + 8)];
    pos += 12;

    if (interpolationType > 1) {
        if (pos + 24 > end) return v;
    }
    return v;
}

function readTrackQuat(bytes: Uint8Array, start: number, end: number): [number, number, number, number] | null {
    if (start + 12 > end) return null;
    const tracksCount = readU32FromArray(bytes, start);
    const interpolationType = readU32FromArray(bytes, start + 4);
    let pos = start + 12;
    if (tracksCount <= 0 || pos + 4 + 16 > end) return null;

    pos += 4; // time
    const q: [number, number, number, number] = [
        readF32FromArray(bytes, pos),
        readF32FromArray(bytes, pos + 4),
        readF32FromArray(bytes, pos + 8),
        readF32FromArray(bytes, pos + 12),
    ];
    pos += 16;

    if (interpolationType > 1) {
        if (pos + 32 > end) return normalizeQuat(q);
    }
    return normalizeQuat(q);
}

function applyBindPoseSkinning(geoset: ParsedGeoset, nodeMap: Map<number, MdxNode>, warnOnce: (msg: string) => void): void {
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
            const node = nodeMap.get(nodeId);
            if (!node) {
                warnOnce(`Missing node ${nodeId} referenced by geoset matrix group.`);
                continue;
            }
            const world = getNodeWorldMatrix(node, nodeMap, warnOnce, new Set<number>());
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
    warnOnce: (msg: string) => void,
    chain: Set<number>
): Float32Array {
    if (node.worldMatrix) return node.worldMatrix;

    if (chain.has(node.objectId)) {
        warnOnce(`Cycle detected in node hierarchy at objectId ${node.objectId}.`);
        node.worldMatrix = mat4FromTRSP(node.translation, node.rotation, node.scaling, node.pivot);
        return node.worldMatrix;
    }

    chain.add(node.objectId);
    const local = mat4FromTRSP(node.translation, node.rotation, node.scaling, node.pivot);
    if (node.parentId >= 0) {
        const parent = nodeMap.get(node.parentId);
        if (parent) {
            const parentWorld = getNodeWorldMatrix(parent, nodeMap, warnOnce, chain);
            node.worldMatrix = mat4Multiply(parentWorld, local);
        } else {
            warnOnce(`Node ${node.objectId} references missing parent ${node.parentId}.`);
            node.worldMatrix = local;
        }
    } else {
        node.worldMatrix = local;
    }
    chain.delete(node.objectId);
    return node.worldMatrix;
}

function parseMdxGeoset(geoset: Uint8Array, warn: (msg: string) => void): ParsedGeoset & { consumedBytes: number } {
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

    const tailEndSd = parseGeosetTail(geoset, pos, false);
    const tailEndHd = parseGeosetTail(geoset, pos, true);
    if (tailEndSd < 0 && tailEndHd < 0) {
        throw new Error('geoset fixed fields are truncated or unsupported');
    }
    if (tailEndHd >= 0 && (tailEndSd < 0 || tailEndHd >= tailEndSd)) {
        pos = tailEndHd;
    } else {
        pos = tailEndSd;
    }

    const triangles = buildTriangles(faceTypes, faceGroups, faceIndices, warn);
    return { vertices, normals, indices: triangles, vertexGroupByVertex, matrixGroupCounts, matrixIndices, consumedBytes: pos };
}

function parseGeosetTail(geoset: Uint8Array, start: number, includeHdLod: boolean): number {
    let pos = start;
    if (pos + 12 > geoset.length) return -1;
    pos += 12; // materialId, selectionGroup, selectionFlags

    if (includeHdLod) {
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
