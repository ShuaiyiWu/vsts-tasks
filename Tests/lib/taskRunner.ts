/// <reference path="../../definitions/node.d.ts"/>
/// <reference path="../../definitions/Q.d.ts"/>
/// <reference path="../../definitions/shelljs.d.ts"/>
/// <reference path="../../definitions/vsts-task-lib.d.ts"/>

import Q = require('q');
import events = require('events');
import fs = require('fs');
import path = require('path');
import child_process = require('child_process');
import shell = require('shelljs');
import tcm = require('vsts-task-lib/taskcommand');

function debug(message) {
    if (process.env['TASK_TEST_TRACE']) {
        console.log(message);
    }
}

export class TaskRunner extends events.EventEmitter {
	constructor(name: string, ignoreSlashes?: boolean) {
		super();
		this._inputs = {};
		this._name = name;
		this._taskEnv = {};
		this._taskEnv['MOCK_RESPONSES'] = process.env['MOCK_RESPONSES'];
		this.succeeded = true;
		this.failed = false;
		this.resultWasSet = false;
		this.invokedToolCount = 0;
		this.stdout = '';
		this.stderr = '';
		this._tempPath = process.env['TASK_TEST_TEMP'];
		this._commands = [];
		this._ignoreSlashes = ignoreSlashes;
	}
	
	public succeeded: boolean;
	public failed: boolean;
	public resultWasSet: boolean;
	public invokedToolCount: number;
	public stderr: string;
	public stdout: string;

	private _name: string;
	private _inputs: any;
	private _task: any;
	private _taskEnv: any;
	private _taskSrcPath: string;
	private _taskPath: string;
	private _tempPath: string;
	private _commands: string[];  
	private _ignoreSlashes: boolean;

	public ran(cmdLine: string): boolean {
		var executed: boolean = false;
		this._commands.forEach((cmd: string)=>{
			if (this._ignoreSlashes) {
				cmdLine = cmdLine.replace(/\\/g, "/");
				cmd = cmd.replace(/\\/g, "/");
			}
			if(cmdLine.trim().localeCompare(cmd.trim()) === 0) {
				executed = true;
			}
		})

		return executed;
	}

	public setInput(name: string, val: string) {
		this._inputs[name] = val;
	}
	
	//
	// stderr/out
	//
	public stdErrContained(text: string): boolean {
		return this.stderr.indexOf(text) >= 0;
	}

	public run(): Q.Promise<void> {
		this.emit('starting');
		var defer = Q.defer<void>();

		if (!this._tempPath) {
			throw (new Error('Temp is not defined'));
		}

		this._taskSrcPath = path.join(__dirname, '..', '..', 'Tasks', this._name);
		
		if (!fs.existsSync(this._taskSrcPath)) {
			throw (new Error('Did you build with "gulp"? Task does not exist: ' + this._taskSrcPath));
		}
		
		// copy mocked vsts-task-lib if it doesn't exist
		var modPath = path.join(this._tempPath, 'node_modules');
		if (!shell.test('-d', modPath)) {
			shell.mkdir('-p', modPath);
			shell.cp('-R', path.join(__dirname, 'node_modules/vsts-task-lib'), path.join(modPath));			
		}

		// copy the task over so we can execute from Temp 
		// this forces it to use the mocked vsts-task-lib and provides isolation
		this._taskPath = path.join(this._tempPath, this._name);
		if (!shell.test('-d', this._taskPath)) {
			shell.mkdir('-p', this._taskPath);
			shell.cp('-R', this._taskSrcPath, this._tempPath);
		}

		// delete it's linked copy of vsts-task-lib so it uses the mocked task-lib above
		var taskLibPath = path.join(this._taskPath, 'node_modules', 'vsts-task-lib');
		if (shell.test('-d', taskLibPath)) {
			shell.rm('-rf', taskLibPath);
		}

		var jsonPath = path.join(this._taskPath, 'task.json');
		if (!fs.existsSync(jsonPath)) {
			throw (new Error('Task json does not exist: ' + jsonPath));
		}
		
		var json = fs.readFileSync(jsonPath).toString();
		this._task = JSON.parse(json);
		
		this._tryRunNode()
		.then(() => {
			this.emit('completed');
			defer.resolve(null);
		})
		.fail((err) => {
			defer.reject(err);
		})
		.fin(() => {
			// cleanup
		})
		
		return <Q.Promise<void>>defer.promise;
	}
	

	private _processOutput(stdout: string, stderr: string) {
		this.stdout = stdout || '';
		this.stderr = stderr || '';

		var stdoutLines: string[] = [];
		if (stdout) {
			stdoutLines = stdout.split('\n');
		}

		stdoutLines.forEach((line: string) => {
			if (line.indexOf('[command]') >= 0) {
				++this.invokedToolCount;
				var command = line.substr(line.indexOf('[command]') + '[command]'.length).trim();
				if (this._ignoreSlashes) {
					command = command.replace(/\\/g, "/");
				}				
				this._commands.push(command);
			}

			if (line.indexOf('##vso[') >= 0) {
				var cmd = tcm.commandFromString(line);
				//console.log(JSON.stringify(cmd, null, 2));

  				if (cmd.command === "task.complete") {
  					if (cmd.properties['result'] === 'Failed') {
  						this.failed = true;
  						this.succeeded = false;
  						this.resultWasSet = true;
  					}
  					else if (cmd.properties['result'] === 'Succeeded') {
  						this.succeeded = true;
  						this.failed = false;
  						this.resultWasSet = true;
  					}
  				}
			}
		})
	}

	private _tryRunNode(): Q.Promise<void> {
		var defer = Q.defer<void>();

		//
		// Match node handler logic in agent.  The vars is the protocol
		//
	    var env = process.env;
	    for (var key in this._inputs){
	        var envVarName = 'INPUT_' + key.replace(' ', '_').toUpperCase();
	        this._taskEnv[envVarName] = this._inputs[key];
	    }

	    //
	    // Run the task via node
	    //
		var nodeExecution = this._task.execution['Node'];
		if (nodeExecution) {
			if (!nodeExecution.target) {
				throw (new Error('Execution target not specified'));
			}

			var scriptPath = path.join(this._taskPath, nodeExecution.target);
			if (!shell.test('-f', scriptPath)) {
				throw (new Error('target does not exist: ' + scriptPath));
			}

			var child = child_process.exec('node ' + scriptPath, 
							{ 
								cwd: this._taskPath, 
								// keep current env clean
								env: this._taskEnv
							},
				(err, stdout, stderr) => {
					if (err !== null) {
						defer.reject(err);
						return;
					}

					this._processOutput(stdout.toString(), stderr.toString());

					if (stdout) {
						debug('stdout:');
						debug(stdout);
					}
					
					if (stderr) {
						debug('stderr:');
						debug(stderr);
					}
					
					defer.resolve(null);
				});
		}
		else {
			defer.resolve(null);
		}		
		
		return <Q.Promise<void>>defer.promise;
	}	
}

