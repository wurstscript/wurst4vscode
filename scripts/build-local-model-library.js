'use strict';

// file: dependencies export dist, so webpack otherwise silently bundles an old renderer.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const library = path.dirname(path.dirname(require.resolve('war3-model')));
if (fs.existsSync(path.join(library, 'mdx', 'parse.ts'))) {
    if (!process.env.npm_execpath) throw new Error('Run this build hook through npm.');
    const result = spawnSync(process.execPath, [process.env.npm_execpath, '--prefix', library, 'run', 'build-lib'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
