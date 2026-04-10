'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEY_BLOCK_TABLE = exports.KEY_HASH_TABLE = exports.CRYPTO_TABLE = void 0;
exports.mpqHash = mpqHash;
exports.mpqDecrypt = mpqDecrypt;
/**
 * MPQ cryptographic primitives.
 * Ported from JMPQ3 (systems.crigges.jmpq3.security).
 *
 * MPQ uses a single 5×256 lookup table derived from a deterministic seed to
 * drive hashing and encryption.  The five sub-tables serve different roles:
 *   0 – table-offset hash (bucket index into the hash table)
 *   1 – file-key hash part 1
 *   2 – file-key hash part 2
 *   3 – encryption-key hash  (used to derive per-file decryption keys)
 *   4 – stream-cipher data   (used during encrypt/decrypt)
 */
// ---------------------------------------------------------------------------
// Cryptographic lookup table  (CryptographicLUT.java)
// ---------------------------------------------------------------------------
function updateSeed(s) {
    // s is always in [0, 0x2AAAAA]; multiplication stays well inside float64 range.
    return (s * 125 + 3) % 0x2AAAAB;
}
/** CRYPTO_TABLE[tableIndex][byteValue] → signed 32-bit int */
exports.CRYPTO_TABLE = Array.from({ length: 5 }, () => new Int32Array(256));
(function buildTable() {
    let s = 0x00100001;
    for (let v = 0; v < 256; v++) {
        for (let t = 0; t < 5; t++) {
            s = updateSeed(s);
            // Java: (short) seed → 16-bit signed; (int) seed1 << 16 sign-extends then shifts.
            // In JS, << already operates on 32-bit ints, so (s & 0xFFFF) << 16 is equivalent.
            const hi = (s & 0xFFFF) << 16;
            s = updateSeed(s);
            const lo = s & 0xFFFF; // Short.toUnsignedInt in Java → just mask lower 16
            exports.CRYPTO_TABLE[t][v] = hi | lo; // result is signed int32 (JS bitwise always returns int32)
        }
    }
})();
// ---------------------------------------------------------------------------
// MPQ hash generator  (MPQHashGenerator.java)
// ---------------------------------------------------------------------------
/**
 * Compute one of the four MPQ hash variants for a filename.
 *
 * @param name  File path (case-insensitive, backslash or forward slash)
 * @param type  0 = table offset, 1 = key1, 2 = key2, 3 = file/encryption key
 */
function mpqHash(name, type) {
    const lut = exports.CRYPTO_TABLE[type];
    let seed1 = 0x7FED7FED | 0;
    let seed2 = 0xEEEEEEEE | 0;
    const upper = name.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
        const c = upper.charCodeAt(i) & 0xFF;
        seed1 = (lut[c] ^ (seed1 + seed2)) | 0;
        seed2 = (c + seed1 + seed2 + (seed2 << 5) + 3) | 0;
    }
    return seed1;
}
// ---------------------------------------------------------------------------
// MPQ stream cipher  (MPQEncryption.java, decrypt direction only)
// ---------------------------------------------------------------------------
/**
 * Decrypt a block of data in-place.
 *
 * The data is treated as a stream of little-endian 32-bit integers.
 * Any trailing bytes that don't form a complete 4-byte word are left unchanged
 * (matching Java's processFinal behaviour).
 *
 * @param buf  Data to decrypt (modified in-place)
 * @param key  32-bit encryption key
 */
function mpqDecrypt(buf, key) {
    const encLut = exports.CRYPTO_TABLE[4];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let k = key | 0;
    let seed = 0xEEEEEEEE | 0;
    const words = Math.floor(buf.length / 4);
    for (let i = 0; i < words; i++) {
        const pos = i * 4;
        seed = (seed + encLut[k & 0xFF]) | 0;
        const block = (k + seed) | 0;
        const enc = view.getInt32(pos, true);
        const dec = enc ^ block;
        view.setInt32(pos, dec, true);
        // decrypt=true → use decrypted value (out) to advance seed
        seed = (seed + dec + (seed << 5) + 3) | 0;
        k = ((~k << 21) + 0x11111111 | (k >>> 11)) | 0;
    }
}
// ---------------------------------------------------------------------------
// Pre-computed keys for the two special internal tables
// ---------------------------------------------------------------------------
/** Decryption key for the MPQ hash table. */
exports.KEY_HASH_TABLE = mpqHash('(hash table)', 3);
/** Decryption key for the MPQ block table. */
exports.KEY_BLOCK_TABLE = mpqHash('(block table)', 3);
