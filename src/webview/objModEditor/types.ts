export interface ObjModObject {
  key: string;
  baseId: string;
  newId?: string;
  displayName: string;
  displaySource?: string;
  group: string;
  race?: string;
  campaign?: boolean;
  kind?: string;
  iconPath?: string;
  modelPath?: string;
  [key: string]: unknown;
}

export interface ObjModField {
  fieldId: string;
  label?: string;
  category?: string;
  type?: string;
  varType?: string;
  level?: number | null;
  dataPt?: number | null;
  currentValue?: unknown;
  editValue?: unknown;
  displayValue?: unknown;
  displayDetail?: unknown;
  source?: string;
  overridden?: boolean;
  editable?: boolean;
  assetType?: string;
  [key: string]: unknown;
}

export interface AssetOption {
  value: string;
  label: string;
  detail?: string;
  source?: string;
  iconPath?: string;
}

export type AssetCatalog = Record<string, AssetOption[]>;

export interface VsCodeApi {
  getState(): Record<string, unknown> | undefined;
  setState(state: Record<string, unknown>): void;
  postMessage(message: unknown): void;
}

export interface ObjModInitial {
  objects: ObjModObject[];
  selectedKey: string;
  isPendingJump?: boolean;
  extended: boolean;
  fileInfo?: Record<string, unknown>;
  thumbnailWorkerUri?: string;
}

declare global {
  interface Window {
    __OBJMOD_INITIAL__?: ObjModInitial;
    __wurstModelThumbDebug?: Record<string, unknown>;
    __WAR3_MODEL_DEBUG?: boolean | string | number;
    War3Viewer?: unknown;
    clipboardData?: DataTransfer;
  }

  interface Element {
    checked: boolean;
    hidden: boolean;
    value: string;
    _commitNow?: (() => void) | null;
    _flashTimer?: ReturnType<typeof setTimeout>;
    _origLabel?: string | null;
    click(): void;
    focus(options?: FocusOptions): void;
  }

  interface EventTarget {
    closest(selectors: string): Element | null;
    classList: DOMTokenList;
    scrollTop: number;
  }

  interface HTMLElement {
    _collapseHandler?: () => void;
    _commitNow?: (() => void) | null;
    _flashTimer?: ReturnType<typeof setTimeout>;
    _origLabel?: string | null;
    _refocusOnCollapse?: boolean;
    _ss?: number;
    _se?: number;
  }
}
