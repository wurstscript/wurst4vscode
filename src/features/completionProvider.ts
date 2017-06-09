'use strict';

import {CompletionItemProvider, TextEdit, CompletionItem, CompletionItemKind, CancellationToken, TextDocument, Range, Position, SnippetString} from 'vscode';
import AbstractProvider from './abstractProvider';
import {WurstServer} from '../WurstServer';
import * as vscode from 'vscode';
import {fromHtml, htmlToString} from './htmlFilter';
import {convertRange} from './positionHelper';

export default class WurstCompletionItemProvider extends AbstractProvider implements CompletionItemProvider {

	public provideCompletionItems(document: TextDocument, position: Position, token: CancellationToken): Promise<CompletionItem[]> {
        let fut = this._server.sendRequest('getCompletions', {
            filename: document.fileName,
            buffer: document.getText(),
            line: position.line+1,
            column: position.character+1
        });
        return fut.then(response => {
           console.log(`got ${response.length} responses!`)
           let i = 1;
           return response.map(completion => {
               console.log(`completion ${i++}`)
               let item = new CompletionItem(completion.label);
               item.kind = CompletionItemKind[<string>completion.kind]; // TODO
               
               item.detail = htmlToString(completion.detail);
               item.documentation = htmlToString(completion.documentation);
               item.sortText = (10.-completion.rating).toFixed(5) + completion.label
               //item.textEdit = this.convertTextEdit(completion.textEdit)
               item.insertText = completion.textEdit.newText;
               console.log(`completion ${item.label}!`);
               let params = completion.parameters;
               if (params && params.length > 0) {
                   // create template for arguments
                   // text inside {{ }} is like a placeholder for the snippet
                   // and users can switch between the positions using tab
                   let paramSnippets = [];
                   for (let i in params) {
                       let param = params[i];
                       paramSnippets.push('${' + (i+1) + ":" + param.name + '}')
                   }
                   item.insertText = new SnippetString(item.insertText + '(' + paramSnippets.join(', ') + ')');
               }
               /*
               let range = item.textEdit.range; 
               if (range.start.line != range.end.line) {
                    console.log(`invalid text edit ERROR 1`);
               }
               if (range.start.character > range.end.character) {
                    console.log(`invalid text edit ERROR 2`);
               }
               */
               // TODO
               return item;
           })
        });
                

    }
    
    private convertTextEdit(te): TextEdit {
        return TextEdit.replace(convertRange(te.range), te.newText);
    }
    

}