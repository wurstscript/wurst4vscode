'use strict';

import {EventEmitter} from 'events';
import {ChildProcess, exec, spawn, SpawnOptions} from 'child_process';
import {dirname} from 'path';
import {ReadLine, createInterface} from 'readline';
import {Disposable, CancellationToken, OutputChannel, workspace, window} from 'vscode';
import * as vscode from 'vscode';
import {DiagnosticsProvider} from './features/diagnosticsProvider'

enum ServerState {
	Starting,
	Started,
	Stopped
}


interface RequestPacket {
	sequenceNr: number;
	path: string;
	data: any;
}

interface ResponsePacket {
	sequenceNr: number;
	response: any;
}


export class WurstServer {
    
    private _state: ServerState = ServerState.Stopped;
    
    // ???
    private _channel: OutputChannel;
    
    // the Process running Wurst (the .jar)
    protected _serverProcess: ChildProcess;
    
    //???
    private _start: Promise<void>;
    
    // the file path of the solution
    private _solutionPath: string;
    
	
	// the maximum sequence number sent to the server
	private _maxSeqNr: number = 0;
	
	private _activeRequests: { [seq: number]: { onSuccess: Function; onError: Function; } } = {};
	
	private _diagnosticsProvider: DiagnosticsProvider;
	
    constructor() {
        this._channel = window.createOutputChannel("Wurst Log")
    }
    
	public isRunning() {
		return this._state == ServerState.Started;
	}
	
    public start(solutionPath: string): Promise<void> {
		if (!this._start) {
			this._start = this._doStart(solutionPath);
		}
		return this._start;
	}

	private _doStart(solutionPath: string): Promise<void> {

		this._state = ServerState.Starting;
		this._solutionPath = solutionPath;


        // TODO make configurable
        let java = "java"
        let wurstJar = "/home/peter/work/WurstScript/Wurstpack/wurstscript/wurstscript.jar"
         
        let spawnOptions: SpawnOptions = {
          detached: false  
        };
        let process = spawn(java, ["-jar", wurstJar, "-languageServer"], spawnOptions)
        this._serverProcess = process;
		
        process.on('error', (err) => {
            console.log("could not start server: " + err)
            vscode.window.showInformationMessage('Could not start server: ' + err);
        })
        
        process.stdout.on('data', (data: string) => {
            console.log(`stdout: ${data}`);
			this.handleStdout(data.toString());
        });

        process.stderr.on('data', (data) => {
            console.log(`stderr: ${data}`);
        });

        process.on('close', (code) => {
            console.log(`child process exited with code ${code}`);
        });
        
		// send working directory
		this.sendRequest('init', solutionPath);
		
		
		// TODO actually it is not yet started, should wait for some message?
        console.log(`Server started ${this._serverProcess.pid}!`)
        this._state = ServerState.Started
		
		
		
		return Promise.resolve<void>(undefined);
	}
    
    public stop(): Promise<void> {
		console.log(`Stopping server ${this._serverProcess.pid} ...`)

		let ret: Promise<void>;

		if (!this._serverProcess) {
			// nothing to kill
			ret = Promise.resolve<void>(undefined);

		}
        else if (process.platform === 'win32') {
			// when killing a process in windows its child
			// processes are *not* killed but become root
			// processes. Therefore we use TASKKILL.EXE
			ret = new Promise<void>((resolve, reject) => {
				const killer = exec(`taskkill /F /T /PID ${this._serverProcess.pid}`, function (err, stdout, stderr) {
					if (err) {
						return reject(err);
					}
				});
                
				killer.on('exit', resolve);
				killer.on('error', reject);
			});
		}
        else {
			this._serverProcess.kill('SIGTERM');
			ret = Promise.resolve<void>(undefined);
		}
        
		return ret.then(_ => {
			this._start = null;
			this._serverProcess = null;
            this._state = ServerState.Stopped;
			console.log("Stopped Server.")
			return;
		});
	}
    
	public updateBuffer(fileName: string, documentContent: string): Promise<void> {
		// TODO
		console.log(`updating buffer for ${fileName}`)
		
		this.sendRequest('reconcile', {filename: fileName, content: documentContent});
		
		
		return Promise.resolve(undefined);
	}
	
	public filesChanged(fileName: string): Promise<void> {
		// TODO
		console.log(`filesChanged: ${fileName}`)
		
		this.sendRequest('fileChanged', fileName);
		
		//this._diagnosticsProvider.setError(fileName, []);
		
		return Promise.resolve(undefined);
	}
	
	
	
	public sendRequest(path: string, data: any): Promise<any> {
		
		const requestPacket: RequestPacket = {
			sequenceNr: ++this._maxSeqNr,
			path: path,
			data: data
		};
		
		return new Promise<any>((resolve, reject) => {
			
			this._activeRequests[requestPacket.sequenceNr] = {
				onSuccess: value => resolve(value),
				onError: err => reject(err)	
			};
			
			// TODO maybe better to use version with callback?
			this._serverProcess.stdin.write(JSON.stringify(requestPacket) + '\n');
			
		});
	}


	public setDiagnosticsProvider(dp: DiagnosticsProvider) {
		this._diagnosticsProvider = dp;
	}
	
	handleStdout(text: string) {
		var lines = text.split(/\r?\n/);
		lines.forEach(data =>  {
			if (data.startsWith("{")) {
				let blob = JSON.parse(data);
				if (blob.eventName == "compilationResult") {
					this.handleCompilationResult(blob.data);
				}
			}
		});
	}
	
	handleCompilationResult(data) {
		let path = this._solutionPath + "/" + data.filename
		this._diagnosticsProvider.setError(path, data.errors);
	}
    
}