'use strict';

import {EventEmitter} from 'events';
import {ChildProcess, exec, spawn, SpawnOptions} from 'child_process';
import {dirname, isAbsolute} from 'path';
import * as fs from 'fs';
import {ReadLine, createInterface} from 'readline';
import {Disposable, CancellationToken, OutputChannel, workspace, window, StatusBarItem, StatusBarAlignment} from 'vscode';
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

	private static _lastMapConfig: string;

	private _statusBarItems: Set<StatusBarItem> = new Set();

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


	private showProgress<T>(task: string, promise: Promise<T>): Promise<T> {
		let sbi = window.createStatusBarItem(StatusBarAlignment.Left);
		let server = this
		this._statusBarItems.add(sbi)
		sbi.text = task;
		sbi.show();

		// stolen from https://github.com/6/braille-pattern-cli-loading-indicator/blob/master/index.js
		var loadingIcons = ['⡿','⣟','⣯','⣷','⣾','⣽','⣻','⢿'];
		var i = 0;
		function updateText() {
			sbi.text = loadingIcons[i] + " " + task;
			i = (i + 1) % loadingIcons.length;
		}
		updateText();

		var intervalID = setInterval(updateText, 50);

		function end() {
			clearInterval(intervalID);
			sbi.text = "$(check) " + task;
			server._statusBarItems.delete(sbi)
			setTimeout(() => {
				sbi.hide();
				sbi.dispose();
			}, 5000);
		}

		promise.then(end,end);
		return promise;
	}

	private _doStart(solutionPath: string): Promise<void> {
		return this.showProgress("Starting Wurst", this._doStartAsync(solutionPath));
	}


	private async _doStartAsync(solutionPath: string): Promise<void> {
		this._state = ServerState.Starting;
		this._solutionPath = solutionPath;

		let config = vscode.workspace.getConfiguration("wurst")

        // TODO make configurable
        let java = config.get<string>("javaExecutable")
        let wurstJar = config.get<string>("wurstJar")
		let debugMode = config.get<boolean>("debugMode")
		let hideExceptions = config.get<boolean>("hideExceptions")

		if (!(await this.doesFileExist(wurstJar))) {
			let msg = `Could not find ${wurstJar}. Please configure 'wurst.wurstJar' in your settings.json`
			vscode.window.showErrorMessage(msg);
			return Promise.reject(msg);
		}

		let spawnOptions: SpawnOptions = {
			detached: false
		};
		let args = ["-jar", wurstJar, "-languageServer"]
		if (debugMode == true) {
			if (await this.isPortOpen(5005)) {
				args = ["-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=5005"].concat(args);
			}
		}
		let process = spawn(java, args, spawnOptions)
		this._serverProcess = process;

		process.on('error', (err) => {
			let msg = `could not start server with command ${java} -jar ${wurstJar}. Try changing your settings for 'wurst.javaExecutable' or 'wurst.wurstJar'.`;
			console.log(msg)
			vscode.window.showErrorMessage(msg)
			//reject(msg);
		})

		process.stdout.on('data', (data: string) => {
			this.handleStdout(data.toString());
		});

		process.stderr.on('data', (data) => {
			let msg = `There was a problem with running Wurst: ${data}`
			console.log(`stderr: ${data}`);
			if (!hideExceptions) {
				vscode.window.showErrorMessage(msg);
			}
			// reject(msg);
		});

		process.on('close', (code) => {
			console.log(`child process exited with code ${code}`);
		});


		// TODO actually it is not yet started, should wait for some message?
		console.log(`Server started ${this._serverProcess.pid}!`)
		this._state = ServerState.Started

		// send working directory
		let initPromise = this.sendRequest('init', solutionPath);
		this.showProgress("Initializing workspace", initPromise);

		// fulfil promise
		return undefined;
	}

    public stop(): Promise<void> {


		let ret: Promise<void>;

		if (!this._serverProcess) {
			// nothing to kill
			ret = Promise.resolve<void>(undefined);
			console.log(`Server not running ...`)
		}
        else {
			console.log(`Stopping server ${this._serverProcess.pid} ...`)
			if (process.platform === 'win32') {
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
		}

		return ret.then(_ => {
			this._start = null;
			this._serverProcess = null;
            this._state = ServerState.Stopped;
			console.log("Stopped Server.")
			return;
		});
	}

	public restart(solutionPath: string = this._solutionPath): Promise<void> {
		if (solutionPath) {
			this._statusBarItems.forEach((sbi) => {
				sbi.hide();
				sbi.dispose();
			})
			this._statusBarItems.clear();


			return new Promise<void>((suc, rej) => {
				this.stop().then(() => {
					setTimeout(() => this.start(solutionPath).then(() => suc()), 1000)
				});
			});
		}
	}


	public updateBuffer(fileName: string, documentContent: string): Promise<void> {
		// TODO
		console.log(`updating buffer for ${fileName}`)

		this.sendRequest('reconcile', { filename: fileName, content: documentContent });


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

	public clean(): Promise<any> {
		this._diagnosticsProvider.clean();
		return this.showProgress("Cleaning workspace", this.sendRequest('clean', {}));
	}

	public startlast(): PromiseLike<any> {
		let config = vscode.workspace.getConfiguration("wurst");
		let wc3path = config.get<string>("wc3path");
		if (!wc3path) {
			return Promise.reject("Warcraft path not set (change 'wurst.wc3path' in your settings).");
		}
		if (WurstServer._lastMapConfig == null) {
			return Promise.reject("You havn't run a map yet!");
		}
		return this.startMapIntern(WurstServer._lastMapConfig, wc3path);
	}

	public startmap(args): PromiseLike<any> {
		let config = vscode.workspace.getConfiguration("wurst");
		let wc3path = config.get<string>("wc3path");
		if (!wc3path) {
			return Promise.reject("Warcraft path not set (change 'wurst.wc3path' in your settings).");
		}

		let mapPromise: Thenable<string>;
		if (args && args.length > 0) {
			mapPromise = new Promise(args[0]);
		} else {
			let items = workspace.findFiles('*.w3x', null, 10)
				.then(uris => uris.sort(function(a, b) {
					return fs.statSync(b.fsPath).mtime.getTime() - 
							fs.statSync(a.fsPath).mtime.getTime();
				}))
				.then(uris => uris.map(uri => uri.path))
			mapPromise = window.showQuickPick(items)
		}

		return mapPromise.then(path => {
			WurstServer._lastMapConfig = path;
			return this.startMapIntern(path, wc3path);
		});

	}

	private startMapIntern(mappath: string, wc3path: string) {
		return this.showProgress("Starting map", this.sendRequest('runmap', {
				'mappath': mappath,
				"wc3path": wc3path
			})
			.then(res => {
				if (res != "ok") {
					return Promise.reject(res);
				}
				return Promise.resolve(res);
			}));
	}


	public tests(mode: 'all'|'file'|'func') {
		let data: any = {}
		if (mode != 'all') {
			data.filename = window.activeTextEditor.document.fileName
		}
		if (mode == 'func') {
			let sel = window.activeTextEditor.selection
			if (sel) {
				data.line = sel.start.line
				data.column = sel.start.character
			}
		}

		return this.showProgress("Running tests", this.sendRequest('runtests', data))	
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
		let lastLine = lines[lines.length - 1];
		if (!lastLine.endsWith("\n")) {
			this._stdOutBuffer = lastLine;
			lines.pop();
		} else {
			this._stdOutBuffer = "";
		}

		lines.forEach(data => {
			if (data.startsWith("{")) {
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
				} else if (blob.consoleOutputMessage) {
					this.consolePrint(blob.consoleOutputMessage);
				}
			} else {
				console.log(`stdout: ${data}`);
			}
		});
	}


	private consolePrint(msg) {
		this._channel.append(msg)
		this._channel.show(true)
	}

	handleCompilationResult(data) {
		let path = this.uriForFilename(data.filename);
		this._diagnosticsProvider.setError(path, data.errors);
	}

	public uriForFilename(filename: string): vscode.Uri {
		if (isAbsolute(filename)) {
			return vscode.Uri.file(filename)
		}
		return vscode.Uri.file(this._solutionPath + "/" + filename)
	}

	public getPosition(line: number, column: number): vscode.Position {
		return new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
	}

	private isPortOpen(port): Promise<boolean> {
		return new Promise((resolve, reject) => {
			let net = require('net');
			let tester = net.createServer();
			tester.once('error', function (err) {
				if (err.code == 'EADDRINUSE') {
					resolve(false);
				}
			});
			tester.once('listening', function() {
				tester.close()
				resolve(true);

			});
			tester.listen(port);
		});

	}

	private doesFileExist(filename): Promise<boolean> {
		return new Promise((resolve, reject) => {
			fs.stat(filename, (err, stats) => {
				resolve(!err);
			});
		});
	}

}
