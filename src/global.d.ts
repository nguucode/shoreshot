// text: select an area, copy the text in it. scroll: select an area, scroll it, get one tall image (macOS).
type ShoreShotMode = 'area' | 'full' | 'window' | 'text' | 'scroll';
/** A piece of recognized text (t) and its box in image pixels, top-left origin. */
interface OcrFragment { t: string; x: number; y: number; w: number; h: number }
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

/** Scrolling capture, while the user scrolls: how it is going and the stitched size in pixels. */
interface ShoreShotScrollStatus {
  status: 'waiting' | 'ok' | 'paused' | 'lost' | 'outside';
  width: number;
  height: number;
  /** Scrolling speed now, and the fastest the stitching can follow, in heights of the area per second. */
  speed: number;
  limit: number;
}

/** Scrolling capture finished: the image size, and the user's speed in heights of the area per second. */
interface ShoreShotScrollDone {
  width: number;
  height: number;
  max: boolean;
  peak: number;
  average: number;
  limit: number;
  lost: number; // times it lost track
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
  /** Text in a PNG, as fragments with their box in image pixels (see ocrtext.ts). */
  ocr(png: Uint8Array): Promise<OcrFragment[]>;
  /** paste: also hide the overlay and paste into the app used before the capture. */
  copyText(text: string, paste: boolean): Promise<void>;
  /** Sends the text to Google Translate; rejects when offline or refused. */
  translate(text: string, to: 'vi' | 'en'): Promise<string>;
  scroll: {
    /** Start grabbing the selection (CSS px); the page has hidden the frozen screenshot. */
    start(box: ShoreShotBox): void;
    /** Stop grabbing and show the result ('scroll:done'). */
    stop(): void;
    /** The stitched image scaled to fit w × maxH pixels (null before the first frame). */
    preview(w: number, maxH: number): Promise<{ w: number; h: number; rgba: Uint8ClampedArray } | null>;
    onStatus(cb: (s: ShoreShotScrollStatus) => void): void;
    onDone(cb: (d: ShoreShotScrollDone) => void): void;
    /** The result's keys arrive here, as global shortcuts: the app scrolled before may still hold the keyboard. */
    onKey(cb: (action: 'copy' | 'paste' | 'save' | 'esc') => void): void;
    /** Shapes drawn on the result for image rows y.., on transparent (RGBA, the image's full width). */
    overlay(y: number, rgba: Uint8ClampedArray): Promise<void>;
    /** Copy / copy and paste / save the result cropped to `crop` (image px), with the overlays sent before. */
    finish(action: 'copy' | 'paste' | 'save', crop: ShoreShotBox): Promise<boolean>;
  };
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
