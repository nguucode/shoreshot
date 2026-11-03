// ShoreShot editor (renderer). Plain script, no imports, runs in the full-screen overlay.
// The overlay is preloaded and reused: main sends 'capture:show' per capture and 'capture:hidden' on close.
//
// Layers (bottom to top), so each mouse move only pays for what changed:
//   #bg     the screenshot, drawn once per capture.
//   #sel    dimming + selection frame as a CSS box-shadow: solid fills, never redraws the image.
//   #stage  committed shapes, sized to the selection, redrawn on undo/redo/text edits.
//   #draft  the shape being drawn, cleared and redrawn on every mouse move.

type Tool = 'rect' | 'ellipse' | 'line' | 'pen' | 'text';
interface Pt { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }
interface Edge { l: boolean; r: boolean; t: boolean; b: boolean }
interface RectShape { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; size: number }
interface EllipseShape { kind: 'ellipse'; x: number; y: number; w: number; h: number; color: string; size: number }
interface LineShape { kind: 'line'; x1: number; y1: number; x2: number; y2: number; color: string; size: number }
interface PenShape { kind: 'pen'; points: Pt[]; color: string; size: number }
interface TextShape { kind: 'text'; x: number; y: number; text: string; color: string; size: number }
type Shape = RectShape | EllipseShape | LineShape | PenShape | TextShape;

const SIZE_LIMITS: Record<Tool, [number, number]> = { rect: [1, 40], ellipse: [1, 40], line: [1, 40], pen: [1, 40], text: [10, 160] };
const SIZE_STEP: Record<Tool, number> = { rect: 1, ellipse: 1, line: 1, pen: 1, text: 2 };
const SIZE_LABEL: Record<Tool, string> = { rect: 'Border', ellipse: 'Border', line: 'Stroke', pen: 'Stroke', text: 'Font size' };
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const LINE_HEIGHT = 1.2;

