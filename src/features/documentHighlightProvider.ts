'use strict';

import AbstractSupport from './abstractProvider';
import {WurstServer} from '../WurstServer';
import {DocumentHighlightProvider, DocumentHighlight, DocumentHighlightKind, CancellationToken, TextDocument, Position, Range} from 'vscode';

export default class WurstDocumentHighlightProvider extends AbstractSupport implements DocumentHighlightProvider {

	public provideDocumentHighlights(document: TextDocument, position: Position, token: CancellationToken): Promise<DocumentHighlight[]> {
		let fut = this._server.sendRequest('getUsagesForFile', {
            filename: document.fileName,
            buffer: document.getText(),
            line: position.line + 1,
            column: position.character + 1
        });
        return fut.then(response => {
			if (response && Array.isArray(response)) {
				let map = response.map(WurstDocumentHighlightProvider._asDocumentHighlight);
				console.log("Returning Map" + map)
				return map;
			}
			console.log("Returning empty");
			return {};
        });
	}

	private static _asDocumentHighlight(getUsages: any): DocumentHighlight {
		return new DocumentHighlight(WurstDocumentHighlightProvider.convertRange(getUsages.range), DocumentHighlightKind.Read);
	}

	private static convertRange(r): Range {
        let range = new Range(WurstDocumentHighlightProvider.convertPos(r.start), WurstDocumentHighlightProvider.convertPos(r.end));
        console.log(`converted ${r} to ${range}...`)
        return range;
    }

	private static convertPos(p): Position {
        return new Position(p.line, p.column);
    }
}