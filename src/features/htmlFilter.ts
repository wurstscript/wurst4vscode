'use strict';

import {HoverProvider, Hover, MarkedString, TextDocument, CancellationToken, Position} from 'vscode';

export function fromHtml(html: string): MarkedString[] {
    html = html.replace(/<pre>/g, "\n[code]");
    html = html.replace(/<\/pre>/g, "\n");
    html = html.replace(/<br \/>/g, "\n");
    let txt = plain(html)
    let lines: MarkedString[] = [""];
    let code: string = null;
    txt.split(/\n/).forEach(line => {
        if (line.startsWith("[code]")) {
            if (code !== null) {
                lines.push({ language: 'wurst', value: code });
                code = null;
            }
            lines.push({ language: 'wurst', value: line.replace("[code]", "") });
            lines.push("");
        } else {
            let lineTrimmed = line.trim();
            if (lineTrimmed.startsWith("|")) {
                if (!code) {
                    code = "";
                }
                code = code + "\n" + line.substr(1);
            } else {
                if (code !== null) {
                    lines.push({ language: 'wurst', value: code });
                    lines.push("");
                    code = null;
                }
                lines[lines.length-1] += "\n" + line;
            }
        }
    });
    if (code !== null) {
        lines.push({ language: 'wurst', value: code });
    }
    return lines.filter(s => s !== "");
}

export function htmlToString(html: string): string {
    if (!html) {
        return "";
    }
    html = html.replace(/<pre>/g, "\n");
    html = html.replace(/<\/pre>/g, "\n");
    html = html.replace(/<br \/>/g, "\n");
    let txt = plain(html)
    return txt;
}

var _regExp = /<(\S*?).*?>((.|\r|\n)*?)<\/\1>/;

/**
 * remove xml-tags from string
 */
export function plain(doc: string): string {

    if (!doc) {
        return doc;
    }

    let newDoc: string;

    while (true) {
        newDoc = doc.replace(_regExp,(m, g1, g2, g3) => g2);
        if (newDoc === doc) {
            break;
        }
        doc = newDoc;
    }
    newDoc = newDoc.replace(/<(\S*?).*\/>/g,"");
    return newDoc;
}