const ed = {
  phase: 'loading' as 'loading' | 'selecting' | 'editing' | 'exporting',
  viewW: 0,
  viewH: 0,
  k: 1, // image pixels per CSS px
  retina1x: false, // export at 1x instead of native resolution (Settings)
  selection: null as Box | null,
  selStart: null as Pt | null,
  tool: 'rect' as Tool,
  color: '#ff3b30',
  sizes: { rect: 4, ellipse: 4, line: 4, pen: 4, text: 28 } as Record<Tool, number>,
  shapes: [] as Shape[],
  redo: [] as Shape[],
  draft: null as Shape | null,
  draftStart: null as Pt | null,
  textEdit: null as { x: number; y: number; original: TextShape | null } | null,
  wheelAcc: 0,
  enterPastes: false, // Enter / ✓ button = copy + auto-paste
  pendingPaste: false, // wait for all modifiers to be released before pasting
  hudTimer: 0 as number,
  barSize: null as { w: number; h: number } | null, // toolbar + hint have a fixed size, measured once
  resize: null as { edge: Edge; start: Box } | null, // dragging an edge/corner of the selection
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bg = $<HTMLCanvasElement>('bg');
const bgCtx = bg.getContext('2d')!;
const selEl = $<HTMLDivElement>('sel');
const stage = $<HTMLCanvasElement>('stage');
const ctx = stage.getContext('2d')!;
const draftCv = $<HTMLCanvasElement>('draft');
const draftCtx = draftCv.getContext('2d')!;
const actionsEl = $<HTMLDivElement>('actions'); // toolbar + hint, positioned together
const toolbarEl = $<HTMLDivElement>('toolbar');
const sizeBadge = $<HTMLDivElement>('sizeBadge');
const hud = $<HTMLDivElement>('hud');
const hint = $<HTMLDivElement>('hint');
const textInput = $<HTMLTextAreaElement>('textInput');
const colorInput = $<HTMLInputElement>('colorCustom');
const sizeReadout = $<HTMLSpanElement>('sizeReadout');
const btnUndo = $<HTMLButtonElement>('btnUndo');
const colorWrap = $('colorCustomWrap');

/** Shortcut modifier as shown on this OS: ⌘Z on Mac, Ctrl+Z on Windows. Tooltips use {mod} as a placeholder. */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';
document.querySelectorAll<HTMLElement>('[data-tip*="{mod}"]').forEach((el) => {
  el.dataset.tip = el.dataset.tip!.replace('{mod}', MOD);
});

// ---------- helpers ----------
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const norm = (b: Box): Box => ({
  x: b.w < 0 ? b.x + b.w : b.x,
  y: b.h < 0 ? b.y + b.h : b.y,
  w: Math.abs(b.w),
  h: Math.abs(b.h),
});
const inBox = (p: Pt, b: Box) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
const clampToSel = (p: Pt): Pt => {
  const s = norm(ed.selection!);
  return { x: clamp(p.x, s.x, s.x + s.w), y: clamp(p.y, s.y, s.y + s.h) };
};
const font = (size: number) => `600 ${size}px ${FONT_STACK}`;
const activeSizeTool = (): Tool => (ed.textEdit ? 'text' : ed.tool);
/** Exported pixels per CSS px: native, or 1 when "Export at 1x on Retina" is on. */
const outScale = () => (ed.retina1x ? 1 : ed.k);

const GRIP = 6; // px around the selection edges/corners that grab a resize
/** Which edge/corner of the selection point p is on (null if none). */
function hitEdge(p: Pt, s: Box): Edge | null {
  if (p.x < s.x - GRIP || p.x > s.x + s.w + GRIP || p.y < s.y - GRIP || p.y > s.y + s.h + GRIP) return null;
  const e = {
    l: Math.abs(p.x - s.x) <= GRIP,
    r: Math.abs(p.x - (s.x + s.w)) <= GRIP,
    t: Math.abs(p.y - s.y) <= GRIP,
    b: Math.abs(p.y - (s.y + s.h)) <= GRIP,
  };
  return e.l || e.r || e.t || e.b ? e : null;
}
const edgeCursor = (e: Edge) =>
  (e.l && e.t) || (e.r && e.b) ? 'nwse-resize'
  : (e.r && e.t) || (e.l && e.b) ? 'nesw-resize'
  : e.l || e.r ? 'ew-resize'
  : 'ns-resize';
const baseCursor = () => (ed.phase === 'editing' && ed.tool === 'text' ? 'text' : 'crosshair');
const place = (el: HTMLElement, b: Box) => {
  el.style.transform = `translate(${b.x}px, ${b.y}px)`;
  el.style.width = `${b.w}px`;
  el.style.height = `${b.h}px`;
};

/** Raw bitmap -> ImageData. RGBA is used as is; BGRA (Chromium, little-endian) gets R and B swapped. */
function toImageData(bitmap: Uint8Array, w: number, h: number, bgra: boolean): ImageData {
  if (!bgra) return new ImageData(new Uint8ClampedArray(bitmap.buffer as ArrayBuffer, bitmap.byteOffset, w * h * 4), w, h);
  const bytes = bitmap.byteOffset % 4 ? bitmap.slice() : bitmap; // Uint32Array needs a 4-byte aligned offset
  const src = new Uint32Array(bytes.buffer, bytes.byteOffset, w * h);
  const out = new ImageData(w, h);
  const dst = new Uint32Array(out.data.buffer);
  for (let i = 0; i < src.length; i++) {
    const p = src[i];
    dst[i] = (p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff);
  }
  return out;
}

// ---------- drawing ----------
function drawShape(c: CanvasRenderingContext2D, s: Shape): void {
  c.save();
  if (s.kind === 'rect') {
    const b = norm(s);
    c.strokeStyle = s.color;
    c.lineWidth = s.size;
    c.lineJoin = 'round';
    c.strokeRect(b.x, b.y, b.w, b.h);
  } else if (s.kind === 'ellipse') {
    const b = norm(s);
    c.strokeStyle = s.color;
    c.lineWidth = s.size;
    c.beginPath();
    c.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    c.stroke();
  } else if (s.kind === 'line') {
    c.strokeStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(s.x1, s.y1);
    c.lineTo(s.x2, s.y2);
    c.stroke();
  } else if (s.kind === 'pen') {
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const pts = s.points;
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, s.size / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      // Smooth the stroke with quadratic curves through midpoints.
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      c.lineTo(last.x, last.y);
      c.stroke();
    }
  } else {
    c.fillStyle = s.color;
    c.font = font(s.size);
    c.textBaseline = 'middle';
    const lh = s.size * LINE_HEIGHT;
    s.text.split('\n').forEach((line, i) => c.fillText(line, s.x, s.y + lh * i + lh / 2));
  }
  c.restore();
}

