# Wurst extension for Visual Studio Code

This is an experimental plugin for the [Wurst programming lagnuage](https://peq.github.io/WurstScript/). 
It provides some basic features like autocomplete and jump to definition.

## Setup


Open your settings and set the property `wurst.wurstJar`  to the path of your `wurstscript.jar` in your Wurstpack. You need an up-to-date version of WurstScript for the plugin to work.
You can also change the executable used for starting Java (the default is "java").

Example configuration:

    "wurst.wurstJar": "/home/peter/work/WurstScript/Wurstpack/wurstscript/wurstscript.jar",
    "wurst.javaExecutable": "java",
    "editor.insertSpaces": false


## Features

Note: The shortcuts below can be changed in the settings and might be different on your system.

* Syntax highlighting
* Shows errors and warnings while you type
* Autocomplete after typing a dot or pressing `Ctrl+space`.
* Parameter-info (press `Ctrl+shift+space`)
* Goto declaration (`F12` or `Ctrl+leftclick`)
* Some commands area available via the command palette (press `F1` and type "Wurst")