# Wurst extension for Visual Studio Code

This is a plugin for the [Wurst programming language](https://peq.github.io/WurstScript/), a language for maps and mods for the game Warcraft III.

If you run into any problems while using the plugin, please create a ticket on [GitHub](https://github.com/peq/wurst4vscode).


## Features

Context-aware auto completions (default shortcut: `Ctrl+space`) help you to find relevant functions quickly.
You can also see the documentation of the function and the required arguments.

![Autocomplete](http://i.imgur.com/QPwREHO.gif)

You can always find the definition of a function (`F12` or `Ctrl+leftclick`, or just peek at the definition with `Ctrl+Shift+F10`). 

![Goto declaration](http://i.imgur.com/imIINfH.gif)

It is even possible to navigate into the other direction and find all the references of a given definition (`Shift+F12`).
When navigating via links, remember that vscode provides shortcuts to get to your old position (`ctrl+alt+-` and `ctrl+shift+-`).

![Find references](http://i.imgur.com/xas74JI.gif)

When you are looking for references inside a file you don't even need to use the features above.
Vscode will automatically highlight all other references and definitions related to the element currently under the cursor:

![Highlight references](http://i.imgur.com/Pzh1Zpq.gif)



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
    * Comiling and running a map 

You should also be aware of the following vscode features, which are independent from this Wurst plugin:

* Folding based on indentation
* Quick Open: Open any file by its name via `Ctrl+P`
* Search across files (`Ctrl+Shift+F`)
* [Multiple selections](https://code.visualstudio.com/docs/editor/editingevolved#_multiple-selections)
* Integrated Git support





## Setup and Configuration

### Requirements

  * [Java 8](http://www.oracle.com/technetwork/java/javase/downloads/index.html)
  * [Wurst compiler](http://peeeq.de/hudson/job/Wurst/lastSuccessfulBuild/artifact/downloads/wurstpack_compiler.zip) 
     * If you are using WurstPack, you should use the compiler included in the pack under `Wurstpack/wurstscript/wurstscript.jar`.


After installing [vsCode](https://code.visualstudio.com), you can install the [Wurst language support from the vsCode marketplace](https://marketplace.visualstudio.com/items?itemName=peterzeller.wurst).
Launch VS Code Quick Open (Ctrl+P), write `ext install wurst`, and press enter.

After installation you have to adjust a few settings in your _settings.json_ (open it via `File` -> `Preferences` -> `User settings`):


The only mandatory configuration is to set the path to the compiler.
To do this, set the property `wurst.wurstJar` to the path where you installed the Wurst compiler (`wurstscript.jar`).
You can run `java -jar your/path/to/wurstscript.jar --about` from a terminal to test whether Java and Wurst have been installed correctly.


Minimal configuration:

    {
        "wurst.wurstJar": "/home/peter/work/WurstScript/Wurstpack/wurstscript/wurstscript.jar",
    }

All configuration options are shown below with their default values.

    {
        // The command to use for starting Java. You can change this if Java is not in your PATH
        "wurst.javaExecutable": "java",

        // Enabling the debugmode will make the VM available for debugging on port 5005
        "wurst.debugMode": "false",

        // Turn this off to see Wurst Exceptions as vscode notifications
        "wurst.hideExceptions": "true",

        // The path to wurstscript.jar (in your WurstPack folder)
        "wurst.wurstJar": "/home/peter/work/WurstScript/Wurstpack/wurstscript/wurstscript.jar",

        // The path to your Frozen Throne installation directory.
        "wurst.wc3path": null,
    }

If you want to run maps from vscode, you have to set the `wurst.wc3path` option.

In addition there are some vscode settings relevant to Wurst:

    // Controls if quick suggestions should show up or not while typing
	"editor.quickSuggestions": true,
	
    // Controls the delay in ms after which quick suggestions will show up
	"editor.quickSuggestionsDelay": 10,
    
    // Insert spaces when pressing Tab.
    "editor.insertSpaces": true,

## Getting Started: Your first Wurst project

1. Create a new folder for your project. This will be your project folder.
2. Use `File`->`Open Folder...` to open your project folder. The plugin only works when opening the project folder.
3. Create a file named `wurst.dependencies`. 
    This file contains paths where Wurst searches for libraries (one path per line).
    Usually, you should at least add the standard library here.
    To do this, clone or download the [Wurst standard library](https://github.com/peq/wurstStdlib) to your machine and add the path to it to your `wurst.dependencies` file.
4. Create a folder named `wurst`. This is where all your Wurst sources will go.
5. Create a new file named `Hello.wurst` in the newly created `wurst` folder.
    Add the following contents:

        package Hello

        init
            print("Hello Wurst")
6. Use the World-Editor to create a new map and save it into your project folder.
    Make sure, that the map is a Frozen Throne map and has a `*.w3x` ending.
    Moreover, the map should have at least one unit edited in the object editor, so that Wurst can modify the object file. 
    
    Your project should now have the following structure:

    ![Hello Wurst project layout](http://i.imgur.com/KAB1Se2.png)

7. Launch the command prompt by pressing `F1` and launch the command `wurst: Run a Wurst map`.
    Wurst will search for maps in your project folder (not in subdirectories) and will show you a list of maps to pick from.
    Pick your map with the arrow keys and press `Enter`.

    Now Warcraft should launch with your map and display "Hello Wurst" on the screen.



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
To update the version use `npm version path`.



