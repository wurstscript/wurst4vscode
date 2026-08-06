'use strict';

class ModelRenderer {}

function emptyModel() {
    return {
        Info: {
            MinimumExtent: new Float32Array([0, 0, 0]),
            MaximumExtent: new Float32Array([0, 0, 0]),
            BoundsRadius: 0,
        },
        Sequences: [],
    };
}

function parseMDX() {
    return emptyModel();
}

function parseMDL() {
    return emptyModel();
}

function decodeBLP() {
    return {};
}

function getBLPImageData() {
    return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
}

module.exports = { ModelRenderer, parseMDL, parseMDX, decodeBLP, getBLPImageData };
