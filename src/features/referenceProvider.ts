'use strict';

import AbstractSupport from './abstractProvider';
import {WurstServer} from '../WurstServer';
import {convertRange} from './positionHelper';
import {ReferenceProvider, Location, DocumentHighlight, DocumentHighlightKind, CancellationToken, TextDocument, Position, Range} from 'vscode';

export default class WurstReferenceProvider extends AbstractSupport implements ReferenceProvider {

	public provideReferences(document: TextDocument, position: Position, options: { includeDeclaration: boolean;}, token: CancellationToken): Promise<Location[]> {
		let server = this._server
        let fut = this._server.sendRequest('getUsagesForFile', {
            filename: document.fileName,
            buffer: document.getText(),
            line: position.line + 1,
            column: position.character + 1,
            global: true
        });
        return fut.then(response => {
			if (response && Array.isArray(response)) {
				let map = response.map(u => WurstReferenceProvider.asLocation(server, u));
				return map;
			}
			return {};
        });
	}

	private static asLocation(server: WurstServer, usage: any): Location {
        let url = server.uriForFilename(usage.filename)
        return new Location(url, convertRange(usage.range));
	}

}