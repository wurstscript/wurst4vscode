# AGENTS Guide for `wurst4vscode`

## Project context
- This repository contains the Visual Studio Code extension for WurstScript.
- WurstScript is an all-in-one Warcraft III modding toolkit and language ecosystem (compiler, stdlib, package manager, and related tools).
- The extension is the client-side glue to the Wurst language server and exposes editor features and user commands.

## Architecture at a glance
- `src/extension.ts`: extension activation, runtime/bootstrap logic, and language client startup.
- `src/features/commands.ts`: command registration and forwarding to language-server execute-command requests.
- `package.json`: VS Code contributions (commands, activation events, menus, keybindings, configuration).
- `src/features/*`: focused feature modules (file creation, preview features, custom editor support).

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

## Asset/Preview handling
- Prefer centralized asset decoding and preview handling over adding parallel per-feature decoder paths.
- Before adding new image/model decode logic, check whether `src/features/blpPreview.ts` or the existing webview preview pipeline already handles the format correctly.
- If inline previews, hovers, or links need the same asset behavior, reuse or factor shared helpers instead of introducing a second implementation.

## Validation checklist
- Compile TypeScript (`npx tsc -p . --noEmit`) after command or API wiring changes.
- Ensure command appears in Command Palette via `contributes.commands`.
- Ensure command can activate extension when run from a cold start (`activationEvents`).
