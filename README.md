# Wurst extension for Visual Studio Code

This is an experimental plugin for the [Wurst programming language](https://peq.github.io/WurstScript/). 
It provides some basic features like autocomplete and jump to definition.

## Setup

Open your _settings.json_ and set the property `wurst.wurstJar` to the path a `wurstscript.jar`. 
You can either use the one from your Wurstpack or download the latest one [here](http://peeeq.de/hudson/job/Wurst/lastSuccessfulBuild/artifact/downloads/wurstscript.jar)

Minimal configuration:

    "wurst.wurstJar": "/home/peter/work/WurstScript/Wurstpack/wurstscript/wurstscript.jar"

Example configuration:

    "wurst.wurstJar": "/home/peter/work/WurstScript/Wurstpack/wurstscript/wurstscript.jar",
    "wurst.javaExecutable": "java",
    "wurst.debugMode": true,
    "editor.insertSpaces": false

There are a few additional properties, mostly used for debugging:
* __wurst.debugMode__ : Makes the Wurst VM accessible for debugging on port 5005 *(default: false)*
* __wurst.hideExceptions__ : shows wurst exceptions in the editor if enabled *(default: false)*
* __wurst.javaExecutable__ : sets the command used to invoke java on your system *(default: java)*

## Features

Note: The shortcuts below can be changed in the settings and might be different on your system.

* Syntax highlighting
* Shows errors and warnings while you type
* Autocomplete after typing a dot or pressing `Ctrl+space`.
* Parameter-info (press `Ctrl+shift+space`)
* Goto declaration (`F12` or `Ctrl+leftclick`)
* Some commands area available via the command palette (press `F1` and type "Wurst")


## Developer information

If you want to build the extension yourself:

1. First install 
    - Node.js (newer than 4.3.1)
    - Npm  (newer 2.14.12)
2. clone the project from [GitHub](https://github.com/peq/wurst4vscode).
3. Change to the project directory (e.g. `cd wurst4vscode`)
4. Run `npm i`
5. Open the project in Visual Studio Code (`code .`)
6. Press `F5` to debug (it should start a new vscode window with Wurst enabled)

To publish the extension to the Extension Marketplace use `vsce publish` as described in the [vsce - Publishing Tool Reference](https://code.visualstudio.com/docs/tools/vscecli). 



