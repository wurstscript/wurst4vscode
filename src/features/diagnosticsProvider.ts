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
             return new Diagnostic(
                new Range(
                    new Position(err.startLine-1,err.startColumn-1), 
                    new Position(err.endLine-1,err.endColumn-1)),
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