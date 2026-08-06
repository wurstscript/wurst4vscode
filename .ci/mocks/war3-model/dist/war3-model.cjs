'use strict';

class ModelRenderer {}

function parseMDX() {
    return { Sequences: [] };
}

function parseMDL() {
    return { Sequences: [] };
}

function decodeBLP() {
    return {};
}

function getBLPImageData() {
    return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
}

module.exports = { ModelRenderer, parseMDL, parseMDX, decodeBLP, getBLPImageData };
