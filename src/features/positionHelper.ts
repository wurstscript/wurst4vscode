'use strict';

import {Position, Range} from 'vscode';

export function convertRange(r): Range {
    let range = new Range(this.convertPos(r.start), this.convertPos(r.end));
    console.log(`converted ${r} to ${range}...`)
    return range;
}

export function convertPos(p): Position {
    return new Position(p.line, p.column);
}