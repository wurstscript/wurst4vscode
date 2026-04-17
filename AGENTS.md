# AGENTS Guide for `wurst4vscode`

## Project context
- This repository contains the Visual Studio Code extension for WurstScript.
- WurstScript is an all-in-one Warcraft III modding toolkit and language ecosystem (compiler, stdlib, package manager, and related tools).
- The extension is the client-side glue to the Wurst language server and exposes editor features and user commands.

## Sibling repositories (all under the same parent directory, under the user's control)
- `../casc-ts` — CASC archive reader library; consumed via a local `node_modules` symlink. Edit the source there and rebuild (`npm run build` in that dir) when fixing extraction issues.
- `../war3-model` — WC3 model (MDX/MDL) parser and renderer; used by the model preview feature.

## Architecture at a glance
- `src/extension.ts`: minimal `activate()` entry point — wires up features and starts the language client.
- `src/paths.ts`: all `~/.wurst` path constants and GitHub API URLs.
- `src/languageServer.ts`: language client lifecycle (`startLanguageClient`, `stopLanguageServerIfRunning`, file watcher).
- `src/install/installer.ts`: install/update orchestration (checks layout, downloads nightly, runs grill).
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

Rule: Before adding new image/model decode logic, check `imageDecoders.ts`.
Before adding new CASC extraction logic, check `cascStorage.ts`.
Do not duplicate decoders across features.

## Validation checklist
- Compile TypeScript (`npx tsc -p . --noEmit`) after command or API wiring changes.
- Ensure command appears in Command Palette via `contributes.commands`.
- Ensure command can activate extension when run from a cold start (`activationEvents`).
