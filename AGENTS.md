# AGENTS Guide for `wurst4vscode`

## Project context
- This repository contains the Visual Studio Code extension for WurstScript.
- WurstScript is an all-in-one Warcraft III modding toolkit and language ecosystem (compiler, stdlib, package manager, and related tools).
- The extension is the client-side glue to the Wurst language server and exposes editor features and user commands.

## Sibling repositories (all under the same parent directory, under the user's control)
- `../casc-ts` — CASC archive reader library; consumed via a local `node_modules` symlink. Edit the source there and rebuild (`npm run build` in that dir) when fixing extraction issues.
- `../war3-model` — WC3 model (MDX/MDL) parser and renderer; used by the model preview feature.

## Architecture at a glance
- `src/extension.ts`: minimal `activate()` entry point — wires up features and starts the language client. Activation must never await the language server: every feature (custom editors, decorations, commands) registers up front and `startLanguageClientWhenWorkspaceIsOpen` runs detached. Server-backed commands go through `getLanguageClient()` in `languageServer.ts`, which resolves once the JVM is up and rejects if it failed, so they exist in the palette from the first frame.
- `src/paths.ts`: all `~/.wurst` path constants and GitHub API URLs.
- `src/languageServer.ts`: language client lifecycle (`startLanguageClient`, `stopLanguageServerIfRunning`, file watcher).
- `src/install/installer.ts`: install/update orchestration (checks layout, downloads nightly, runs grill). The installed compiler version is detected with `java -jar wurstscript.jar -version` at most once per installed jar and then read from `~/.wurst/wurst-compiler/installed-version.json` — never start a second JVM at startup for it.
- `src/install/downloader.ts`: GitHub API helpers, file download with progress, zip extraction.
- `src/install/fsUtils.ts`: pure filesystem helpers (retry, copy, migrate legacy layout, cleanup).
- `src/install/pathManager.ts`: PATH management for terminals and shell profiles.
- `src/features/commands.ts`: command registration and forwarding to language-server execute-command requests.
- `src/features/newProject.ts`: `wurst.newProject` command — interactive project scaffold via grill.
- `src/features/compileTimeDecorator.ts`: gutter icon decorator for `@compiletime` functions.
- `src/features/*`: focused feature modules (file creation, preview features, custom editor support).
- `package.json`: VS Code contributions (commands, activation events, menus, keybindings, configuration).

## Command integration rules
- Add user-facing command IDs to `package.json`:
  - `contributes.commands`
  - `activationEvents` when command-driven activation is needed
- Register command handlers in `src/features/commands.ts` via `vscode.commands.registerCommand`.
- For language server actions, forward through `ExecuteCommandRequest` with the exact server command name (for example `wurst.fix_all_quickfixes`).
- Keep VS Code command IDs and language-server command IDs distinct when needed:
  - VS Code command: namespaced for UX/discoverability.
  - LSP execute-command: must match the server contract exactly.

## Coding conventions used in this repo
- Keep changes minimal and localized.
- Reuse existing helper patterns in `commands.ts` instead of introducing new abstractions unless needed.
- Prefer clear command names and explicit request objects.
- Avoid introducing unrelated formatting churn in JSON/TS files.
- Keep `extension.ts` minimal — it is the entry point only. New features belong in `src/features/` or the appropriate module under `src/install/`.
- Do not add new top-level files to `src/` for logic that belongs in an existing module. Follow the existing split: paths → `paths.ts`, install logic → `src/install/`, LS lifecycle → `languageServer.ts`, editor features → `src/features/`.
- Do not create utility files, helper files, or abstractions for one-off operations. Three similar lines of code is better than a premature abstraction.

## Asset/Preview handling

Preview features are split across focused modules — pick the slice you need:

- **src/features/preview/imageDecoders.ts** — pure binary decoders (BLP, DDS, TGA → RGBA). No VS Code imports, no CASC.
  To add a new raster format: add a `decodeXxx()` function and a branch in `decodeRasterPreview()`.

