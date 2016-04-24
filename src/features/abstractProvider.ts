'use strict';

import {WurstServer} from '../WurstServer';
import {Disposable} from 'vscode';

export default class AbstractProvider {

	protected _server: WurstServer;
	protected _disposables: Disposable[];

	constructor(server: WurstServer) {
		this._server = server;
		this._disposables = [];
	}

	dispose() {
		while (this._disposables.length) {
			this._disposables.pop().dispose();
		}
	}
}
