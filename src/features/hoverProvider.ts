'use strict';

import AbstractProvider from './abstractProvider';
import {HoverProvider, Hover, TextDocument, CancellationToken, Position} from 'vscode';

export default class WurstHoverProvider extends AbstractProvider implements HoverProvider {

	public provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover> {

		let fut = this._server.sendRequest('hoverInfo', {
            filename: document.fileName,
            buffer: document.getText(),
            line: position.line+1,
            column: position.character+1
        });
        return fut.then(value => {
            if (value) {
                let contents = [value.documentation]
                return new Hover(contents); 
            }
        });
	}
}