- **src/features/preview/cascStorage.ts** — CASC singleton and WC3 game-file extraction.
  Touch for: new WC3 install paths, CASC API changes, disk-cache invalidation.

- **src/features/preview/mdxDecode.ts** — MDX/MDL binary model parser (existing, unchanged).

- **src/features/blpPreview.ts** — VS Code custom editor provider + webview HTML for BLP/DDS/TGA/MDX.
  Touch for: UI changes, preview toolbar controls, message protocol between host and webview.

- **src/features/imageAssetSupport.ts** — shared Node-side image utilities (PNG encode, scale, preview cache).

- **src/features/webviewUtils.ts** — `makeNonce()` + `escapeHtml()` only. Shared by all webview builders.

- **src/features/webviewShared.ts** — shared CSS (VS Code theme token mapping, `.wv-header`, `.wv-toolbar`, `.wv-btn`, `.wv-sep`, `.wv-scroll`, spinner overlay), plus `buildPage()`, `sep()`, `spinnerOverlay()` helpers. All webview panels use this as their CSS/HTML base.
  Touch for: cross-viewer style changes, new shared components, VS Code theme token additions.
  Do NOT put viewer-specific CSS here — pass it via `buildPage({ extraCss })` instead.

Rule: Before adding new image/model decode logic, check `imageDecoders.ts`.
Before adding new CASC extraction logic, check `cascStorage.ts`.
Before adding new webview CSS that should be consistent across viewers, add it to `webviewShared.ts`.
Do not duplicate decoders across features.

## WC3 binary/data preview notes

- **src/features/preview/framework.ts** holds both editor bases: `registerParsedPreviewer` for read-only viewers (supports optional webview message handling via `onMessage`; use it for lazy webview data instead of eagerly serializing large parsed structures) and `EditableBinaryEditorProvider` / `EditableBinaryDocument` for editable formats (see "Editable binary formats").
- **src/features/objModPreview.ts** is the Object Editor-style preview for `.w3u/.w3t/.w3a/.w3b/.w3d/.w3h/.w3q`.
  Keep it lazy: send object summaries first, then load field rows for the selected object on demand. `.w3a` files can contain hundreds of objects and become slow if every base-field row is serialized up front.
  - **Layout/density:** the browse list stays *beside* the details pane down to `NARROW_LAYOUT_PX` (objModEditorWebview.ts); the stacked `.object-editor.narrow` fallback below that is a last resort, driven only by the ResizeObserver on the editor element — do not reintroduce a parallel `@media (max-width:…)` copy of those rules.
  - Spacing is a two-scale system: compact defaults in `:root` and a `body.density-cozy` override block, toggled by `#density-toggle` and persisted as `ui.density`. Put any new spacing number in that variable pair rather than hard-coding it, so both scales stay consistent.
  - Field-table column widths must be stated on the `<th>` via `.col-*` classes (`table-layout: fixed` ignores cell min-widths), and must be flat percentages or px — a fixed-layout column silently drops a width containing `min()`/`clamp()` with a percentage inside.
- Object editor labels and base values come from WC3 game data in CASC. Metadata paths include `Units\UnitMetaData.slk`, `Units\AbilityMetaData.slk`, `Units\AbilityBuffMetaData.slk`, `Doodads\DoodadMetaData.slk`, and profile/string files under `Units\*.txt`.
- Reforged object button art often lives in skin TXT files, not the older func files: `Units\UnitSkin.txt`, `Units\ItemSkin.txt`, `Units\AbilitySkin.txt`, `Units\DestructableSkin.txt`, `Doodads\DoodadSkins.txt`, and sometimes `Units\UpgradeSkin.txt`.
  These files may start with a UTF-8 BOM; strip it before parsing section headers.
