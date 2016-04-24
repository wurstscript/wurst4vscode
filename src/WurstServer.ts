'use strict';

import {EventEmitter} from 'events';
import {ChildProcess, exec, spawn, SpawnOptions} from 'child_process';
import {dirname, isAbsolute} from 'path';
import * as fs from 'fs';
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

		let config = vscode.workspace.getConfiguration("wurst")

        // TODO make configurable
        let java = config.get<string>("javaExecutable")
        let wurstJar = config.get<string>("wurstJar")
		return new Promise<void>((resolve, reject) => {
			fs.stat(wurstJar, (err, stats) => {
				console.log(`stats: ${err}, ${stats}`);
				if (err) {
					let msg = `Could not find ${wurstJar}. Please configure 'wurst.wurstJar'.`
					vscode.window.showErrorMessage(msg);
					reject(msg);
					return;
				}
				let spawnOptions: SpawnOptions = {
					detached: false  
				};
				let process = spawn(java, ["-jar", wurstJar, "-languageServer"], spawnOptions)
				this._serverProcess = process;
				
				process.on('error', (err) => {
					let msg = `could not start server with command ${java} -jar ${wurstJar}. Try changing your settings for 'wurst.javaExecutable' or 'wurst.wurstJar'.`;
					console.log(msg)
					vscode.window.showErrorMessage(msg)
					reject(msg);
				})
				
				process.stdout.on('data', (data: string) => {
					this.handleStdout(data.toString());
				});

				process.stderr.on('data', (data) => {
					let msg = `There was a problem with running Wurst: ${data}`
					console.log(`stderr: ${data}`);
					vscode.window.showErrorMessage(msg);
					reject(msg);
				});

				process.on('close', (code) => {
					console.log(`child process exited with code ${code}`);
				});
				
				
				
				
				// TODO actually it is not yet started, should wait for some message?
				console.log(`Server started ${this._serverProcess.pid}!`)
				this._state = ServerState.Started
				
				// send working directory
				this.sendRequest('init', solutionPath);
				
				// fulfil promise
				resolve(undefined);
			});
		});
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
		if (!this.isRunning()) {
			console.log(`Server not running, could not handle ${path}.`);
			return;
		}
		
		const requestPacket: RequestPacket = {
			sequenceNr: ++this._maxSeqNr,
			path: path,
			data: data
		};
		
		return new Promise<any>((resolve, reject) => {
			
			this._activeRequests[requestPacket.sequenceNr] = {
				onSuccess: value => {
					console.log(`onSuccess ${requestPacket.sequenceNr}`);
					resolve(value);
				},
				onError: err => {
					console.log(`onError ${requestPacket.sequenceNr}`);
					reject(err);
				}	
			};
			
			// TODO maybe better to use version with callback?
			this._serverProcess.stdin.write(JSON.stringify(requestPacket) + '\n');
			
		});
	}


	public setDiagnosticsProvider(dp: DiagnosticsProvider) {
		this._diagnosticsProvider = dp;
	}
	
	
	private _stdOutBuffer: string = "";
	handleStdout(text: string) {
		let lines = text.split(/\r?\n/);
		if (lines.length == 0) {
			return;
		}
		lines[0] = this._stdOutBuffer + lines[0];
		let lastLine = lines[lines.length-1]; 
		if (!lastLine.endsWith("\n")) {
			this._stdOutBuffer = lastLine;
			lines.pop();
		} else {
			this._stdOutBuffer = "";
		}
		
		lines.forEach(data =>  {
			if (data.startsWith("{")) {
				console.log(`stdout json: ${data}`);
				let blob = JSON.parse(data);
				if (blob.eventName == "compilationResult") {
					this.handleCompilationResult(blob.data);
				} else if (blob.requestId) {
					let reqId: number = blob.requestId;
					let req = this._activeRequests[reqId];
					delete this._activeRequests[reqId];
					console.log(`responding to request ${reqId}`);
					req.onSuccess(blob.data);
					console.log(`responded to request ${reqId}`);
				}
			} else {
				console.log(`stdout: ${data}`);
			}
		});
	}
	
	handleCompilationResult(data) {
		let path = this._solutionPath + "/" + data.filename
		this._diagnosticsProvider.setError(path, data.errors);
	}
	
	public uriForFilename(filename: string): vscode.Uri {
		if (isAbsolute(filename)) {
			return vscode.Uri.file(filename) 
		}
		return vscode.Uri.file(this._solutionPath + "/" + filename)
	}
	
	public getPosition(line: number, column: number): vscode.Position {
		return new vscode.Position(Math.max(0, line-1), Math.max(0, column-1));
	}
    
}