// window.api for the Tauri app: the same interface as src/preload.ts (typed in src/global.d.ts), on top of
// Tauri's IPC (window.__TAURI__, app.withGlobalTauri). Loaded before editor.js / settings.js.
// The capture bitmap arrives as raw bytes (ipc::Response) and PNGs go back as a raw request body, never JSON.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const report = (what) => invoke('log', { line: `js error: ${what}` });
  addEventListener('error', (e) => report(e.message));
  addEventListener('unhandledrejection', (e) => report(String(e.reason?.stack || e.reason)));

  let transferMs = 0;
  // SHORESHOT_AUTO_KEY (test runs): press a key once the capture is showing, e.g. "Enter" or "Meta+s".
  const press = (spec) => {
    const key = spec.replace('Meta+', '');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: spec !== key, bubbles: true }));
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  };

  const show = (cb, meta, bitmap) => {
    cb({ ...meta, bitmap, bgra: false });
    if (meta.autoKey) setTimeout(() => press(meta.autoKey), 500);
  };

  window.api = {
    onCapture: (cb) => {
      // Windows: the bitmap arrives as a WebView2 shared buffer (the page maps the app's memory, no IPC copy),
      // with the metadata as additionalData. putImageData copies it synchronously, so it is released right after.
      window.chrome?.webview?.addEventListener('sharedbufferreceived', (e) => {
        const buf = e.getBuffer();
        transferMs = 0;
        try {
          show(cb, e.additionalData, new Uint8Array(buf));
        } finally {
          window.chrome.webview.releaseBuffer(buf);
        }
      });
      // macOS, and Windows if the shared buffer failed: pull the raw bytes over IPC.
      return listen('capture:show', async ({ payload: meta }) => {
        const t = performance.now();
        const bitmap = new Uint8Array(await invoke('bitmap'));
        transferMs = Math.round(performance.now() - t);
        show(cb, meta, bitmap);
      });
    },
    onHidden: (cb) => listen('capture:hidden', () => cb()),
    onWindows: (cb) => listen('capture:windows', ({ payload }) => cb(payload)),
    ready: () => invoke('ready', { transferMs }),
    copy: (png) => invoke('copy', png),
    copyPaste: (png) => invoke('copy_paste', png),
    save: (png) => invoke('save', png),
    close: () => invoke('close'),
    settings: {
      get: () => invoke('settings_get'),
      setHotkey: (mode, accel) => invoke('settings_set_hotkey', { mode, accel }),
      setRecording: (on) => invoke('settings_recording', { on }),
      setOption: (name, on) => invoke('settings_set_option', { name, on }),
      link: (name) => invoke('settings_link', { name }),
    },
  };
})();