- WESTRING labels are resolved from localized CASC files such as `war3.w3mod:_locales\enus.w3mod:UI\WorldEditStrings.txt` and `WorldEditGameStrings.txt`. If labels show raw `WESTRING_*`, check locale path candidates in `cascStorage.ts`.
- `TRIGSTR_###` values are map-local string references; resolve them through `war3map.wts` via `src/features/preview/triggerStrings.ts`, but still show the source reference where useful.
- For icons/thumbnails in webviews, reuse `imageAssetSupport.ensurePreview`, `getCandidateRoots`, and CASC texture extraction (`ensureGameTextureCached`) instead of adding another decoder/cache path.

### Shared reference-resolution + icon infra (use across all viewers, do not duplicate)
- **src/features/preview/wc3Data.ts** — generic CASC game-data loaders/parsers: `readGameData`, `parseSlk`, `parseProfile`, `loadProfilePaths`, `loadWorldEditStrings`, `resolveWorldEditString`, plus the per-kind profile/skin path lists. Add new game-data loading here, not in a viewer.
- **src/features/preview/objectCatalog.ts** — `getObjectCatalog()` → `Map<rawcode, { name, iconPath, modelPath }>` built from profiles/skins + world strings. Use it to turn raw 4-char object ids into named, icon-decorated references in any viewer (doo, trigger, map data).
- **Lazy inline icons:** host side `imageAssetSupport.requestPreviewIcon(iconPath, key, webview, uri)` + client side `ICON_LAZYLOAD_SCRIPT` / `ICON_INLINE_CSS` / `PREVIEW_ICON_CSP` from `webviewShared.ts`. Markup contract: `<span class="object-icon" data-key data-icon></span>`. Wire `onMessage` → `requestPreviewIcon`. Validate any new inline `<script>` string with `vm.Script`.
- **Extension-agnostic asset resolution:** WC3 looks up assets by name, ignoring the requested extension. Use `imageAssetSupport.resolveAssetPathWithCasc(assetPath, roots)` (built on `assetPathVariants`) which probes `.mdx`/`.mdl` for models and `.blp`/`.dds`/`.tga` for textures across local roots (map folder, `imports/`, workspace) first, then the extracted game cache, then CASC/MPQ. Local-first is WC3's own precedence (map files override game data) and keeps purely local imports from paying for a CASC probe. Don't resolve a single fixed extension.
- **Game-data detection is async and cached once:** `cascStorage.getGameDataRoot()` returns a shared promise (registry queries, drive probing and directory walks all run asynchronously). Never add synchronous `existsSync`/`execFileSync` probing on the game-data path — it runs on the extension host while the language client is booting. `wurst.wc3path` changes reset it via `registerGameDataSettingsWatcher`. Basename fallbacks (`findPathByBasenameAsync`) are index lookups in both casc-ts and the MPQ storage; keep them O(1).
- **Inline model preview:** to embed a 3D model render in a webview (not a separate window), load `dist/webview/mdxViewer.js` via `webview.asWebviewUri` (requires `extensionUri` on the provider, `dist/webview` in `localResourceRoots`, and `script-src 'unsafe-inline' ${webview.cspSource}` — do NOT add a nonce, it would disable `'unsafe-inline'` for inline scripts). Host side: `preview/modelPreviewHost.ts` `postModelToWebview` / `postTexturesToWebview`; the viewer posts `requestTextures` back. The objmod editor's `#mpv-box` is the reference implementation.
- **Thumbnail tracing is opt-in:** `[wurst-model-thumb]` console lines and `~/.wurst/model_thumbs/thumbnail-diagnostics.jsonl` are only written with `WURST_MODEL_THUMB_DEBUG=1` (or the e2e cache switch below). Do not add always-on per-thumbnail logging or disk writes.
- **Objmod asset-browser model thumbnails:** visible model cards should enter a pending/spinner state immediately and stay there until the thumbnail is either loaded or decisively marked missing (`?`). Generation must drain visible thumbnails in DOM order, one complete thumbnail lifecycle at a time: host resolve -> warm webview renderer -> cache/write or missing decision -> next item. Do not pre-resolve/render later visible models in parallel, and do not add fixed inter-thumbnail idle delays after a thumbnail has finished. Cancel queued work only when a thumbnail scrolls out of view before it starts; when it returns, re-observe/requeue it. The grid thumbnail budget is intentionally strict: models above the host-side size cutoff (`WURST_MODEL_THUMB_MAX_MODEL_BYTES`, default 160 KB) should become `?` quickly rather than burning CPU; the full model preview can still be opened separately. Use `WURST_MODEL_THUMB_DISABLE_CACHE=1` for local validation so tests measure actual generation rather than cached webps.
- **Local-only thumbnail validation:** use `npm run test:e2e:objmod-thumbs:local` with `WURST_OBJMOD_E2E=1` to launch VS Code against the checked-in `e2e/war3map.w3u` fixture, open the objmod asset browser, disable thumbnail cache, and assert visible FIFO order plus per-thumbnail timing (default max 200ms). Override `WURST_OBJMOD_E2E_PROJECT` and `WURST_OBJMOD_E2E_FILE` for a real map/project. This is intentionally not a CI test because it depends on local WC3 data and VS Code/Electron.

