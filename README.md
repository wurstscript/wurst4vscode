[![Build Status](https://travis-ci.org/wurstscript/wurst4vscode.svg?branch=master)](https://travis-ci.org/wurstscript/wurst4vscode)
# Wurst extension for Visual Studio Code

This is a plugin for the [Wurst programming language](https://peq.github.io/WurstScript/), a language for maps and mods for the game Warcraft III.

If you run into problems related directly to the plugin, please create a ticket on [GitHub](https://github.com/wurstscript/wurst4vscode).

## Features

Context-aware auto completions (default shortcut: `Ctrl+space`) help you to find relevant functions quickly.
You can also see the documentation of the function and the required arguments.

![Autocomplete](https://i.imgur.com/QPwREHO.gif)

You can always find the definition of a function (`F12` or `Ctrl+leftclick`, or just peek at the definition with `Ctrl+Shift+F10`). 

![Goto declaration](https://i.imgur.com/imIINfH.gif)

It is even possible to navigate into the other direction and find all the references of a given definition (`Shift+F12`).
When navigating via links, remember that vscode provides shortcuts to get to your old position (`ctrl+alt+-` and `ctrl+shift+-`).

![Find references](https://i.imgur.com/xas74JI.gif)

When you are looking for references inside a file you don't even need to use the features above.
Vscode will automatically highlight all other references and definitions related to the element currently under the cursor:

![Highlight references](https://i.imgur.com/Pzh1Zpq.gif)


### Feature list:

* Syntax highlighting
* Shows errors and warnings while you type (press `Ctrl+Shift+M` for an overview over all errors and warnings, `F8` and `Shift+F8` to loop through the errors in the current file)
* Autocomplete after typing a dot or pressing `Ctrl+space`.
* Parameter-info (press `Ctrl+shift+space`)
* Goto declaration (`F12` or `Ctrl+leftclick`)
* Find references (`Shift+F12`)
* Mouse hover info (hover the mouse over a function or variable to see types and documentation)
* Some commands are available via the command palette (press `F1` and type "Wurst")
    * Running units tests
	* Building maps independently from warcraft3
    * Running a map 

You should also be aware of the following vscode features, which are independent from this Wurst plugin:

* Folding based on indentation
* Quick Open: Open any file by its name via `Ctrl+P`
* Search across files (`Ctrl+Shift+F`)
* [Multiple selections](https://code.visualstudio.com/docs/editor/editingevolved#_multiple-selections)
* Integrated Git support

## Setup and Configuration

Follow the [Wurst Setup Guide](https://wurstscript.github.io/start.html) to install Wurst, the plugin and create your wurst project.

## Getting Started: Your first Wurst project

Follow the [Wurst Beginner Guide](https://wurstscript.github.io/tutorials/wurstbeginner.html).

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
7. Make a pull request with your changes

Contributors can publish the extension to the Extension Marketplace using `vsce publish` as described in the [vsce - Publishing Tool Reference](https://code.visualstudio.com/docs/tools/vscecli).
To update the version use `npm version patch`.






