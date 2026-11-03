type ShoreShotMode = 'area' | 'full' | 'window';
interface ShoreShotBox { x: number; y: number; w: number; h: number }

interface ShoreShotCapture {
  mode: ShoreShotMode;
  cursor: { x: number; y: number }; // CSS px
  bitmap: Uint8Array; // pxW × pxH pixels, RGBA or BGRA
  bgra: boolean;
  pxW: number;
  pxH: number;
  width: number; // CSS px (DIP)
  height: number;
  retina1x: boolean;
}

interface ShoreShotSettings {
  hotkeys: Record<ShoreShotMode, { hotkey: string; pretty: string; active: boolean }>;
  defaults: Record<ShoreShotMode, string>; // '' = not set
  retina1x: boolean;
  openAtLogin: boolean;
  version: string;
  update: string | null; // newer version on GitHub, if any
}

type ShoreShotSetHotkeyResult =
  | { ok: true; hotkey: string; pretty: string }
  | { ok: false; error: string };

interface ShoreShotApi {
  onCapture(cb: (cap: ShoreShotCapture) => void): void;
  onHidden(cb: () => void): void;
  onWindows(cb: (windows: ShoreShotBox[]) => void): void;
  ready(): void;
  copy(png: Uint8Array): Promise<boolean>;
  copyPaste(png: Uint8Array): Promise<boolean>;
  save(png: Uint8Array): Promise<boolean>;
  close(): void;
  settings: {
    get(): Promise<ShoreShotSettings>;
    setHotkey(mode: ShoreShotMode, accel: string): Promise<ShoreShotSetHotkeyResult>;
    setRecording(on: boolean): void;
    setOption(name: 'retina1x' | 'openAtLogin', on: boolean): Promise<boolean>;
    link(name: 'about' | 'issues' | 'update'): void;
  };
}

interface Window {
  api: ShoreShotApi;
}
