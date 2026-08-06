'use strict';

class CascStorage {
    static async openAsync() { throw new Error('CI mock casc-ts storage is not available'); }
}
class MpqStorage {
    static async openAsync() { throw new Error('CI mock casc-ts storage is not available'); }
}

async function closeAllSegments() {}

module.exports = { CascStorage, MpqStorage, closeAllSegments };
