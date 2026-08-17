'use strict';

/**
 * Copy / cut / paste in the objmod tooltip editor, driven by **real OS-trusted keystrokes**.
 *
 * This is the one thing the headless suite genuinely cannot check: `document.execCommand('copy')`
 * silently no-ops for a script-synthesised event with no user gesture behind it, so calling the
 * debug hooks alone can only prove the DOM/selection state is right, never that the clipboard
 * actually moved. Playwright's `keyboard.press` dispatches through CDP Input, which the renderer
 * treats as trusted — the same mechanism the previous hand-rolled harness used.
 *
 * Ported from scripts/objmod-clipboard-e2e.js.
 */

const { test, expect, waitFor, CLIPBOARD_TEST_VALUE, skipUnlessEnabled } = require('./fixtures');

skipUnlessEnabled();

const debug = (frame, expression) => frame.evaluate(expression);

/** Real keystroke into the VS Code window, after making sure it is the OS foreground window. */
async function pressInWindow(session, frame, combo) {
    await frame.page().bringToFront().catch(() => undefined);
    session.bringToForeground();
    // SetForegroundWindow is asynchronous from the renderer's point of view — dispatching before the
    // window has actually taken focus is exactly the case where Ctrl+C silently does nothing.
    await frame.evaluate(() => new Promise((resolve) => {
        const start = Date.now();
        const check = () => {
            if (document.hasFocus() || Date.now() - start > 3000) resolve();
            else setTimeout(check, 50);
        };
        check();
    }));
    await frame.page().keyboard.press(combo);
}

test.describe('objmod tooltip clipboard', () => {
    test('copy + paste round-trips the text and its WC3 colour', async ({ objmodFrame }) => {
        const { frame, session } = objmodFrame;
        session.bringToForeground();

        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.selectObject('Z001')),
            (value) => value === true,
            'the Z001 fixture object to be selectable',
        );
        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.openFirstTooltipField()),
            (value) => value === true,
            'a tooltip field to exist and open',
        );
        const original = await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyText()),
            (value) => typeof value === 'string' && value.length > 0,
            'the editable tooltip body to contain the fixture text',
        );
        expect(original).toContain('Copy Paste Test');

        await debug(frame, () => window.__wurstModelThumbDebug.selectAllInEditableBody());
        await pressInWindow(session, frame, 'Control+c');

        await debug(frame, () => window.__wurstModelThumbDebug.setEditableBodyText(''));
        expect(await debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyText())).toBe('');

        await debug(frame, () => window.__wurstModelThumbDebug.focusEditableBody());
        await pressInWindow(session, frame, 'Control+v');

        const pasted = await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyText()),
            (value) => typeof value === 'string' && value.length > 0,
            'pasted text to appear after Ctrl+V',
        );
        expect(pasted, 'copied text should come back on paste').toContain('Copy Paste Test');

        const html = await debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyHtml());
        expect(html, 'pasted text should keep its WC3 colour').toMatch(/color:\s*#ffcc00/i);
    });

    test('cut empties the box and paste restores it', async ({ objmodFrame }) => {
        const { frame, session } = objmodFrame;
        session.bringToForeground();

        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.selectObject('Z001')),
            (value) => value === true, 'the Z001 fixture object to be selectable',
        );
        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.openFirstTooltipField()),
            (value) => value === true, 'a tooltip field to exist and open',
        );
        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyText()),
            (value) => typeof value === 'string' && value.length > 0, 'the fixture text',
        );

        await debug(frame, () => window.__wurstModelThumbDebug.selectAllInEditableBody());
        await pressInWindow(session, frame, 'Control+x');

        const afterCut = await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyText()),
            (value) => value === '',
            'the body to be emptied by Ctrl+X',
        );
        expect(afterCut).toBe('');

        await debug(frame, () => window.__wurstModelThumbDebug.focusEditableBody());
        await pressInWindow(session, frame, 'Control+v');

        const restored = await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.getEditableBodyText()),
            (value) => typeof value === 'string' && value.length > 0,
            'the cut text to reappear after Ctrl+V',
        );
        expect(restored).toContain('Copy Paste Test');
    });

    test('the floating toolbar anchors to the editable box, not the surrounding row', async ({ objmodFrame }) => {
        const { frame } = objmodFrame;
        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.selectObject('Z001')),
            (value) => value === true, 'the Z001 fixture object to be selectable',
        );
        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.openFirstTooltipField()),
            (value) => value === true, 'a tooltip field to exist and open',
        );

        const toolbar = await debug(frame, () => window.__wurstModelThumbDebug.getFloatToolbarRect());
        const box = await debug(frame, () => window.__wurstModelThumbDebug.getEditableBoxRect());
        expect(toolbar, 'the floating toolbar should exist').toBeTruthy();
        expect(box, 'the editable box should exist').toBeTruthy();

        // A real past regression: the toolbar anchored to the outer row, which also holds the source
        // pill, so it drifted right by however wide that pill happened to be.
        expect(Math.abs(toolbar.right - box.right)).toBeLessThan(40);
    });

    test('the fixture value is what the editor actually loaded', async ({ objmodFrame }) => {
        const { frame } = objmodFrame;
        await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.selectObject('Z001')),
            (value) => value === true, 'the Z001 fixture object to be selectable',
        );
        const rows = await waitFor(
            () => debug(frame, () => window.__wurstModelThumbDebug.detailsRows()),
            (value) => Array.isArray(value) && value.length > 0,
            'field rows for the fixture object',
        );
        expect(rows.map((row) => row.currentValue)).toContain(CLIPBOARD_TEST_VALUE);
    });
});
