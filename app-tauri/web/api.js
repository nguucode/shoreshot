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

  // Windows: Windows.Media.Ocr has no Vietnamese recognizer on any machine, so the page reads the text itself
  // with tesseract.js (dist/tesseract, bundled by build-web.sh, offline). The worker starts with the first scan
  // and stays. If it fails, the scan falls back to the system's OCR. Vietnamese data only: it reads English
  // as well, and with English loaded too, capitals lose their marks (THÁNG comes out as THANG).
  let reader;
  let busy = false;
  const tesseract = () =>
    (reader ??= (async () => {
      const base = new URL('tesseract/', location.href).href;
      await new Promise((ok, no) => {
        const script = document.createElement('script');
        script.src = `${base}tesseract.min.js`;
        script.onload = ok;
        script.onerror = () => no(new Error('tesseract.js did not load'));
        document.head.append(script);
      });
      return Tesseract.createWorker('vie', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        cacheMethod: 'none',
      });
    })().catch((e) => {
      reader = undefined;
      throw e;
    }));
  const readText = async (png) => {
    // A scan the page gave up on (Esc, a new selection, its timeout) still occupies the worker: start a new one.
    if (busy) (await reader?.catch(() => {}))?.terminate();
    if (busy) reader = undefined;
    busy = true;
    const worker = await tesseract();
    const image = await createImageBitmap(new Blob([png], { type: 'image/png' }));
    // Screen text is small for Tesseract (it wants capitals around 30 px): enlarge it, up to 2x.
    // ponytail: fixed scale and size cap; pick the scale from the measured text height if small text misreads.
    const k = Math.max(1, Math.min(2, 4000 / Math.max(image.width, image.height)));
    const canvas = new OffscreenCanvas(Math.round(image.width * k), Math.round(image.height * k));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Soft text (a photo, a compressed or scaled picture) loses its marks: sharpen it, as an unsharp mask.
    // Gently: at twice this amount, large crisp text misreads ("Specs" came out as "SDecs").
    const soft = new OffscreenCanvas(canvas.width, canvas.height);
    const softCtx = soft.getContext('2d', { willReadFrequently: true });
    softCtx.filter = 'blur(2px)';
    softCtx.drawImage(canvas, 0, 0);
    const sharp = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const blurred = softCtx.getImageData(0, 0, canvas.width, canvas.height).data;
    const px = sharp.data; // a Uint8ClampedArray: out-of-range values clamp
    for (let i = 0; i < px.length; i++) if (i % 4 !== 3) px[i] += px[i] - blurred[i];
    ctx.putImageData(sharp, 0, 0);
    const { data } = await worker.recognize(await canvas.convertToBlob(), {}, { text: false, blocks: true });
    busy = false;
    const lines = (data.blocks ?? []).flatMap((block) => block.paragraphs).flatMap((paragraph) => paragraph.lines);
    let words = lines.flatMap((line) => line.words);
    // A picture: its shapes come out as scraps the engine is unsure of. When a quarter of the words are like
    // that, keep only the lines with real text in them (two sure words of two letters or digits at least).
    // ponytail: thresholds from a handful of test pictures; a label of one word on a picture is dropped.
    const sure = (word) => word.confidence >= 70 && (word.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2;
    if (words.filter((word) => word.confidence < 50).length * 4 > words.length) {
      words = lines
        .filter((line) => line.words.filter(sure).length >= 2)
        .flatMap((line) => line.words.filter((word) => word.confidence >= 50));
    }
    return words.map(({ text, bbox: b }) => ({ t: text, x: b.x0 / k, y: b.y0 / k, w: (b.x1 - b.x0) / k, h: (b.y1 - b.y0) / k }));
  };
  const ocr = navigator.userAgent.includes('Windows')
    ? (png) =>
        readText(png).catch((e) => {
          report(`tesseract: ${e?.message || e}`);
          return invoke('ocr', png);
        })
    : (png) => invoke('ocr', png);

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
    ocr,
    copyText: (text, paste) => invoke('copy_text', { text, paste }),
    translate: (text, to) => invoke('translate', { text, to }),
    settings: {
      get: () => invoke('settings_get'),
      setHotkey: (mode, accel) => invoke('settings_set_hotkey', { mode, accel }),
      setRecording: (on) => invoke('settings_recording', { on }),
      setOption: (name, on) => invoke('settings_set_option', { name, on }),
      link: (name) => invoke('settings_link', { name }),
    },
  };
})();
