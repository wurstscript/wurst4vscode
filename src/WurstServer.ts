'use strict';

import {EventEmitter} from 'events';
import {ChildProcess, exec, spawn, SpawnOptions} from 'child_process';
import {dirname} from 'path';
import {ReadLine, createInterface} from 'readline';
import {Disposable, CancellationToken, OutputChannel, workspace, window} from 'vscode';
import * as vscode from 'vscode';

enum ServerState {
	Starting,
	Started,
	Stopped
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
    
    constructor() {
        this._channel = window.createOutputChannel("Wurst Log")
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
        
        process.on('error', (err) => {
            console.log("could not start server: " + err)
            vscode.window.showInformationMessage('Could not start server: ' + err);
        })
        
        process.stdout.on('data', (data) => {
            console.log(`stdout: ${data}`);
        });

        process.stderr.on('data', (data) => {
            console.log(`stderr: ${data}`);
        });

        process.on('close', (code) => {
            console.log(`child process exited with code ${code}`);
        });
        
        console.log("Server started...")
        
		return Promise.resolve<void>(undefined);
	}
    
    public stop(): Promise<void> {

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
			return;
		});
	}
    

    
}