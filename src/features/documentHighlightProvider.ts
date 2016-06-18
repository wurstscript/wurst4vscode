'use strict';

import AbstractSupport from './abstractProvider';
import {WurstServer} from '../WurstServer';
import {convertRange} from './positionHelper';
import {DocumentHighlightProvider, DocumentHighlight, DocumentHighlightKind, CancellationToken, TextDocument, Position, Range} from 'vscode';

export default class WurstDocumentHighlightProvider extends AbstractSupport implements DocumentHighlightProvider {

	public provideDocumentHighlights(document: TextDocument, position: Position, token: CancellationToken): Promise<DocumentHighlight[]> {
		let fut = this._server.sendRequest('getUsagesForFile', {
            filename: document.fileName,
            buffer: document.getText(),
            line: position.line + 1,
            column: position.character + 1,
            global: false
        });
        return fut.then(response => {
			if (response && Array.isArray(response)) {
				let map = response.map(WurstDocumentHighlightProvider._asDocumentHighlight);
				return map;
			}
			return {};
        });
	}

	private static _asDocumentHighlight(getUsages: any): DocumentHighlight {
		return new DocumentHighlight(convertRange(getUsages.range), DocumentHighlightKind.Read);
	}


}