function textBounds(s: TextShape): Box {
  ctx.save();
  ctx.font = font(s.size);
  const lines = s.text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width));
  ctx.restore();
  return { x: s.x, y: s.y, w, h: lines.length * s.size * LINE_HEIGHT };
}

/** Selection frame, size badge, toolbar: style changes only, no canvas drawing. */
function layout(): void {
  if (ed.selection) {
    const s = norm(ed.selection);
    place(selEl, s);
    selEl.classList.remove('empty');
    sizeBadge.textContent = `${Math.round(s.w * outScale())} × ${Math.round(s.h * outScale())}`;
    sizeBadge.classList.remove('hidden');
    const by = s.y - 28 >= 4 ? s.y - 28 : s.y + 6;
    sizeBadge.style.transform = `translate(${Math.max(4, s.x)}px, ${by}px)`;
  } else {
    place(selEl, { x: 0, y: 0, w: 0, h: 0 }); // a 0×0 frame's box-shadow still dims the whole screen
    selEl.classList.add('empty');
    sizeBadge.classList.add('hidden');
  }
  positionToolbar();
}

function positionToolbar(): void {
  if (ed.phase !== 'editing' || !ed.selection) {
    actionsEl.classList.add('hidden');
    return;
  }
  actionsEl.classList.remove('hidden');
  ed.barSize ??= { w: actionsEl.offsetWidth, h: actionsEl.offsetHeight };
  const { w: tw, h: th } = ed.barSize;
  const s = norm(ed.selection);
  const gap = 8;
  let y = s.y + s.h + gap;
  if (y + th > ed.viewH - 4) y = s.y - th - gap;
  if (y < 4) y = s.y + s.h - th - gap;
  const x = clamp(s.x + s.w - tw, 4, ed.viewW - tw - 4);
  actionsEl.style.transform = `translate(${x}px, ${y}px)`;
  toolbarEl.classList.toggle('tips-below', y < 40);
}

/** Fit #stage and #draft to the selection (called on entering editing). Drawing coordinates stay in screen CSS px. */
function setupLayers(): void {
  const s = norm(ed.selection!);
  for (const [cv, c] of [[stage, ctx], [draftCv, draftCtx]] as const) {
    cv.width = Math.max(1, Math.round(s.w * ed.k));
    cv.height = Math.max(1, Math.round(s.h * ed.k));
    place(cv, s);
    cv.classList.remove('hidden');
    c.setTransform(ed.k, 0, 0, ed.k, -s.x * ed.k, -s.y * ed.k);
  }
}

function hideLayers(): void {
  for (const cv of [stage, draftCv]) {
    cv.classList.add('hidden');
    cv.width = cv.height = 1; // free the memory
  }
}

function clearLayer(c: CanvasRenderingContext2D): void {
  const s = norm(ed.selection!);
  c.clearRect(s.x, s.y, s.w, s.h);
}

/** Redraw every committed shape (undo/redo/text edit). A new shape is just drawn on top. */
function redrawShapes(): void {
  if (ed.phase !== 'editing') return;
  clearLayer(ctx);
  ed.shapes.forEach((sh) => drawShape(ctx, sh));
}

function drawDraft(): void {
  clearLayer(draftCtx);
  if (ed.draft) drawShape(draftCtx, ed.draft);
}

// ---------- UI state ----------
function syncToolbar(): void {
  toolbarEl.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === ed.tool),
  );
  toolbarEl.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) =>
    b.classList.toggle('active', b.dataset.color!.toLowerCase() === ed.color.toLowerCase()),
  );
  colorInput.value = ed.color;
  colorWrap.style.setProperty('--c', ed.color);
  const t = activeSizeTool();
  sizeReadout.textContent = `${SIZE_LABEL[t]} ${ed.sizes[t]}`;
  btnUndo.disabled = ed.shapes.length === 0;
  document.body.style.cursor = baseCursor();
}

function showHud(msg: string, x: number, y: number): void {
  hud.textContent = msg;
  hud.classList.remove('hidden');
  hud.style.transform = `translate(${clamp(x + 18, 4, ed.viewW - 160)}px, ${clamp(y + 18, 4, ed.viewH - 40)}px)`;
  window.clearTimeout(ed.hudTimer);
  ed.hudTimer = window.setTimeout(() => hud.classList.add('hidden'), 700);
}

