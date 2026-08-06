export declare class CascStorage {
    private constructor();
    static openAsync(storagePath: string, log?: (msg: string) => void): Promise<CascStorage>;
    readonly fileCount: number;
    listFiles(): string[];
    hasFileAsync(filePath: string): Promise<boolean>;
    readFileAsync(filePath: string): Promise<Buffer>;
    findPathByBasenameAsync(basename: string, containers?: string[]): Promise<string | null>;
}
export declare class MpqStorage {
    private constructor();
    static openAsync(filePath: string, log?: (msg: string) => void): Promise<MpqStorage>;
    readonly fileCount: number;
    close(): Promise<void>;
    hasFileAsync(filePath: string): Promise<boolean>;
    readFileAsync(filePath: string): Promise<Buffer>;
    listFilesAsync(): Promise<string[]>;
}
export declare function closeAllSegments(): Promise<void>;