## Testing tiers

Three tiers, cheapest first. Put a test in the cheapest tier that can actually catch the regression.

1. **`npm test`** — fast Node harnesses in `scripts/` (fuzzy matching, image decoders, diagnostics, `test-webview.js`). `test-webview.js` transpiles real TS modules and runs them against a tiny DOM shim; it also holds structural guards that read sources as text. Use it for pure logic. It cannot judge layout, CSS, or the host↔webview protocol — don't add `assert.ok(source.includes(...))` guards for behaviour the Playwright tier can assert directly.

2. **`npm run test:e2e`** (Playwright, `e2e/specs/`) — the **real** webview bundles in real Chromium against the **real** host code, with only `vscode` itself faked. No VS Code launch and no Warcraft III install needed, so any developer can run it. Covers the objmod editor (browse/search/fields/tooltip editor/layout) and the editable `.w3i` and `.wpm` editors, including edit → undo/redo → save → bytes-on-disk round-trips.
   - **Not part of the `build.yml` CI job**, which substitutes `.ci/mocks/casc-ts` for the private sibling package; every parser in that mock throws, and these tests parse and re-serialize real binary fixtures. Running them in CI would need the mock to gain real `parseObjMod`/`serializeObjMod`/`parseW3i`/`serializeW3i`/`parseWpm`/`serializeWpm` implementations, or a job with access to the real siblings.
   - `e2e/harness/tsLoader.js` loads real TS sources with mocks. It reports `__dirname` as `<root>/dist` for anything under `src/`, matching what webpack produces — that is what makes `resources/wc3-knowledge-base.json` resolve, so field rows exist without a compiler or WC3 install.
   - `e2e/harness/objmodHost.js` / `mapEditorHosts.js` instantiate the **actual** `CustomEditorProvider` and mount it on a fake panel (`customEditorHost.js`), so `openCustomDocument` → `resolveCustomEditor` → message handler → edit stack → `saveCustomDocument` are the shipping paths.
   - The page is served over http and `webview.cspSource` points at that origin, so the shipped CSP has to genuinely admit what the page loads — a CSP regression fails the suite.
   - Assert on field **ids** and values from the fixture file, never on game-data labels: labels resolve through WorldEditStrings in CASC and differ between a machine with WC3 installed and CI.
   - Run `npm run compile-web` first (the `test:e2e` script does); the fixture fails loudly if `dist/webview/` is missing.

3. **`npm run test:e2e:local`** (Playwright, `e2e/local/`, opt-in) — a real VS Code window driven over CDP, plus the MDX render benchmark. Gated on `WURST_OBJMOD_E2E=1` / `WURST_MODEL_E2E=1`; each spec calls `skipUnlessEnabled()` at top level (a `beforeEach` in the shared fixtures module would only attach to whichever spec imported it first). Reserve this tier for what genuinely needs the real shell: thumbnail scheduling against real game data, the CodeLens-launched asset browser, and clipboard behaviour, which needs OS-trusted keystrokes and the VS Code window in the foreground.
   - `e2e/harness/vscodeLauncher.js` pins `workbench.editorAssociations` in the temp profile. Without it a `.w3u`/`.w3a` passed on the command line opens in the *text* editor on a cold `--extensionDevelopmentPath` start, because the extension host has not registered its custom editors yet — and no webview is ever created.

