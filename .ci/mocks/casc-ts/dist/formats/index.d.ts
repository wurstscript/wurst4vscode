/* CI-only compatibility surface for the private casc-ts package. */

export declare class BinReader {
    constructor(buf: Buffer);
    readonly offset: number;
    readonly remaining: number;
    readonly eof: boolean;
    seek(offset: number): void;
    skip(bytes: number): void;
    peekU8(): number;
    readU8(): number;
    readU16(): number;
    readU32(): number;
    readI32(): number;
    readF32(): number;
    readId(): string;
    readBytes(count: number): Buffer;
    readString(): string;
}

export type DecodedRasterImage =
    | { kind: 'raster'; mode: 'rgba'; width: number; height: number; rgbaBase64: string; warnings: string[]; description: string }
    | { kind: 'raster'; mode: 'jpeg'; width: number; height: number; jpegBase64: string; warnings: string[]; description: string };

export interface DooItemDrop { itemId: string; chance: number; }
export interface DooDropSet { items: DooItemDrop[]; }
export interface DooInvItem { slot: number; itemId: string; }
export interface DooDoodad {
    typeId: string; variation: number; x: number; y: number; z: number; angle: number;
    scaleX: number; scaleY: number; scaleZ: number; skinId?: string; flags: number;
    lifePerc: number; itemTablePtr: number; drops: DooDropSet[]; editorId: number;
}
export interface DooSpecialDoodad { typeId: string; z: number; x: number; y: number; }
export interface DooAbility { abilityId: string; autoCast: boolean; level: number; }
export type DooRandType = 'any' | 'group' | 'custom';
export interface DooUnit {
    typeId: string; variation: number; x: number; y: number; z: number; angle: number;
    scaleX: number; scaleY: number; scaleZ: number; skinId?: string; flags: number;
    ownerIndex: number; lifePerc: number; manaPerc: number; itemTablePtr?: number;
    drops: DooDropSet[]; resourcesAmount: number; targetAcquisition: number; heroLevel: number;
    heroStr?: number; heroAgi?: number; heroInt?: number; invItems: DooInvItem[];
    abilities: DooAbility[]; randType: DooRandType; randLevel?: number; randClass?: number;
    randGroupIndex?: number; randGroupPos?: number; randCustom?: DooItemDrop[];
    customColor: number; waygateTargetRectIndex: number; editorId: number;
}
export type DooFileKind = 'doodads' | 'units';
export interface DooFile {
    kind: DooFileKind; version: number; subVersion: number;
    doodads?: DooDoodad[]; specialDoodads?: DooSpecialDoodad[]; units?: DooUnit[]; error?: string;
}

export type ObjModVarType = 'int' | 'real' | 'unreal' | 'string';
export interface ObjModMod {
    fieldId: string; varType: ObjModVarType; level?: number; dataPt?: number;
    value: number | string; endToken: string;
}
export interface ObjModEntry {
    baseId: string; newId: string | null; unknown?: number[]; unknowns?: number[]; mods: ObjModMod[];
}
export interface ObjModFile {
    version: number; ext: string; extended: boolean; origObjs: ObjModEntry[]; customObjs: ObjModEntry[]; error?: string;
}

export interface W3iPlayer { num: number; type: number; race: number; fixedStart: number; name: string; }
export interface W3iForce { flags: number; playerMask: number; name: string; }
export interface W3iFile {
    version: number; saves: number; editorVersion: number; gameVersionRaw?: Buffer; gameVersion?: string;
    name: string; author: string; description: string; recommendedPlayers: string; cameraBounds: Buffer;
    margins: Buffer; width: number; height: number; flags: number; tileset: string; loadingBackground: number;
    loadingModel?: string; loadingText: string; loadingTitle: string; loadingSubtitle: string;
    gameDataSet: number; prologuePath: string; prologueText: string; prologueTitle: string;
    prologueSubtitle: string; tail: Buffer; players?: W3iPlayer[]; forces?: W3iForce[]; error?: string;
}

export interface WctTrig { index: number; text: string; }
export interface WctFile { version: number; headComment?: string; headTrig?: WctTrig; trigs: WctTrig[]; error?: string; }
export interface WtgCategory { index: number; name: string; isComment: boolean; }
export interface WtgVar {
    name: string; type: string; isArray: boolean; arraySize?: number; hasInitVal: boolean; initVal: string;
}
export interface WtgTrig {
    name: string; description: string; type: number; enabled: boolean; customTxt: boolean; initiallyOn: boolean;
    runOnMapInit?: boolean; catIndex: number; ecaCount: number;
}
export interface WtgFile {
    version: number; categories: WtgCategory[]; vars: WtgVar[]; trigCount: number; trigs: WtgTrig[];
    trigsPartial: boolean; error?: string;
}

export interface WpmFile { version: number; width: number; height: number; data: Buffer; error?: string; }
export interface MpqFileEntry { name: string; normalSize: number; compressedSize: number; }
export interface MpqStorageFileEntry { name: string; normalSize: number; compressedSize: number; }

export declare class MpqReader {
    private constructor();
    static open(buf: Buffer): MpqReader;
    hasFile(name: string): boolean;
    readFileAsync(name: string): Promise<Buffer>;
    listFilesAsync(): Promise<string[]>;
    getFilesWithInfoAsync(): Promise<MpqFileEntry[]>;
}

export declare class MpqStorage {
    private constructor();
    static openAsync(filePath: string, log?: (message: string) => void): Promise<MpqStorage>;
    readonly fileCount: number;
    close(): Promise<void>;
    hasFile(name: string): boolean;
    hasFileAsync(name: string): Promise<boolean>;
    readFileAsync(name: string): Promise<Buffer>;
    listFilesAsync(): Promise<string[]>;
    getFilesWithInfoAsync(): Promise<MpqStorageFileEntry[]>;
}

export declare function decodeBlp(...args: any[]): DecodedRasterImage;
export declare function decodeDds(...args: any[]): DecodedRasterImage;
export declare function decodeTga(...args: any[]): DecodedRasterImage;
export declare function parseDoo(data: Buffer, fileName: string): DooFile;
export declare function parseObjMod(data: Buffer, fileExt: string): ObjModFile;
export declare function parseW3i(buf: Buffer): W3iFile;
export declare function parseWct(data: Buffer): WctFile;
export declare function parseWtg(data: Buffer): WtgFile;
export declare function parseWpm(data: Buffer): WpmFile;
export declare function serializeObjMod(file: ObjModFile): Buffer;
export declare function serializeW3i(file: W3iFile): Buffer;
