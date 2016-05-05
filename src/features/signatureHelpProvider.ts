/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import AbstractSupport from './abstractProvider';
import {SignatureHelpProvider, SignatureHelp, SignatureInformation, ParameterInformation, CancellationToken, TextDocument, Position} from 'vscode';

export default class WurstSignatureHelpProvider extends AbstractSupport implements SignatureHelpProvider {

	public provideSignatureHelp(document: TextDocument, position: Position, token: CancellationToken): Promise<SignatureHelp> {

        let fut = this._server.sendRequest('signatureHelp', {
            filename: document.fileName,
            //buffer: document.getText(),
            line: position.line+1,
            column: position.character+1
        });


		return fut.then(res => {
            
            if (!res) {
                return undefined;
            }

			let ret = new SignatureHelp();
			ret.activeSignature = res.activeSignature;
			ret.activeParameter = res.activeParameter;

			for(let signature of res.signatures) {

				let signatureInfo = new SignatureInformation(signature.label, signature.documentation);
				ret.signatures.push(signatureInfo);

				for (let parameter of signature.parameters) {
					let parameterInfo = new ParameterInformation(
						parameter.label,
						parameter.documentation);

					signatureInfo.parameters.push(parameterInfo);
				}
			}
            
			return ret;
		});
	}
}
