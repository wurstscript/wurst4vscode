'use strict';

import AbstractProvider from './abstractProvider';
import {HoverProvider, Hover, MarkedString, TextDocument, CancellationToken, Position} from 'vscode';
import {fromHtml} from './htmlFilter';


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
                let doc: string = value.documentation;
                console.log(`description = ${doc}`);
                return new Hover(fromHtml(doc)); 
            }
        });
	}
    
    
}
