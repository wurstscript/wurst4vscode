'use strict';

function unsupported(name) {
    return function () {
        throw new Error(`CI mock casc-ts formatter called: ${name}`);
    };
}

class BinReader {}
class MpqReader {
    static open() { throw new Error('CI mock casc-ts MPQ reader is not available'); }
}

module.exports = {
    BinReader,
    MpqReader,
    decodeBlp: unsupported('decodeBlp'),
    decodeDds: unsupported('decodeDds'),
    decodeTga: unsupported('decodeTga'),
    parseDoo: unsupported('parseDoo'),
    parseObjMod: unsupported('parseObjMod'),
    parseW3i: unsupported('parseW3i'),
    parseWct: unsupported('parseWct'),
    parseWtg: unsupported('parseWtg'),
    parseWpm: unsupported('parseWpm'),
    serializeObjMod: unsupported('serializeObjMod'),
    serializeW3i: unsupported('serializeW3i'),
};