function setTool(t: Tool): void {
  commitText();
  ed.tool = t;
  syncToolbar();
}

function setColor(c: string): void {
  ed.color = c;
  if (ed.textEdit) textInput.style.color = c;
  if (ed.draft) {
    ed.draft.color = c;
    drawDraft();
  }
  syncToolbar();
}

function pushShape(s: Shape): void {
  ed.shapes.push(s);
  ed.redo = [];
  drawShape(ctx, s);
  syncToolbar();
}

// ---------- text ----------
function openText(x: number, y: number, original: TextShape | null): void {
  ed.textEdit = { x, y, original };
  if (original) {
    ed.color = original.color;
    ed.sizes.text = original.size;
    redrawShapes(); // the old text was taken out of shapes to edit in the input
  }
  textInput.value = original?.text ?? '';
  textInput.classList.remove('hidden');
  textInput.style.left = `${x}px`;
  textInput.style.top = `${y}px`;
  applyTextStyle();
  syncToolbar();
  requestAnimationFrame(() => textInput.focus());
}

function applyTextStyle(): void {
  const size = ed.sizes.text;
  textInput.style.font = font(size);
  textInput.style.lineHeight = String(LINE_HEIGHT);
  textInput.style.color = ed.color;
  autosizeText();
}

function autosizeText(): void {
  if (!ed.textEdit) return;
  const s = norm(ed.selection!);
  textInput.style.width = '1px';
  textInput.style.height = '1px';
  const maxW = s.x + s.w - ed.textEdit.x;
  textInput.style.width = `${Math.min(Math.max(textInput.scrollWidth + 4, ed.sizes.text), Math.max(maxW, 40))}px`;
  textInput.style.height = `${textInput.scrollHeight}px`;
}

function commitText(): void {
  if (!ed.textEdit) return;
  const text = textInput.value.replace(/\s+$/, '');
  const { x, y } = ed.textEdit;
  ed.textEdit = null;
  textInput.classList.add('hidden');
  textInput.blur();
  if (text.trim()) pushShape({ kind: 'text', x, y, text, color: ed.color, size: ed.sizes.text });
  syncToolbar();
}

function cancelText(): void {
  if (!ed.textEdit) return;
  const original = ed.textEdit.original;
  ed.textEdit = null;
  textInput.classList.add('hidden');
  if (original) {
    ed.shapes.push(original); // restore the original text when editing was cancelled
    drawShape(ctx, original);
  }
  syncToolbar();
}

function hitText(p: Pt): number {
  for (let i = ed.shapes.length - 1; i >= 0; i--) {
    const s = ed.shapes[i];
    if (s.kind === 'text' && inBox(p, textBounds(s))) return i;
  }
  return -1;
}

// ---------- actions ----------
function undo(): void {
  if (ed.textEdit) return cancelText();
  const s = ed.shapes.pop();
  if (s) ed.redo.push(s);
  syncToolbar();
  redrawShapes();
}
function redoAction(): void {
  const s = ed.redo.pop();
  if (!s) return;
  ed.shapes.push(s);
  drawShape(ctx, s);
  syncToolbar();
}

/** PNG of the selection at native resolution. toBlob encodes off the main thread, so the UI doesn't freeze. */
async function exportPNG(): Promise<Uint8Array> {
  commitText();
  const s = norm(ed.selection!);
  const k = outScale();
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(s.w * k));
  out.height = Math.max(1, Math.round(s.h * k));
  const c = out.getContext('2d')!;
  c.imageSmoothingQuality = 'high'; // matters when downscaling for the 1x option
  c.drawImage(bg, s.x * ed.k, s.y * ed.k, s.w * ed.k, s.h * ed.k, 0, 0, out.width, out.height);
  c.setTransform(k, 0, 0, k, -s.x * k, -s.y * k);
  ed.shapes.forEach((sh) => drawShape(c, sh));
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not export the image');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Export the image and send it to main (copy / copyPaste / save); main hides the overlay when done. */
async function act(send: (png: Uint8Array) => Promise<boolean>): Promise<void> {
  if (ed.phase !== 'editing') return;
  ed.phase = 'exporting'; // block a second trigger while encoding
  let ok = false;
  try {
    const png = await exportPNG();
    // Esc during encoding: the overlay was hidden and reset, drop this image.
    if (ed.phase === 'exporting') ok = await send(png);
  } finally {
    // Save dialog cancelled (or an error): back to editing. If main hid the overlay, reset() already changed phase.
    if (!ok && ed.phase === 'exporting') ed.phase = 'editing';
  }
}

