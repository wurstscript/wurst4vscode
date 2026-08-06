/* eslint-disable sonarjs/redundant-type-aliases -- CI-only compatibility surface. */

export declare class BinReader {
    [key: string]: any;
    constructor(...args: any[]);
}
export declare class MpqReader {
    [key: string]: any;
    constructor(...args: any[]);
}

export type DecodedRasterImage = any;
export type DooFile = any;
export type DooDoodad = any;
export type DooSpecialDoodad = any;
export type DooUnit = any;
export type DooDropSet = any;
export type DooItemDrop = any;
export type DooInvItem = any;
export type DooAbility = any;
export type DooRandType = any;
export type DooFileKind = any;
export type MpqFileEntry = any;
export type ObjModFile = any;
export type ObjModEntry = any;
export type ObjModMod = any;
export type ObjModVarType = any;
export type W3iFile = any;
export type W3iPlayer = any;
export type W3iForce = any;
export type WctFile = any;
export type WctTrig = any;
export type WtgFile = any;
export type WtgCategory = any;
export type WtgVar = any;
export type WtgTrig = any;
export type WpmFile = any;

export declare function decodeBlp(...args: any[]): any;
export declare function decodeDds(...args: any[]): any;
export declare function decodeTga(...args: any[]): any;
export declare function parseDoo(...args: any[]): any;
export declare function parseObjMod(...args: any[]): any;
export declare function parseW3i(...args: any[]): any;
export declare function parseWct(...args: any[]): any;
export declare function parseWtg(...args: any[]): any;
export declare function parseWpm(...args: any[]): any;
export declare function serializeObjMod(...args: any[]): any;
export declare function serializeW3i(...args: any[]): any;
