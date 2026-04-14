'use strict';

import * as vscode from 'vscode';
import { LanguageClient, ExecuteCommandRequest, ExecuteCommandParams } from 'vscode-languageclient/node';

const PROMPT = 'wurst> ';

export function registerRepl(client: LanguageClient): vscode.Disposable {
    let terminal: vscode.Terminal | undefined;

    const cmd = vscode.commands.registerCommand('wurst.repl', () => {
        if (terminal) {
            terminal.show();
            return;
        }
        const pty = new WurstReplPty(client);
        terminal = vscode.window.createTerminal({ name: 'Wurst REPL', pty });
        const onClose = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) {
                terminal = undefined;
                onClose.dispose();
            }
        });
        terminal.show();
    });

    return cmd;
}

class WurstReplPty implements vscode.Pseudoterminal {
    private writeEmitter = new vscode.EventEmitter<string>();
    onDidWrite = this.writeEmitter.event;

    private history: string[] = [];
    private historyIndex = -1;
    private currentInput = '';
    private running = false;

    constructor(private readonly client: LanguageClient) {}

    open(): void {
        this.writeln('\x1b[1;32mWurstScript REPL\x1b[0m');
        this.writeln('Evaluate Wurst expressions using the compiletime interpreter.');
        this.writeln('Requires an open Wurst project. Type :help for hints.\r\n');
        this.write(PROMPT);
    }

    close(): void {}

    handleInput(data: string): void {
        if (this.running) return; // ignore input while executing

        switch (data) {
            case '\r': {
                const input = this.currentInput;
                this.currentInput = '';
                this.historyIndex = -1;
                this.submit(input);
                break;
            }
            case '\x7f': { // Backspace
                if (this.currentInput.length > 0) {
                    this.currentInput = this.currentInput.slice(0, -1);
                    this.write('\b \b');
                }
                break;
            }
            case '\x03': { // Ctrl+C
                this.currentInput = '';
                this.writeln('^C');
                this.write(PROMPT);
                break;
            }
            case '\x1b[A': { // Up arrow
                if (this.historyIndex < this.history.length - 1) {
                    this.historyIndex++;
                    this.setInput(this.history[this.historyIndex]);
                }
                break;
            }
            case '\x1b[B': { // Down arrow
                if (this.historyIndex > 0) {
                    this.historyIndex--;
                    this.setInput(this.history[this.historyIndex]);
                } else if (this.historyIndex === 0) {
                    this.historyIndex = -1;
                    this.setInput('');
                }
                break;
            }
            default: {
                if (data >= ' ') {
                    this.currentInput += data;
                    this.write(data);
                }
                break;
            }
        }
    }

    private setInput(value: string) {
        this.currentInput = value;
        this.write('\r\x1b[K' + PROMPT + value);
    }

    private async submit(input: string) {
        this.writeln('');
        const trimmed = input.trim();

        if (!trimmed) {
            this.write(PROMPT);
            return;
        }

        if (trimmed === ':help') {
            this.writeln('Type any Wurst expression or statement body, e.g.:');
            this.writeln('  print("hello")');
            this.writeln('  let x = 1 + 2  print(x.toString())');
            this.writeln('  :help   – show this message');
            this.writeln('  :clear  – clear terminal');
            this.writeln('Use  ↑ / ↓  to navigate history.');
            this.write(PROMPT);
            return;
        }

        if (trimmed === ':clear') {
            this.write('\x1b[2J\x1b[H');
            this.write(PROMPT);
            return;
        }

        this.history.unshift(trimmed);
        this.running = true;
        this.write('\x1b[2m[running…]\x1b[0m');

        const request: ExecuteCommandParams = {
            command: 'wurst.repl',
            arguments: [{ expression: trimmed }],
        };

        try {
            const raw: any = await this.client.sendRequest(ExecuteCommandRequest.type, request);
            this.write('\r\x1b[K'); // clear [running…]

            // Compiler returns a JSON string: {"output":"..."} or {"error":"...","output":"..."}
            let result: { output?: string; error?: string } = {};
            try {
                result = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
            } catch {
                result = { output: String(raw ?? '') };
            }

            if (result.error) {
                this.writeln(`\x1b[31m${result.error}\x1b[0m`);
            }
            if (result.output) {
                for (const line of result.output.split(/\r?\n/)) {
                    this.writeln(line);
                }
            } else if (!result.error) {
                this.writeln('\x1b[2m(no output)\x1b[0m');
            }
        } catch (e: any) {
            this.write('\r\x1b[K');
            this.writeln(`\x1b[31mError: ${e?.message ?? String(e)}\x1b[0m`);
        } finally {
            this.running = false;
            this.write(PROMPT);
        }
    }

    private write(s: string) { this.writeEmitter.fire(s); }
    private writeln(s: string) { this.write(s + '\r\n'); }
}