const modsHeld = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

/** Paste via shortcut: wait until Ctrl/⌘/Shift/Alt are released so the synthetic ⌘V/Ctrl+V doesn't mix with held keys. */
function requestPaste(e?: KeyboardEvent): void {
  if (e && modsHeld(e)) {
    ed.pendingPaste = true;
    return;
  }
  void act(window.api.copyPaste);
}

/** Primary action (Enter, ✓ button) and secondary action, per the setting. */
function primaryAction(e?: KeyboardEvent): void {
  if (ed.enterPastes) requestPaste(e);
  else void act(window.api.copy);
}
function secondaryAction(): void {
  if (ed.enterPastes) void act(window.api.copy);
  else requestPaste();
}

function startSelecting(p: Pt): void {
  ed.phase = 'selecting';
  ed.shapes = [];
  ed.redo = [];
  ed.selStart = p;
  ed.selection = { x: p.x, y: p.y, w: 0, h: 0 };
  hint.classList.add('hidden');
  hideLayers();
}

// ---------- pointer ----------
const pt = (e: MouseEvent): Pt => ({ x: e.clientX, y: e.clientY });
const onToolbar = (e: MouseEvent) => !!(e.target as Element).closest('#toolbar');

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || onToolbar(e)) return;
  const p = pt(e);
  if (ed.phase === 'selecting') {
    startSelecting(p);
    layout();
    return;
  }
  if (ed.phase !== 'editing' || !ed.selection) return;
  const sel = norm(ed.selection);

  const edge = hitEdge(p, sel);
  if (edge) {
    commitText();
    ed.resize = { edge, start: sel };
    return;
  }

  if (!inBox(p, sel)) {
    commitText();
    // Nothing drawn yet: allow selecting a new region.
    if (ed.shapes.length === 0) {
      startSelecting(p);
      layout();
      syncToolbar();
    }
    return;
  }

  if (ed.tool === 'text') {
    if (ed.textEdit) {
      commitText();
      return;
    }
    const idx = hitText(p);
    if (idx >= 0) {
      const [orig] = ed.shapes.splice(idx, 1) as TextShape[];
      openText(orig.x, orig.y, orig);
    } else {
      openText(p.x, p.y - (ed.sizes.text * LINE_HEIGHT) / 2, null);
    }
    e.preventDefault();
    return;
  }

  commitText();
  ed.draftStart = p;
  const style = { color: ed.color, size: ed.sizes[ed.tool] };
  ed.draft =
    ed.tool === 'pen' ? { kind: 'pen', points: [p], ...style }
    : ed.tool === 'line' ? { kind: 'line', x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...style }
    : { kind: ed.tool === 'ellipse' ? 'ellipse' : 'rect', x: p.x, y: p.y, w: 0, h: 0, ...style };
  drawDraft();
});

