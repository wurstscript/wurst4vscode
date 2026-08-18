'use strict';

/**
 * Minimal static server standing in for VS Code's webview resource scheme.
 *
 * The page is served over a real http origin rather than `page.setContent`, because the host's own
 * Content-Security-Policy is built from `webview.cspSource` — pointing that at this origin means the
 * shipped CSP has to genuinely admit the bundle and assets the page loads, so a CSP regression shows
 * up as a broken test instead of passing silently.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const { root } = require('./tsLoader');

const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ttf': 'font/ttf',
    '.map': 'application/json; charset=utf-8',
};

async function startHarnessServer() {
    /** @type {Map<string, string>} */
    const pages = new Map();
    let nextId = 0;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const send = (status, type, body) => {
            res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
            res.end(body);
        };

        if (url.pathname.startsWith('/page/')) {
            const html = pages.get(url.pathname.slice('/page/'.length));
            if (html == null) return send(404, 'text/plain', 'no such page');
            return send(200, MIME['.html'], html);
        }

        let abs;
        if (url.pathname.startsWith('/file/')) {
            abs = decodeURIComponent(url.pathname.slice('/file/'.length));
        } else if (url.pathname.startsWith('/dist/')) {
            abs = path.join(root, url.pathname.replace(/^\//, ''));
            // Keep served files inside the repo's dist dir — this server is only ever local, but a
            // traversal here would silently read arbitrary files into the page under test.
            if (!path.resolve(abs).startsWith(path.join(root, 'dist'))) return send(403, 'text/plain', 'denied');
        } else {
            return send(404, 'text/plain', 'not found');
        }

        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(404, 'text/plain', `missing: ${abs}`);
        return send(200, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', fs.readFileSync(abs));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;

    return {
        origin,
        /** Registers a page body and returns the URL to navigate to. */
        publish(html) {
            const id = String(nextId++);
            pages.set(id, html);
            return `${origin}/page/${id}`;
        },
        async close() {
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

module.exports = { startHarnessServer };
