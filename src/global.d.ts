interface ShoreShotCapture {
  bitmap: Uint8Array; // pxW × pxH pixels, RGBA or BGRA
  bgra: boolean;
  pxW: number;
  pxH: number;
  width: number; // CSS px (DIP)
  height: number;
  enterPastes: boolean;
}

interface ShoreShotSettings {
  hotkey: string;
  pretty: string;
  active: boolean;
  defaultHotkey: string;
  platform: string;
  enterPastes: boolean;
}

type ShoreShotSetHotkeyResult =
  | { ok: true; hotkey: string; pretty: string }
  | { ok: false; error: string };

interface ShoreShotApi {
  onCapture(cb: (cap: ShoreShotCapture) => void): void;
  onHidden(cb: () => void): void;
  ready(): void;
  copy(png: Uint8Array): Promise<boolean>;
  copyPaste(png: Uint8Array): Promise<boolean>;
  save(png: Uint8Array): Promise<boolean>;
  close(): void;
  settings: {
    get(): Promise<ShoreShotSettings>;
    setHotkey(accel: string): Promise<ShoreShotSetHotkeyResult>;
    setRecording(on: boolean): void;
    setEnterPastes(on: boolean): Promise<boolean>;
  };
}

interface Window {
  api: ShoreShotApi;
}