window.addEventListener('mousemove', (e) => {
  const p = pt(e);
  if (ed.phase === 'selecting' && ed.selStart && ed.selection) {
    const q = { x: clamp(p.x, 0, ed.viewW), y: clamp(p.y, 0, ed.viewH) };
    ed.selection = { x: ed.selStart.x, y: ed.selStart.y, w: q.x - ed.selStart.x, h: q.y - ed.selStart.y };
    layout();
    return;
  }
  if (ed.resize) {
    // Resize: move only the grabbed edges; dragging past the opposite edge flips (norm handles it).
    const { edge, start: s } = ed.resize;
    const q = { x: clamp(p.x, 0, ed.viewW), y: clamp(p.y, 0, ed.viewH) };
    const x1 = edge.l ? q.x : s.x;
    const x2 = edge.r ? q.x : s.x + s.w;
    const y1 = edge.t ? q.y : s.y;
    const y2 = edge.b ? q.y : s.y + s.h;
    ed.selection = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    layout();
    return;
  }
  if (ed.phase === 'editing' && !ed.draft && ed.selection) {
    const edge = hitEdge(p, norm(ed.selection));
    document.body.style.cursor = edge ? edgeCursor(edge) : baseCursor();
  }
  if (ed.draft && ed.draftStart) {
    const q = clampToSel(p);
    const d = ed.draft;
    if (d.kind === 'rect' || d.kind === 'ellipse') {
      let w = q.x - ed.draftStart.x;
      let h = q.y - ed.draftStart.y;
      if (e.shiftKey) {
        // Shift: square / circle.
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = (Math.sign(w) || 1) * m;
        h = (Math.sign(h) || 1) * m;
      }
      d.w = w;
      d.h = h;
    } else if (d.kind === 'line') {
      d.x2 = q.x;
      d.y2 = q.y;
    } else if (ed.draft.kind === 'pen') {
      ed.draft.points.push(q);
    }
    drawDraft();
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (ed.phase === 'selecting' && ed.selStart) {
    let s = norm(ed.selection!);
    // Click without dragging = whole screen.
    if (s.w < 5 || s.h < 5) s = { x: 0, y: 0, w: ed.viewW, h: ed.viewH };
    ed.selection = s;
    ed.selStart = null;
    ed.phase = 'editing';
    setupLayers();
    syncToolbar();
    layout();
    return;
  }
  if (ed.resize) {
    const s = norm(ed.selection!);
    ed.selection = s.w < 5 || s.h < 5 ? ed.resize.start : s; // too small: keep the previous frame
    ed.resize = null;
    setupLayers();
    redrawShapes(); // shapes keep their screen position and are clipped to the new frame
    layout();
    return;
  }
  if (ed.draft) {
    const d = ed.draft;
    ed.draft = null;
    ed.draftStart = null;
    drawDraft();
    const keep =
      d.kind === 'rect' || d.kind === 'ellipse' ? Math.abs(d.w) > 2 && Math.abs(d.h) > 2
      : d.kind === 'line' ? Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 2
      : d.kind === 'pen';
    if (keep) pushShape(d);
  }
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (onToolbar(e) || e.target === textInput) return;
  if (ed.textEdit) return cancelText();
  if (ed.phase === 'editing' && ed.shapes.length === 0) {
    // Right-click before drawing: drop the selection and select again.
    ed.phase = 'selecting';
    ed.selection = null;
    hint.classList.remove('hidden');
    hideLayers();
    syncToolbar();
    layout();
  } else if (ed.phase === 'selecting' && !ed.selStart) {
    window.api.close();
  }
});

// ---------- wheel: border width, stroke width, font size ----------
window.addEventListener(
  'wheel',
  (e) => {
    if (ed.phase !== 'editing') return;
    e.preventDefault();
    let dir = 0;
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50) {
      dir = Math.sign(e.deltaY); // notched mouse wheel
      ed.wheelAcc = 0;
    } else {
      ed.wheelAcc += e.deltaY; // trackpad: accumulate so it doesn't jump too fast
      if (Math.abs(ed.wheelAcc) >= 50) {
        dir = Math.sign(ed.wheelAcc);
        ed.wheelAcc = 0;
      }
    }
    if (!dir) return;
    const t = activeSizeTool();
    const [min, max] = SIZE_LIMITS[t];
    // Scroll up = bigger, scroll down = smaller.
    ed.sizes[t] = clamp(ed.sizes[t] - dir * SIZE_STEP[t], min, max);
    if (ed.draft && ed.draft.kind === t) {
      ed.draft.size = ed.sizes[t];
      drawDraft();
    }
    if (ed.textEdit) applyTextStyle();
    showHud(`${SIZE_LABEL[t]}: ${ed.sizes[t]}px`, e.clientX, e.clientY);
    syncToolbar();
  },
  { passive: false },
);

