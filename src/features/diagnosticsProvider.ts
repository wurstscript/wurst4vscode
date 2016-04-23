'use strict';



import {WurstServer} from '../WurstServer';
import {Disposable, Uri, CancellationTokenSource, TextDocument, 
            Diagnostic, DiagnosticCollection, 
            Range, Position,
            DiagnosticSeverity, workspace, languages} from 'vscode';


export class DiagnosticsProvider {
    
    private _diagnostics: DiagnosticCollection;
    
    constructor(server: WurstServer) {
        server.setDiagnosticsProvider(this);
        this._diagnostics = languages.createDiagnosticCollection('wurst');
    }
    
    
    public dispose() {
        this._diagnostics.dispose();
    }
    
    public setError(document: string, errors: any[]) {
        let diagnostics: Diagnostic[] = errors.map((err) => {
            let startLine = Math.max(0, err.startLine-1);
            let startColumn = Math.max(0, err.startColumn-1);
            let endLine = Math.max(0, err.endLine-1);
            let endColumn = Math.max(0, err.endColumn-1);
             return new Diagnostic(
                new Range(
                    new Position(startLine,startColumn), 
                    new Position(endLine,endColumn)),
                err.message,
                this.convertErrorType(err.errorType)
            )
        });
        
        let uri = Uri.file(document);
        console.log(`setError on uri ${uri} ....`);
        this._diagnostics.set(uri, diagnostics);
    }
    
    private convertErrorType(errType: string): DiagnosticSeverity {
        if (errType == "ERROR") {
            return DiagnosticSeverity.Error;
        } else {
            return DiagnosticSeverity.Warning;
        }
    }
    
}