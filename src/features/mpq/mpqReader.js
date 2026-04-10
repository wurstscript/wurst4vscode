'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.MpqReader = void 0;
/**
 * Read-only MPQ archive reader.
 *
 * Ported from JMPQ3 (systems.crigges.jmpq3.JMpqEditor + MpqFile + BlockTable
 * + HashTable), stripped of all write operations.
 *
 * Supports:
 *   - MPQ v0 / v1 (all WC3 maps use v0 or v1)
 *   - Multi-sector and single-unit files
 *   - Encrypted files (including ADJUSTED_ENCRYPTED key variant)
 *   - Compression: deflate (0x02) and PKWare implode (0x08)
 *   - (listfile) enumeration
 *
 * Not supported (returns an error):
 *   - bzip2 (0x10), LZMA (0x12), Huffman (0x01), ADPCM (0x40/0x80)
 *   - These compression types do not appear in WC3 map data files.
 */
const zlib_1 = require("zlib");
const crypto_1 = require("./crypto");
const explode_1 = require("./explode");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAGIC_ARCHIVE = 0x1A51504D; // 'MPQ\x1A' as little-endian int32
const MAGIC_USERDATA = 0x1B51504D; // 'MPQ\x1B' as little-endian int32
// Block flags (MpqFile.java)
const FLAG_EXISTS = 0x80000000;
const FLAG_DELETED = 0x02000000;
const FLAG_SINGLE_UNIT = 0x01000000;
const FLAG_ADJUSTED_KEY = 0x00020000;
const FLAG_ENCRYPTED = 0x00010000;
const FLAG_COMPRESSED = 0x00000200;
const FLAG_IMPLODED = 0x00000100;
// Compression type bytes (CompressionUtil.java)
const COMP_HUFFMAN = 0x01;
const COMP_DEFLATE = 0x02;
const COMP_IMPLODE = 0x08;
const COMP_BZIP2 = 0x10;
const COMP_ADPCM1C = 0x40;
const COMP_ADPCM2C = 0x80;
// Hash table sentinel values
const HASH_ENTRY_EMPTY = 0xFFFFFFFF; // -1 as uint32
const HASH_ENTRY_DELETED = 0xFFFFFFFE; // -2 as uint32
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hasFlag(flags, flag) {
    // flags is treated as unsigned (Java int cast to unsigned comparison)
    return (flags & flag) === (flag | 0);
}
function readU32LE(buf, offset) {
    return buf.readUInt32LE(offset);
}
function readI32LE(buf, offset) {
    return buf.readInt32LE(offset);
}
// ---------------------------------------------------------------------------
// Decompression
// ---------------------------------------------------------------------------
/**
 * Decompress a single sector.
 * If compressedSize === uncompressedSize the data is already raw — return as-is.
 * Otherwise byte 0 is a compression-type bitmask.
 */
