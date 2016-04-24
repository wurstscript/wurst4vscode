'use strict';

import AbstractProvider from './abstractProvider';
import {WurstServer} from '../WurstServer';
import {TextDocument, Position, Location, CancellationToken, DefinitionProvider,
    Uri} from 'vscode';
import * as vscode from 'vscode';

export default class WurstDefinitionProvider extends AbstractProvider implements DefinitionProvider {


	public provideDefinition(document: TextDocument, position: Position, token: CancellationToken): Promise<Location> {

        let fut = this._server.sendRequest('provideDefinition', {
            filename: document.fileName,
            buffer: document.getText(),
            line: position.line+1,
            column: position.character+1
        });
        return fut.then(response => {
           let uri = this._server.uriForFilename(response.filename);
           let pos = this._server.getPosition(response.line, response.column);
           console.log(`definition got response ${uri}, pos ${pos}!`);
           return new Location(uri, pos); 
        });
	}
}
