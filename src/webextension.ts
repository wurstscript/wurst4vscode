'use strict';

import * as vscode from 'vscode';
import { ExtensionContext } from 'vscode';
import { languageConfig } from './languageConfig';


export async function activate(_context: ExtensionContext) {
    console.log('Wurst extension activated!!');


    vscode.languages.setLanguageConfiguration('wurst', languageConfig);
}

