'use strict';

import AbstractProvider from './abstractProvider';
import {HoverProvider, Hover, MarkedString, TextDocument, CancellationToken, Position} from 'vscode';

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
                return new Hover(this.fromHtml(doc)); 
            }
        });
	}
    
    private fromHtml(html: string): MarkedString[] {
        html = html.replace(/<pre>/g, "\n[code]");
        html = html.replace(/<\/pre>/g, "\n");
        html = html.replace(/<br \/>/g, "\n");
        let txt = this.plain(html)
        return txt.split(/\n/).map(line => {
            if (line.startsWith("[code]")) {
                return { language: 'wurst', value: line.replace("[code]", "") };
            }
            return line;
        });
    }
    
    private _regExp = /<(\S*?).*?>((.|\r|\n)*?)<\/\1>/;

    /**
     * remove xml-tags from string
     */
    private plain(doc: string): string {

        if (!doc) {
            return doc;
        }

        let newDoc: string;

        while (true) {
            newDoc = doc.replace(this._regExp,(m, g1, g2, g3) => g2);
            if (newDoc === doc) {
                break;
            }
            doc = newDoc;
        }
        newDoc = newDoc.replace(/<(\S*?).*\/>/g,"");
        return newDoc;
    }
}