function decompressSector(sector, compressedSize, uncompressedSize) {
    if (compressedSize === uncompressedSize) {
        return sector.subarray(0, uncompressedSize);
    }
    const compressionType = sector[0];
    if (compressionType & COMP_DEFLATE) {
        // zlib-wrapped deflate; data starts at byte 1
        const raw = Buffer.from(sector.buffer, sector.byteOffset + 1, compressedSize - 1);
        return new Uint8Array((0, zlib_1.inflateSync)(raw));
    }
    if (compressionType & COMP_IMPLODE) {
        // PKWare DCL; inputOffset=1 to skip the compression-type byte
        return (0, explode_1.explode)(sector, uncompressedSize, 1);
    }
    // Unsupported compression types for data files
    const unsupported = [];
    if (compressionType & COMP_HUFFMAN)
        unsupported.push('Huffman');
    if (compressionType & COMP_BZIP2)
        unsupported.push('bzip2');
    if (compressionType & COMP_ADPCM1C)
        unsupported.push('ADPCM-1ch');
    if (compressionType & COMP_ADPCM2C)
        unsupported.push('ADPCM-2ch');
    if (unsupported.length) {
        throw new Error(`Unsupported MPQ compression: ${unsupported.join(', ')} (byte 0x${compressionType.toString(16)})`);
    }
    throw new Error(`Unknown MPQ compression byte: 0x${compressionType.toString(16)}`);
}
// ---------------------------------------------------------------------------
// Main reader
// ---------------------------------------------------------------------------
class MpqReader {
    constructor(buf, headerOffset, discBlockSize, hashTable, blockTable) {
        this.buf = buf;
        this.headerOffset = headerOffset;
        this.discBlockSize = discBlockSize;
        this.hashTable = hashTable;
        this.hashTableSize = hashTable.length;
        this.blockTable = blockTable;
    }
    // -----------------------------------------------------------------------
    // Factory
    // -----------------------------------------------------------------------
    static open(buf) {
        const headerOffset = MpqReader.findHeader(buf);
        // After magic (4 bytes) comes headerSize (4 bytes)
        const headerSize = readU32LE(buf, headerOffset + 4);
        const clampedHeaderSize = Math.max(32, Math.min(headerSize, 208));
        // Read fields from the v0 header (32 bytes after magic+headerSize)
        // Layout: [magic 4][headerSize 4][archiveSize 4][formatVersion 2]
        //         [sectorSizeShift 2][hashPos 4][blockPos 4][hashSize 4][blockSize 4]
        const base = headerOffset + 8; // skip magic + headerSize
        // archiveSize at +0, skip it
        // formatVersion at +4 (uint16)
        const formatVersion = buf.readUInt16LE(base + 4);
        const sectorSizeShift = buf.readUInt16LE(base + 6);
        const discBlockSize = 512 * (1 << sectorSizeShift);
        let hashPos = readU32LE(buf, base + 8);
        let blockPos = readU32LE(buf, base + 12);
        const hashSize = readU32LE(buf, base + 16) & 0x0FFFFFFF;
        const blockSize = readI32LE(buf, base + 20);
        // v1 extension: high 16 bits of hashPos / blockPos
        if (formatVersion >= 1 && clampedHeaderSize >= 44) {
            const extBase = headerOffset + 8 + 24; // after the base 24 bytes
            // skip 8-byte high block table offset
            const hashHigh = buf.readUInt16LE(extBase + 8);
            const blockHigh = buf.readUInt16LE(extBase + 10);
            hashPos |= hashHigh << 16; // top 16 bits (these stay within 32-bit for v1)
            blockPos |= blockHigh << 16;
        }
        const hashTable = MpqReader.readHashTable(buf, headerOffset, hashPos, hashSize);
        const blockTable = MpqReader.readBlockTable(buf, headerOffset, blockPos, blockSize);
        return new MpqReader(buf, headerOffset, discBlockSize, hashTable, blockTable);
    }
    // -----------------------------------------------------------------------
    // Header search  (JMpqEditor.searchHeader)
    // Scans at 512-byte boundaries for MPQ\x1A or MPQ\x1B.
    // -----------------------------------------------------------------------
    static findHeader(buf) {
        for (let pos = 0; pos + 4 <= buf.length; pos += 0x200) {
            const magic = readU32LE(buf, pos);
            if (magic === MAGIC_ARCHIVE) {
                return pos;
            }
            if (magic === MAGIC_USERDATA) {
                // User-data header: offset to real MPQ header is at +8
                const redirect = readU32LE(buf, pos + 8);
                const candidate = (pos + redirect) & ~0x1FF; // align to 512
                if (candidate + 4 <= buf.length && readU32LE(buf, candidate) === MAGIC_ARCHIVE) {
                    return candidate;
                }
                // If that didn't work, continue scanning
            }
        }
        throw new Error('No MPQ archive header found in buffer');
    }
    // -----------------------------------------------------------------------
    // Hash table  (HashTable.java)
    // -----------------------------------------------------------------------
    static readHashTable(buf, headerOffset, hashPos, hashSize) {
        const byteCount = hashSize * 16;
        const start = headerOffset + hashPos;
        if (start + byteCount > buf.length) {
            throw new Error('MPQ hash table extends beyond buffer');
        }
        const raw = Buffer.from(buf.buffer, buf.byteOffset + start, byteCount);
        const copy = Buffer.from(raw); // decrypt in-place on a copy
        (0, crypto_1.mpqDecrypt)(copy, crypto_1.KEY_HASH_TABLE);
        const entries = [];
        for (let i = 0; i < hashSize; i++) {
            const base = i * 16;
            entries.push({
                key1: readI32LE(copy, base), // lower 32 of 64-bit key
                key2: readI32LE(copy, base + 4), // upper 32 of 64-bit key
                locale: copy.readUInt16LE(base + 8),
                // platform at +10 is ignored
                blockIndex: readU32LE(copy, base + 12), // uint32 (may be sentinel)
            });
        }
        return entries;
    }
    // -----------------------------------------------------------------------
    // Block table  (BlockTable.java)
    // -----------------------------------------------------------------------
    static readBlockTable(buf, headerOffset, blockPos, blockCount) {
        const byteCount = blockCount * 16;
        const start = headerOffset + blockPos;
        if (start + byteCount > buf.length) {
            throw new Error('MPQ block table extends beyond buffer');
        }
        const raw = Buffer.from(buf.buffer, buf.byteOffset + start, byteCount);
        const copy = Buffer.from(raw);
        (0, crypto_1.mpqDecrypt)(copy, crypto_1.KEY_BLOCK_TABLE);
        const blocks = [];
        for (let i = 0; i < blockCount; i++) {
            const base = i * 16;
            const flags = readU32LE(copy, base + 12);
            blocks.push({
                filePos: readU32LE(copy, base),
                compressedSize: readU32LE(copy, base + 4),
                normalSize: readU32LE(copy, base + 8),
                flags,
            });
        }
        return blocks;
    }
    // -----------------------------------------------------------------------
    // File lookup  (HashTable.getFileBlockIndex)
    // -----------------------------------------------------------------------
    findBlockIndex(name) {
        const offset = (0, crypto_1.mpqHash)(name, 0) >>> 0; // unsigned
        const key1 = (0, crypto_1.mpqHash)(name, 1);
        const key2 = (0, crypto_1.mpqHash)(name, 2);
        const mask = this.hashTableSize - 1;
        const start = offset & mask;
        for (let c = 0; c < this.hashTableSize; c++) {
            const entry = this.hashTable[(start + c) & mask];
            if (entry.blockIndex === HASH_ENTRY_EMPTY) {
                break; // probe chain terminated
            }
            if (entry.blockIndex === HASH_ENTRY_DELETED) {
                continue;
            }
            if (entry.key1 === key1 && entry.key2 === key2) {
                return entry.blockIndex;
            }
        }
        return null;
    }
    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------
    hasFile(name) {
        return this.findBlockIndex(name) !== null;
    }
    /**
     * Extract a file by name and return its contents.
     * Throws if the file is not found or uses unsupported compression.
     */
    readFile(name) {
        const blockIndex = this.findBlockIndex(name);
        if (blockIndex === null) {
            throw new Error(`File not found in MPQ: ${name}`);
        }
        const block = this.blockTable[blockIndex];
        if (block === undefined) {
            throw new Error(`MPQ block index ${blockIndex} out of range`);
        }
        if (!hasFlag(block.flags, FLAG_EXISTS) || hasFlag(block.flags, FLAG_DELETED)) {
            throw new Error(`MPQ block for ${name} is deleted or missing`);
        }
        if (block.normalSize === 0) {
            return Buffer.alloc(0);
        }
        const dataStart = this.headerOffset + block.filePos;
        const blockData = this.buf.subarray(dataStart, dataStart + block.compressedSize);
        // Compute decryption base key (MpqFile constructor)
        let baseKey = 0;
        let isEncrypted = false;
        if (hasFlag(block.flags, FLAG_ENCRYPTED)) {
            isEncrypted = true;
            // Key is derived from just the filename (no path)
            const sep = name.lastIndexOf('\\');
            const pathlessName = name.substring(sep + 1);
            baseKey = (0, crypto_1.mpqHash)(pathlessName, 3);
            if (hasFlag(block.flags, FLAG_ADJUSTED_KEY)) {
                baseKey = ((baseKey + block.filePos) ^ block.normalSize) | 0;
            }
        }
        if (hasFlag(block.flags, FLAG_SINGLE_UNIT)) {
            return this.extractSingleUnit(blockData, block, isEncrypted, baseKey);
        }
        if (hasFlag(block.flags, FLAG_IMPLODED)) {
            return this.extractImploded(blockData, block, isEncrypted, baseKey);
        }
        if (hasFlag(block.flags, FLAG_COMPRESSED)) {
            return this.extractCompressed(blockData, block, isEncrypted, baseKey);
        }
        // Uncompressed, possibly encrypted
        const raw = Buffer.from(blockData);
        if (isEncrypted) {
            (0, crypto_1.mpqDecrypt)(raw, baseKey);
        }
        return raw.subarray(0, block.normalSize);
    }
    // -----------------------------------------------------------------------
    // Extraction helpers  (MpqFile.java)
    // -----------------------------------------------------------------------
    sectorCount(normalSize) {
        return Math.ceil(normalSize / this.discBlockSize) + 1;
    }
    extractSingleUnit(blockData, block, encrypted, baseKey) {
        const arr = Buffer.from(blockData);
        if (encrypted) {
            (0, crypto_1.mpqDecrypt)(arr, baseKey);
        }
        if (hasFlag(block.flags, FLAG_COMPRESSED)) {
            return Buffer.from(decompressSector(arr, block.compressedSize, block.normalSize));
        }
        return arr.subarray(0, block.normalSize);
    }
    extractImploded(blockData, block, encrypted, baseKey) {
        const sc = this.sectorCount(block.normalSize);
        const sotBytes = sc * 4;
        const sotRaw = Buffer.from(blockData.subarray(0, sotBytes));
        if (encrypted) {
            (0, crypto_1.mpqDecrypt)(sotRaw, (baseKey - 1) | 0);
        }
        const out = Buffer.alloc(block.normalSize);
        let written = 0;
        let start = sotRaw.readUInt32LE(0);
        for (let i = 0; i < sc - 1; i++) {
            const end = sotRaw.readUInt32LE((i + 1) * 4);
            const sector = Buffer.from(blockData.subarray(start, end));
            if (encrypted) {
                (0, crypto_1.mpqDecrypt)(sector, (baseKey + i) | 0);
            }
            const remaining = block.normalSize - written;
            const expectedOut = remaining <= this.discBlockSize ? remaining : this.discBlockSize;
            const decompressed = (0, explode_1.explode)(sector, expectedOut, 0);
            decompressed.forEach((b, j) => { out[written + j] = b; });
            written += decompressed.length;
            start = end;
        }
        return out.subarray(0, written);
    }
    extractCompressed(blockData, block, encrypted, baseKey) {
        const sc = this.sectorCount(block.normalSize);
        const sotBytes = sc * 4;
        const sotRaw = Buffer.from(blockData.subarray(0, sotBytes));
        if (encrypted) {
            (0, crypto_1.mpqDecrypt)(sotRaw, (baseKey - 1) | 0);
        }
        const out = Buffer.alloc(block.normalSize);
        let written = 0;
        let start = sotRaw.readUInt32LE(0);
        for (let i = 0; i < sc - 1; i++) {
            const end = sotRaw.readUInt32LE((i + 1) * 4);
            const compLen = end - start;
            const sector = Buffer.from(blockData.subarray(start, end));
            if (encrypted) {
                (0, crypto_1.mpqDecrypt)(sector, (baseKey + i) | 0);
            }
            const remaining = block.normalSize - written;
            const expectedOut = remaining <= this.discBlockSize ? remaining : this.discBlockSize;
            const decompressed = decompressSector(sector, compLen, expectedOut);
            decompressed.forEach((b, j) => { out[written + j] = b; });
            written += decompressed.length;
            start = end;
            if (start === 0)
                break; // SOT ran out
        }
        return out.subarray(0, written);
    }
    // -----------------------------------------------------------------------
    // Listfile
    // -----------------------------------------------------------------------
    /**
     * Return the list of filenames from `(listfile)`.
     * Returns an empty array if no listfile is present.
     */
    listFiles() {
        if (this._listfile)
            return this._listfile;
        if (!this.hasFile('(listfile)')) {
            this._listfile = [];
            return this._listfile;
        }
        const raw = this.readFile('(listfile)');
        this._listfile = raw
            .toString('utf8')
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 0);
        return this._listfile;
    }
}
exports.MpqReader = MpqReader;
