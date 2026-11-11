// Stub of the Electron preload bridge (src/preload.ts) on top of Tauri's IPC.
// The bitmap travels as raw bytes (ipc::Response) or, on Windows, a WebView2 shared buffer. Never JSON.
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  let transferMs = 0;
  const report = (what) => invoke('log', { line: `js error: ${what}` });
  addEventListener('error', (e) => report(e.message));
  addEventListener('unhandledrejection', (e) => report(String(e.reason?.stack || e.reason)));
  const copy = (png) => {
    const t = performance.now();
    return invoke('copy', png).then(() => {
      invoke('log', { line: `copy ipc ${png.length >> 10} KB in ${Math.round(performance.now() - t)} ms` });
      return true;
    });
  };

  // The bitmap arrives one of two ways: pulled over IPC after 'capture:show', or (Windows) as a WebView2
  // shared buffer whose memory the page maps directly ('sharedbufferreceived', meta in additionalData).
  let onFrame = () => undefined;
  const show = (meta, bitmap) => {
    onFrame({ ...meta, bitmap, bgra: false });
    if (meta.bench) setTimeout(bench, 500);
  };
  listen('capture:show', async ({ payload: meta }) => {
    const t = performance.now();
    const buf = await invoke('bitmap');
    transferMs = Math.round(performance.now() - t);
    show(meta, new Uint8Array(buf));
  });
  // SPIKE_XFER: synthetic 4K frames, only timed (touch the last byte so the data is really there).
  listen('xfer:ipc', async () => {
    const buf = new Uint8Array(await invoke('bitmap'));
    invoke('xfer_done', { kind: 'ipc', bytes: buf[buf.length - 1] ? buf.length : 0 });
  });
  window.chrome?.webview?.addEventListener('sharedbufferreceived', (e) => {
    const buf = e.getBuffer();
    const meta = e.additionalData;
    if (meta.xfer) {
      const u8 = new Uint8Array(buf);
      invoke('xfer_done', { kind: 'shared', bytes: u8[u8.length - 1] ? u8.length : 0 });
    } else {
      transferMs = 0;
      show(meta, new Uint8Array(buf)); // paints synchronously (putImageData), so the buffer can go after
    }
    window.chrome.webview.releaseBuffer(buf);
  });

  window.api = {
    onCapture: (cb) => (onFrame = cb),
    onHidden: (cb) => listen('capture:hidden', () => cb()),
    onWindows: () => undefined, // window mode not ported
    ready: () => invoke('ready', { transferMs }),
    // Raw body: the PNG goes over IPC as bytes, not a JSON number array.
    copy,
    copyPaste: copy, // no auto-paste in the spike
    save: copy, // no Save dialog in the spike
    close: () => invoke('close'),
    settings: {},
  };

  // SPIKE_BENCH: select an area, draw a 2 s pen stroke with mouse events at 250 Hz (a fast gaming mouse),
  // then rect drags, then Enter (copy). Frame pacing comes from the mouseup probe below.
  const fire = (type, x, y) => (document.elementFromPoint(x, y) || document.body).dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1, bubbles: true }));
  const key = (k) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function stroke(x0, y0, x1, y1, ms, wobble) {
    fire('mousedown', x0, y0);
    const t0 = performance.now();
    let n = 0, worst = 0;
    while (performance.now() - t0 < ms) {
      const f = (performance.now() - t0) / ms;
      const s = performance.now();
      fire('mousemove', x0 + (x1 - x0) * f, y0 + (y1 - y0) * f + wobble * Math.sin(f * 40));
      worst = Math.max(worst, performance.now() - s);
      n++;
      await sleep(4);
    }
    fire('mouseup', x1, y1);
    return `${n} moves, slowest handler ${worst.toFixed(1)} ms`;
  }
  async function bench() {
    await stroke(100, 100, innerWidth - 100, innerHeight - 150, 300, 0); // selection, ~whole screen
    await sleep(200);
    key('p');
    invoke('log', { line: `pen: ${await stroke(200, 200, innerWidth - 300, innerHeight - 300, 2000, 150)}` });
    await sleep(200);
    key('r');
    invoke('log', { line: `rect: ${await stroke(300, 300, innerWidth - 400, innerHeight - 400, 2000, 100)}` });
    await sleep(300);
    invoke('log', { line: 'bench: Enter' });
    key('Enter');
    await sleep(5000);
    invoke('close'); // never leave the overlay up after a bench
  }

  // Drawing smoothness probe: logs frame pacing while the mouse button is held (pen strokes, drags).
  let last = 0, gaps = [], down = false;
  const tick = (t) => {
    if (!down) return;
    if (last) gaps.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };
  addEventListener('mousedown', () => { down = true; last = 0; gaps = []; requestAnimationFrame(tick); });
  addEventListener('mouseup', () => {
    down = false;
    if (gaps.length < 10) return;
    gaps.sort((a, b) => a - b);
    const p = (q) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))].toFixed(1);
    invoke('log', { line: `frames ${gaps.length} median ${p(0.5)} ms p95 ${p(0.95)} ms max ${p(1)} ms` });
  });
})();
