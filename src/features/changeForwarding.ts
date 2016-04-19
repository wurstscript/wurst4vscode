
'use strict';

import {Disposable, Uri, workspace, TextDocumentChangeEvent} from 'vscode';
import {WurstServer} from '../WurstServer';

function forwardDocumentChanges(server: WurstServer): Disposable {

	return workspace.onDidChangeTextDocument((event: TextDocumentChangeEvent) => {

		let {document} = event;
		if (document.isUntitled || document.languageId !== 'wurst') {
			return;
		}

		if (!server.isRunning()) {
			return;
		}

		server.updateBuffer(document.fileName, document.getText()).catch(err => {
			console.error(err);
			return err;
		});
	});
}

function forwardFileChanges(server: WurstServer): Disposable {

	function onFileSystemEvent(uri: Uri): void {
        console.log(`onFileSystemEvent ${uri}`)
		if (!server.isRunning()) {
            console.log(`server not running`)
			return;
		}
        
		let req = { Filename: uri.fsPath };
        
        server.filesChanged(uri.fsPath).catch(err => {
			console.warn(`[o] failed to forward file change event for ${uri.fsPath}`, err);
			return err;
		});
	}

	const watcher = workspace.createFileSystemWatcher('**/*.*');
	let d1 = watcher.onDidCreate(onFileSystemEvent);
	let d2 = watcher.onDidChange(onFileSystemEvent);
	let d3 = watcher.onDidDelete(onFileSystemEvent);
    console.log("setup file logging")
	return Disposable.from(watcher, d1, d2, d3);
}

export default function forwardChanges(server: WurstServer): Disposable {

	// combine file watching and text document watching
	return Disposable.from(
		forwardDocumentChanges(server),
		forwardFileChanges(server));
}
