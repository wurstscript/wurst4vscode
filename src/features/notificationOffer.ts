'use strict';

import * as vscode from 'vscode';

export const OFFER_LATER_ACTION = 'Later';
export const OFFER_NEVER_ACTION = "Don't show again";

export type OfferChoice = 'primary' | 'later' | 'never' | undefined;

let pendingOffer = Promise.resolve();

/** Show one non-modal, three-choice offer at a time so workspace prompts do not stack. */
export function showThreeChoiceOffer(message: string, primaryAction: string): Promise<OfferChoice> {
    const result = pendingOffer.then(() => vscode.window.showInformationMessage(
        message,
        primaryAction,
        OFFER_LATER_ACTION,
        OFFER_NEVER_ACTION,
    ));
    pendingOffer = result.then(() => undefined, () => undefined);
    return result.then((choice) => {
        if (choice === primaryAction) return 'primary';
        if (choice === OFFER_LATER_ACTION) return 'later';
        if (choice === OFFER_NEVER_ACTION) return 'never';
        return undefined;
    });
}