### Editable binary formats
- `.imp` remains intentionally read-only: it is World Editor import-manager bookkeeping, not a useful standalone editing target for normal Wurst workflows.
- **.w3i is an editable custom editor** (`wurst.w3iEditor`, in `mapDataPreview.ts`) backed by `casc-ts` `parseW3i`/`serializeW3i`, which use a **parse-prefix + opaque-tail** model: only leading string/scalar fields are editable; players/forces/lists are preserved verbatim in `file.tail` (and parsed best-effort for display only). Every save passes a round-trip safety gate (`serializeValidatedW3i`). TRIGSTR-backed strings edit `war3map.wts`; inline strings edit the w3i bytes. The other map-data formats remain read-only under `wurst.mapDataPreview` (the old read-only `renderW3i`/`parseW3i` in that file are retained but no longer routed to).
- **`.wpm` and `.w3c` are the reference implementations of the shared editable base.** `EditableBinaryEditorProvider<TFile, TDoc>` in `preview/framework.ts` owns the whole `CustomEditorProvider` lifecycle once: revision-based dirty tracking, `pushEdit` → VS Code undo/redo, save (byte-equal skip), save-as, revert, hot-exit backup, and the parse-error page. A format subclasses it and supplies `parse`, a `serialize` that contains its round-trip safety gate, `createDocument` (subclass `EditableBinaryDocument` for sidecar state such as `wtsEdits`), `render`, `handleMessage` (translate webview messages into `provider.pushEdit` calls) and `postState` (push model/dirty state to the webview); `onSave`/`onRevert` cover sidecars like `war3map.wts`. See `WpmEditorProvider` and `W3cEditorProvider`.
- `.w3r`, `.mmp` and `.w3i` are on the same base. Formats whose strings live in `war3map.wts` extend `TriggerStringBackedDocument` and spread `wtsSidecar` into the provider options (`mapDataPreview.ts`); `pushEdit(..., { onApply, onUndoRedo })` re-renders the page for edits the incremental `postState` cannot express (the `.w3i` flag word). The object editor is the one remaining hand-rolled `CustomEditorProvider`.
- When adding a new editable binary format, mirror this: a casc-ts parser+serializer with a byte-exact round-trip test, a provider built on `EditableBinaryEditorProvider`, and a serialize→re-parse→compare safety gate inside `serialize`.

## Validation checklist
- Compile TypeScript (`npx tsc -p . --noEmit`) after command or API wiring changes.
- Run `npm test` and, for anything touching a webview or an editable format, `npm run test:e2e`.
- Run `npm run lint` (ESLint, with `eslint-plugin-sonarjs`'s recommended rules — see `eslint.config.js`) and fix anything it flags in files you touched before considering a change done. `src/webview/**` is intentionally excluded (bundled browser JS with a different style — see the ignores comment in `eslint.config.js`).
  - A handful of pre-existing findings are deliberately suppressed rather than fixed: `sonarjs/cognitive-complexity` and `sonarjs/no-nested-functions` are silenced per-site with `// eslint-disable-next-line ... -- TODO(lint-cleanup): ...` on functions that need a real decomposition pass, not a rushed one — don't add more of these without good reason, and prefer actually reducing complexity when touching one of these functions anyway. `sonarjs/code-eval`, `no-os-command-from-path`, `file-permissions`, `pseudo-random`, and `hashing` are disabled project-wide in `eslint.config.js` with reasoning for each (they assume an untrusted/internet-facing context this codebase doesn't have).
- Ensure command appears in Command Palette via `contributes.commands`.
- Ensure command can activate extension when run from a cold start (`activationEvents`).
