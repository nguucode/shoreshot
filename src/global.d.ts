interface ShoreShotCapture {
  dataURL: string;
  width: number;
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
  getCapture(): Promise<ShoreShotCapture | null>;
  ready(): void;
  copy(dataURL: string): Promise<boolean>;
  copyPaste(dataURL: string): Promise<boolean>;
  save(dataURL: string): Promise<boolean>;
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