// ---------- keyboard ----------
textInput.addEventListener('input', autosizeText);
textInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelText();
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    commitText();
  }
});
textInput.addEventListener('mousedown', (e) => e.stopPropagation());

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') return window.api.close();
  if (ed.phase !== 'editing') return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
  if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) { e.preventDefault(); return redoAction(); }
  // ⌘V / Ctrl+V (with or without Shift) = copy + auto-paste into the previous app.
  if (mod && k === 'v') { e.preventDefault(); return requestPaste(e); }
  if (mod && k === 'c') { e.preventDefault(); void act(window.api.copy); return; }
  if (mod && k === 's') { e.preventDefault(); void act(window.api.save); return; }
  if (e.key === 'Enter') { e.preventDefault(); return primaryAction(e); }
  if (mod) return;
  if (k === 'r') setTool('rect');
  else if (k === 'o') setTool('ellipse');
  else if (k === 'l') setTool('line');
  else if (k === 'p') setTool('pen');
  else if (k === 't') setTool('text');
});

window.addEventListener('keyup', (e) => {
  if (ed.pendingPaste && !modsHeld(e)) {
    ed.pendingPaste = false;
    void act(window.api.copyPaste);
  }
});

// ---------- toolbar ----------
toolbarEl.addEventListener('mousedown', (e) => {
  // Don't let the toolbar steal focus from the text input (except the color picker).
  if (!(e.target as HTMLElement).closest('#colorCustomWrap')) e.preventDefault();
});
toolbarEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.tool) setTool(btn.dataset.tool as Tool);
  else if (btn.dataset.color) setColor(btn.dataset.color);
  else if (btn.id === 'btnUndo') undo();
  else if (btn.id === 'btnSave') void act(window.api.save);
  else if (btn.id === 'btnPrimary') primaryAction();
  else if (btn.id === 'btnSecondary') secondaryAction();
  else if (btn.id === 'btnClose') window.api.close();
});
colorInput.addEventListener('input', () => setColor(colorInput.value));
colorInput.addEventListener('change', () => {
  if (ed.textEdit) textInput.focus();
});

// ---------- overlay lifecycle ----------
const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON_PASTE = '<svg viewBox="0 0 24 24"><path d="M9 4h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v3M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 16h7M18 13l3 3-3 3"/></svg>';

function setupActionButtons(): void {
  const m = MOD;
  const copyTitle = `Copy to clipboard (${m}C)`;
  const pasteTitle = `Copy and paste into the previous app (${m}V)`;
  const primary = $<HTMLButtonElement>('btnPrimary');
  const secondary = $<HTMLButtonElement>('btnSecondary');
  primary.dataset.tip = `${ed.enterPastes ? pasteTitle : copyTitle} · Enter`;
  secondary.dataset.tip = ed.enterPastes ? copyTitle : pasteTitle;
  $('pasteHint').innerHTML = `<kbd>${m}C</kbd> to copy · <kbd>${m}V</kbd> to paste`;
  secondary.setAttribute('aria-label', ed.enterPastes ? 'Copy' : 'Copy and paste');
  secondary.innerHTML = ed.enterPastes ? ICON_COPY : ICON_PASTE;
}

/** Back to idle and free the image memory. Tool, color and sizes carry over between captures. */
function reset(): void {
  ed.phase = 'loading';
  ed.selection = ed.selStart = ed.draft = ed.draftStart = ed.textEdit = ed.resize = null;
  ed.shapes = [];
  ed.redo = [];
  ed.pendingPaste = false;
  textInput.classList.add('hidden');
  hud.classList.add('hidden');
  hint.classList.remove('hidden');
  hideLayers();
  bg.width = bg.height = 1;
  layout();
}

window.api.onCapture((cap) => {
  reset();
  ed.viewW = cap.width;
  ed.viewH = cap.height;
  ed.k = cap.pxW / cap.width;
  ed.enterPastes = cap.enterPastes;
  ed.retina1x = cap.retina1x;
  setupActionButtons();
  bg.width = cap.pxW;
  bg.height = cap.pxH;
  bgCtx.putImageData(toImageData(cap.bitmap, cap.pxW, cap.pxH, cap.bgra), 0, 0);
  ed.phase = 'selecting';
  syncToolbar();
  layout();
  // Main shows the window transparent first; wait 2 frames for the new image, then reveal it.
  // macOS may treat an opacity-0 window as occluded and pause frames, so report after 100 ms regardless.
  let sent = false;
  const ready = () => {
    if (sent) return;
    sent = true;
    window.api.ready();
  };
  requestAnimationFrame(() => requestAnimationFrame(ready));
  setTimeout(ready, 100);
});
window.api.onHidden(reset);
