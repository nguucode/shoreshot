// ShoreShot editor (renderer). Plain script, no imports, runs in the full-screen overlay.
// The overlay is preloaded and reused: main sends 'capture:show' per capture and 'capture:hidden' on close.
//
// Layers (bottom to top), so each mouse move only pays for what changed:
//   #bg     the screenshot, drawn once per capture.
//   #sel    dimming + selection frame as a CSS box-shadow: solid fills, never redraws the image.
//   #stage  committed shapes, sized to the selection, redrawn on undo/redo/text edits.
//   #draft  the shape being drawn, cleared and redrawn on every mouse move.

type Tool = 'rect' | 'ellipse' | 'line' | 'arrow' | 'pen' | 'text';
interface Pt { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }
interface Edge { l: boolean; r: boolean; t: boolean; b: boolean }
interface RectShape { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; size: number }
interface EllipseShape { kind: 'ellipse'; x: number; y: number; w: number; h: number; color: string; size: number }
interface LineShape { kind: 'line'; arrow?: boolean; x1: number; y1: number; x2: number; y2: number; color: string; size: number }
interface PenShape { kind: 'pen'; points: Pt[]; color: string; size: number }
interface TextShape { kind: 'text'; x: number; y: number; text: string; color: string; size: number }
type Shape = RectShape | EllipseShape | LineShape | PenShape | TextShape;

const SIZE_LIMITS: Record<Tool, [number, number]> = { rect: [1, 40], ellipse: [1, 40], line: [1, 40], arrow: [1, 40], pen: [1, 40], text: [10, 160] };
const SIZE_STEP: Record<Tool, number> = { rect: 1, ellipse: 1, line: 1, arrow: 1, pen: 1, text: 2 };
const SIZE_LABEL: Record<Tool, string> = { rect: 'Border', ellipse: 'Border', line: 'Stroke', arrow: 'Stroke', pen: 'Stroke', text: 'Font size' };
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const LINE_HEIGHT = 1.2;
const TEXT_PAD = 8; // frame around the text being typed: drag it to move the text

const ed = {
  // text: copy-text mode with a selection, waiting for ⌘C / ⌘V
  phase: 'loading' as 'loading' | 'selecting' | 'editing' | 'text' | 'exporting',
  mode: 'area' as ShoreShotMode,
  scan: null as Promise<string> | null, // copy-text mode: the text being read from the selection
  viewW: 0,
  viewH: 0,
  k: 1, // image pixels per CSS px
  retina1x: false, // export at 1x instead of native resolution (Settings)
  selection: null as Box | null,
  selStart: null as Pt | null,
  tool: 'rect' as Tool,
  color: '#ff3b30',
  sizes: { rect: 4, ellipse: 4, line: 4, arrow: 4, pen: 4, text: 28 } as Record<Tool, number>,
  shapes: [] as Shape[],
  undo: [] as Shape[][], // earlier versions of shapes (each change replaces the array)
  redo: [] as Shape[][],
  hover: null as Shape | null, // committed shape under the mouse: Delete / right-click removes it
  draft: null as Shape | null,
  draftStart: null as Pt | null,
  // before: shapes when editing started; index: the text being edited in it (-1 = new text).
  textEdit: null as { x: number; y: number; before: Shape[]; index: number } | null,
  wheelAcc: 0,
  pendingPaste: false, // wait for all modifiers to be released before pasting
  hudTimer: 0 as number,
  barSize: null as { w: number; h: number } | null, // the bars have a fixed size, measured once
  hintSize: null as { w: number; h: number } | null,
  resize: null as { edge: Edge; start: Box } | null, // dragging an edge/corner of the selection
  textMove: null as Pt | null, // dragging the text box by its frame: offset from its top-left
  windows: [] as Box[], // window capture: window frames, front to back (empty otherwise)
  mouse: { x: 0, y: 0 } as Pt,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const bg = $<HTMLCanvasElement>('bg');
const bgCtx = bg.getContext('2d')!;
const selEl = $<HTMLDivElement>('sel');
const stage = $<HTMLCanvasElement>('stage');
const ctx = stage.getContext('2d')!;
const draftCv = $<HTMLCanvasElement>('draft');
const draftCtx = draftCv.getContext('2d')!;
const actionsEl = $<HTMLDivElement>('actions'); // tools bar + action bar, positioned together
const toolbarEl = $<HTMLDivElement>('toolbar');
const pasteHint = $<HTMLDivElement>('pasteHint');
const translateHint = $<HTMLSpanElement>('translateHint');
const sizeBadge = $<HTMLDivElement>('sizeBadge');
const hud = $<HTMLDivElement>('hud');
const hint = $<HTMLDivElement>('hint');
const textInput = $<HTMLTextAreaElement>('textInput');
const colorInput = $<HTMLInputElement>('colorCustom');
const sizeReadout = $<HTMLSpanElement>('sizeReadout');
const btnUndo = $<HTMLButtonElement>('btnUndo');
const colorWrap = $('colorCustomWrap');
const HINT = hint.textContent!;
const WINDOW_HINT = 'Click a window · Drag to select an area · Esc to exit';
const TEXT_HINT = 'Drag over the text to copy · Click for the whole screen · Esc to exit';
const SCAN_TIMEOUT = 5000; // ms: the overlay never waits longer than this for the OCR

/** Shortcut modifier as shown on this OS: ⌘Z on Mac, Ctrl+Z on Windows. Tooltips and the hint use {mod}. */
const MOD = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';
const MOD_DEL = MOD === '⌘' ? '⌫' : 'Delete';
document.querySelectorAll<HTMLElement>('[data-tip*="{mod}"]').forEach((el) => {
  el.dataset.tip = el.dataset.tip!.replace('{mod}', MOD);
});
pasteHint.querySelectorAll('kbd').forEach((k) => (k.textContent = k.textContent!.replace('{mod}', MOD)));

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
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = s.arrow ? Math.max(12, s.size * 3 + 8) : 0;
    const back = Math.min(head * 0.8, Math.hypot(s.x2 - s.x1, s.y2 - s.y1)); // stop the shaft inside the head so the round cap never pokes past the tip
    c.beginPath();
    c.moveTo(s.x1, s.y1);
    c.lineTo(s.x2 - Math.cos(a) * back, s.y2 - Math.sin(a) * back);
    c.stroke();
    if (s.arrow) {
      const w = 0.45; // half-angle of the head, ~26°
      c.fillStyle = s.color;
      c.beginPath();
      c.moveTo(s.x2, s.y2);
      c.lineTo(s.x2 - head * Math.cos(a - w), s.y2 - head * Math.sin(a - w));
      c.lineTo(s.x2 - head * Math.cos(a + w), s.y2 - head * Math.sin(a + w));
      c.closePath();
      c.fill();
    }
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
  // Copy-text mode has no bars, only the copy/paste hint.
  const bars = ed.phase === 'editing' && !!ed.selection;
  const hinted = bars || (ed.phase === 'text' && !!ed.selection);
  actionsEl.classList.toggle('hidden', !bars);
  pasteHint.classList.toggle('hidden', !hinted);
  if (!hinted) return;
  ed.hintSize ??= { w: pasteHint.offsetWidth, h: pasteHint.offsetHeight };
  const s = norm(ed.selection!);
  const gap = 8;
  let x = Infinity; // left edge of the bars
  if (bars) {
    ed.barSize ??= { w: actionsEl.offsetWidth, h: actionsEl.offsetHeight };
    const { w: tw, h: th } = ed.barSize;
    // Bars to the right of the selection; else to its left; else inside its right edge. Bottom-aligned with it.
    x = s.x + s.w + gap;
    if (x + tw > ed.viewW - 4) x = s.x - tw - gap;
    if (x < 4) x = s.x + s.w - tw - gap;
    x = clamp(x, 4, ed.viewW - tw - 4);
    const y = clamp(s.y + s.h - th, 4, ed.viewH - th - 4);
    actionsEl.style.transform = `translate(${x}px, ${y}px)`;
    actionsEl.classList.toggle('tips-left', x + tw + 240 > ed.viewW);
  }
  // Copy/paste hint: under the selection, right-aligned; inside its bottom edge when there's no room below.
  const { w: hw, h: hh } = ed.hintSize;
  let hy = s.y + s.h + gap;
  if (hy + hh > ed.viewH - 4) hy = s.y + s.h - hh - gap;
  let hx = s.x + s.w - hw;
  if (hy < s.y + s.h && x < s.x + s.w) hx = x - hw - gap; // both inside the frame: hint left of the bars
  hx = clamp(hx, 4, ed.viewW - hw - 4);
  pasteHint.style.transform = `translate(${hx}px, ${hy}px)`;
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

/** The shape being drawn, or a dashed frame around the hovered shape. */
function drawDraft(): void {
  clearLayer(draftCtx);
  if (ed.draft) drawShape(draftCtx, ed.draft);
  else if (ed.hover) {
    const b = shapeBounds(ed.hover);
    const pad = (ed.hover.kind === 'text' ? 0 : ed.hover.size / 2) + 4;
    draftCtx.save();
    draftCtx.strokeStyle = '#3b82f6';
    draftCtx.lineWidth = 1.5;
    draftCtx.setLineDash([5, 4]);
    draftCtx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
    draftCtx.restore();
  }
}

function shapeBounds(s: Shape): Box {
  if (s.kind === 'rect' || s.kind === 'ellipse') return norm(s);
  if (s.kind === 'text') return textBounds(s);
  const xs = s.kind === 'line' ? [s.x1, s.x2] : s.points.map((q) => q.x);
  const ys = s.kind === 'line' ? [s.y1, s.y2] : s.points.map((q) => q.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Distance from p to the segment a-b. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = dx || dy ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Whether p is on the shape: on its stroke (rect, ellipse, line, pen) or inside it (text). */
function onShape(p: Pt, s: Shape): boolean {
  if (s.kind === 'text') return inBox(p, textBounds(s));
  const tol = s.size / 2 + 4;
  if (s.kind === 'line') return segDist(p, { x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }) <= tol;
  if (s.kind === 'pen') return s.points.some((q, i) => segDist(p, q, s.points[i + 1] ?? q) <= tol);
  const b = norm(s);
  if (s.kind === 'rect') {
    const outer = { x: b.x - tol, y: b.y - tol, w: b.w + 2 * tol, h: b.h + 2 * tol };
    const inner = { x: b.x + tol, y: b.y + tol, w: b.w - 2 * tol, h: b.h - 2 * tol };
    return inBox(p, outer) && !(inner.w > 0 && inner.h > 0 && inBox(p, inner));
  }
  // Ellipse: radial distance from the outline, scaled to px by the smaller radius.
  const rx = Math.max(b.w / 2, 1);
  const ry = Math.max(b.h / 2, 1);
  const d = Math.hypot((p.x - b.x - rx) / rx, (p.y - b.y - ry) / ry);
  return Math.abs(d - 1) * Math.min(rx, ry) <= tol;
}

/** Topmost committed shape under p. */
function hitShape(p: Pt): Shape | null {
  for (let i = ed.shapes.length - 1; i >= 0; i--) if (onShape(p, ed.shapes[i])) return ed.shapes[i];
  return null;
}

function setHover(s: Shape | null): void {
  if (s === ed.hover) return;
  ed.hover = s;
  drawDraft();
  if (s) {
    const b = shapeBounds(s);
    hud.textContent = `${MOD_DEL} or right-click to delete`;
    hud.classList.remove('hidden');
    hud.style.transform = `translate(${clamp(b.x, 4, ed.viewW - 220)}px, ${clamp(b.y + b.h + 10, 4, ed.viewH - 30)}px)`;
    window.clearTimeout(ed.hudTimer);
  } else {
    hud.classList.add('hidden');
  }
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
  sizeReadout.textContent = String(ed.sizes[t]);
  sizeReadout.dataset.tip = `${SIZE_LABEL[t]} ${ed.sizes[t]}px · scroll to change`;
  btnUndo.disabled = ed.undo.length === 0;
  document.body.style.cursor = baseCursor();
}

function showHud(msg: string, x: number, y: number, ms = 700): void {
  hud.textContent = msg;
  hud.classList.remove('hidden');
  hud.style.transform = `translate(${clamp(x + 18, 4, ed.viewW - 160)}px, ${clamp(y + 18, 4, ed.viewH - 40)}px)`;
  window.clearTimeout(ed.hudTimer);
  ed.hudTimer = window.setTimeout(() => hud.classList.add('hidden'), ms);
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

/** Replace the shapes with a new version, keeping the old one for undo. */
function setShapes(next: Shape[]): void {
  ed.undo.push(ed.shapes);
  ed.redo = [];
  ed.shapes = next;
  setHover(null);
  redrawShapes();
  syncToolbar();
}

function pushShape(s: Shape): void {
  ed.undo.push(ed.shapes);
  ed.redo = [];
  ed.shapes = [...ed.shapes, s];
  drawShape(ctx, s); // on top: no full redraw
  syncToolbar();
}

function deleteShape(s: Shape): void {
  setShapes(ed.shapes.filter((x) => x !== s));
}

// ---------- text ----------
function openText(x: number, y: number, index: number): void {
  const original = index >= 0 ? (ed.shapes[index] as TextShape) : null;
  ed.textEdit = { x, y, before: ed.shapes, index };
  setHover(null);
  if (original) {
    ed.color = original.color;
    ed.sizes.text = original.size;
    ed.shapes = ed.shapes.filter((_, i) => i !== index); // shown in the input while editing
    redrawShapes();
  }
  textInput.value = original?.text ?? '';
  textInput.classList.remove('hidden');
  placeText();
  applyTextStyle();
  syncToolbar();
  requestAnimationFrame(() => textInput.focus());
}

/** The textarea's padding is the draggable frame, so the text itself sits at (x, y). */
function placeText(): void {
  textInput.style.left = `${ed.textEdit!.x - TEXT_PAD}px`;
  textInput.style.top = `${ed.textEdit!.y - TEXT_PAD}px`;
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
  const maxW = s.x + s.w - ed.textEdit.x + 2 * TEXT_PAD;
  textInput.style.width = `${Math.min(Math.max(textInput.scrollWidth + 4, ed.sizes.text + 2 * TEXT_PAD), Math.max(maxW, 40))}px`;
  textInput.style.height = `${textInput.scrollHeight}px`;
}

function commitText(): void {
  if (!ed.textEdit) return;
  const text = textInput.value.replace(/\s+$/, '');
  const { x, y, before, index } = ed.textEdit;
  ed.textEdit = null;
  ed.textMove = null;
  textInput.classList.add('hidden');
  textInput.blur();
  ed.shapes = before;
  const shape: TextShape = { kind: 'text', x, y, text, color: ed.color, size: ed.sizes.text };
  if (index < 0) {
    if (text.trim()) pushShape(shape);
  } else {
    // Edited text keeps its place in the stack; emptied text is deleted.
    setShapes(text.trim() ? before.map((s, i) => (i === index ? shape : s)) : before.filter((_, i) => i !== index));
  }
  redrawShapes();
  syncToolbar();
}

function cancelText(): void {
  if (!ed.textEdit) return;
  ed.shapes = ed.textEdit.before; // back to before editing, original text included
  ed.textEdit = null;
  ed.textMove = null;
  textInput.classList.add('hidden');
  redrawShapes();
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
  const prev = ed.undo.pop();
  if (!prev) return;
  ed.redo.push(ed.shapes);
  ed.shapes = prev;
  setHover(null);
  syncToolbar();
  redrawShapes();
}
function redoAction(): void {
  const next = ed.redo.pop();
  if (!next) return;
  ed.undo.push(ed.shapes);
  ed.shapes = next;
  setHover(null);
  syncToolbar();
  redrawShapes();
}

/** PNG of the selection at native resolution. toBlob encodes off the main thread, so the UI doesn't freeze. */
async function exportPNG(k = outScale()): Promise<Uint8Array> {
  commitText();
  const s = norm(ed.selection!);
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
  paste();
}
const paste = () => void (ed.phase === 'text' ? copyScanned('paste') : act(window.api.copyPaste));

/** Window capture: the frontmost window under p. */
const windowAt = (p: Pt) => ed.windows.find((w) => inBox(p, w)) ?? null;

/** Window capture, before any click: frame the window under the mouse. */
function hoverWindow(): void {
  if (ed.phase !== 'selecting' || ed.selStart || !ed.windows.length) return;
  const w = windowAt(ed.mouse);
  if (w === ed.selection) return;
  ed.selection = w;
  layout();
}

/** Copy-text mode, selection done: read the text right away and wait for ⌘C / ⌘V (the hint under the frame). */
function scanText(s: Box): void {
  ed.selection = s;
  ed.selStart = null;
  ed.phase = 'text';
  hint.classList.add('hidden');
  layout();
  const read = async () => layoutText(await window.api.ocr(await exportPNG(ed.k))); // native resolution, whatever the 1x option says
  const timeout = new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), SCAN_TIMEOUT));
  const scan = Promise.race([read(), timeout]);
  ed.scan = scan;
  // Nothing to copy: say so and let the user select again. main logs why a scan failed.
  scan
    .then((text) => (text ? '' : 'No text found'), () => 'Could not read the text')
    .then((msg) => {
      if (!msg || ed.selection !== s) return; // Esc or a new selection meanwhile
      showHud(msg, ed.mouse.x, ed.mouse.y);
      selectAgain();
    });
}

/** ⌘C / Enter / ⌘V / ⌘T in copy-text mode: copy the text that was read (waiting for it if needed), or its translation, then close or paste. */
async function copyScanned(action: 'copy' | 'paste' | 'translate'): Promise<void> {
  const s = ed.selection;
  if (ed.phase !== 'text' || !s || !ed.scan) return;
  ed.phase = 'exporting'; // block a second trigger
  layout();
  const text = await ed.scan.catch(() => '');
  if (!text || ed.selection !== s) return; // scanText reports an empty or failed scan
  if (action === 'paste') return void window.api.copyText(text, true); // main hides the overlay and pastes
  let out = text;
  if (action === 'translate') {
    showHud('Translating…', ed.mouse.x, ed.mouse.y, 15000); // until the answer; main gives up after 10 s
    const translated = await window.api.translate(text, translateTarget(text)).catch(() => '');
    if (ed.selection !== s) return;
    if (!translated) {
      // Offline or refused: the text is still there to copy.
      showHud('Could not translate', ed.mouse.x, ed.mouse.y);
      ed.phase = 'text';
      return layout();
    }
    out = translated;
  }
  await window.api.copyText(out, false);
  if (ed.selection !== s) return;
  const n = out.split('\n').length;
  showHud(`${action === 'translate' ? 'Translated' : 'Copied'} ${n} line${n === 1 ? '' : 's'}`, ed.mouse.x, ed.mouse.y);
  setTimeout(() => {
    if (ed.selection === s) window.api.close();
  }, 700);
}

/** Drop the selection and go back to selecting. */
function selectAgain(): void {
  ed.phase = 'selecting';
  ed.selection = null;
  hint.classList.remove('hidden');
  hideLayers();
  syncToolbar();
  layout();
}

/** Selection done: start annotating. */
function enterEditing(s: Box): void {
  ed.selection = s;
  ed.selStart = null;
  ed.phase = 'editing';
  hint.classList.add('hidden');
  setupLayers();
  syncToolbar();
  layout();
}

function startSelecting(p: Pt): void {
  ed.phase = 'selecting';
  ed.shapes = [];
  ed.undo = [];
  ed.redo = [];
  ed.selStart = p;
  ed.selection = { x: p.x, y: p.y, w: 0, h: 0 };
  hint.classList.add('hidden');
  hideLayers();
}

// ---------- pointer ----------
const pt = (e: MouseEvent): Pt => ({ x: e.clientX, y: e.clientY });
const onToolbar = (e: MouseEvent) => !!(e.target as Element).closest('#actions');

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || onToolbar(e)) return;
  const p = pt(e);
  if (ed.phase === 'selecting' || ed.phase === 'text') {
    startSelecting(p); // copy-text mode: dragging again replaces the selection
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
      const t = ed.shapes[idx] as TextShape;
      openText(t.x, t.y, idx);
    } else {
      openText(p.x, p.y - (ed.sizes.text * LINE_HEIGHT) / 2, -1);
    }
    e.preventDefault();
    return;
  }

  commitText();
  setHover(null);
  ed.draftStart = p;
  const style = { color: ed.color, size: ed.sizes[ed.tool] };
  ed.draft =
    ed.tool === 'pen' ? { kind: 'pen', points: [p], ...style }
    : ed.tool === 'line' || ed.tool === 'arrow' ? { kind: 'line', arrow: ed.tool === 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...style }
    : { kind: ed.tool === 'ellipse' ? 'ellipse' : 'rect', x: p.x, y: p.y, w: 0, h: 0, ...style };
  drawDraft();
});

window.addEventListener('mousemove', (e) => {
  const p = pt(e);
  ed.mouse = p;
  if (ed.textMove && ed.textEdit) {
    const s = norm(ed.selection!);
    ed.textEdit.x = clamp(p.x - ed.textMove.x, s.x, s.x + s.w - 10);
    ed.textEdit.y = clamp(p.y - ed.textMove.y, s.y, s.y + s.h - 10);
    placeText();
    autosizeText();
    return;
  }
  hoverWindow();
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
    if (!ed.textEdit) setHover(edge || onToolbar(e) ? null : hitShape(p));
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
  if (ed.textMove) {
    ed.textMove = null;
    textInput.focus();
    return;
  }
  if (ed.phase === 'selecting' && ed.selStart) {
    const s = norm(ed.selection!);
    // Click without dragging = the window under the mouse (window capture) or the whole screen.
    const box = s.w < 5 || s.h < 5 ? windowAt(pt(e)) ?? { x: 0, y: 0, w: ed.viewW, h: ed.viewH } : s;
    if (ed.mode === 'text') scanText(box);
    else enterEditing(box);
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
  if (ed.phase === 'editing' && ed.hover) return deleteShape(ed.hover);
  if ((ed.phase === 'editing' && ed.shapes.length === 0) || ed.phase === 'text') {
    selectAgain(); // right-click before drawing
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
const onTextFrame = (e: MouseEvent) =>
  e.offsetX < TEXT_PAD || e.offsetY < TEXT_PAD ||
  e.offsetX > textInput.clientWidth - TEXT_PAD || e.offsetY > textInput.clientHeight - TEXT_PAD;
textInput.addEventListener('mousedown', (e) => {
  e.stopPropagation();
  if (e.button !== 0 || !ed.textEdit || !onTextFrame(e)) return; // inside: place the caret as usual
  e.preventDefault(); // keep the caret and focus while moving
  ed.textMove = { x: e.clientX - ed.textEdit.x, y: e.clientY - ed.textEdit.y };
});
textInput.addEventListener('mousemove', (e) => {
  textInput.style.cursor = ed.textMove || onTextFrame(e) ? 'move' : 'text';
});

window.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') return window.api.close();
  if (ed.phase === 'text') {
    if (mod && k === 'v') { e.preventDefault(); return requestPaste(e); }
    if ((mod && k === 'c') || e.key === 'Enter') { e.preventDefault(); void copyScanned('copy'); }
    if (mod && k === 't') { e.preventDefault(); void copyScanned('translate'); }
    return;
  }
  if (ed.phase !== 'editing') return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
  if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) { e.preventDefault(); return redoAction(); }
  // ⌘V / Ctrl+V (with or without Shift) = copy + auto-paste into the previous app.
  if (mod && k === 'v') { e.preventDefault(); return requestPaste(e); }
  if (mod && k === 'c') { e.preventDefault(); void act(window.api.copy); return; }
  if (mod && k === 's') { e.preventDefault(); void act(window.api.save); return; }
  if (e.key === 'Enter') { e.preventDefault(); void act(window.api.copy); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && ed.hover) { e.preventDefault(); return deleteShape(ed.hover); }
  if (mod) return;
  if (k === 'r') setTool('rect');
  else if (k === 'o') setTool('ellipse');
  else if (k === 'l') setTool('line');
  else if (k === 'a') setTool('arrow');
  else if (k === 'p') setTool('pen');
  else if (k === 't') setTool('text');
});

window.addEventListener('keyup', (e) => {
  if (ed.pendingPaste && !modsHeld(e)) {
    ed.pendingPaste = false;
    paste();
  }
});

// ---------- toolbar ----------
actionsEl.addEventListener('mousedown', (e) => {
  // Don't let the toolbar steal focus from the text input (except the color picker).
  if (!(e.target as HTMLElement).closest('#colorCustomWrap')) e.preventDefault();
});
actionsEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.tool) setTool(btn.dataset.tool as Tool);
  else if (btn.dataset.color) setColor(btn.dataset.color);
  else if (btn.id === 'btnUndo') undo();
  else if (btn.id === 'btnSave') void act(window.api.save);
  else if (btn.id === 'btnCopy') void act(window.api.copy);
  else if (btn.id === 'btnClose') window.api.close();
});
colorInput.addEventListener('input', () => setColor(colorInput.value));
colorInput.addEventListener('change', () => {
  if (ed.textEdit) textInput.focus();
});

// ---------- overlay lifecycle ----------
/** Back to idle and free the image memory. Tool, color and sizes carry over between captures. */
function reset(): void {
  ed.phase = 'loading';
  ed.selection = ed.selStart = ed.draft = ed.draftStart = ed.textEdit = ed.resize = ed.textMove = null;
  ed.windows = [];
  hint.textContent = HINT;
  ed.shapes = [];
  ed.undo = [];
  ed.redo = [];
  ed.hover = null;
  ed.pendingPaste = false;
  ed.scan = null;
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
  ed.retina1x = cap.retina1x;
  bg.width = cap.pxW;
  bg.height = cap.pxH;
  bgCtx.putImageData(toImageData(cap.bitmap, cap.pxW, cap.pxH, cap.bgra), 0, 0);
  ed.mouse = cap.cursor;
  ed.phase = 'selecting';
  ed.mode = cap.mode;
  translateHint.classList.toggle('hidden', cap.mode !== 'text');
  ed.hintSize = null; // the hint is wider with the translate shortcut
  if (cap.mode === 'full') {
    enterEditing({ x: 0, y: 0, w: cap.width, h: cap.height });
  } else {
    if (cap.mode === 'window') hint.textContent = WINDOW_HINT;
    if (cap.mode === 'text') hint.textContent = TEXT_HINT;
    syncToolbar();
    layout();
  }
  // Main shows the window transparent first; reveal it once the new image has been painted (next frame).
  // macOS may treat an opacity-0 window as occluded and pause frames, so report after 50 ms regardless.
  let sent = false;
  const ready = () => {
    if (sent) return;
    sent = true;
    window.api.ready();
  };
  requestAnimationFrame(ready);
  setTimeout(ready, 50);
});
window.api.onHidden(reset);
// Window capture: main sends the window frames right after the overlay becomes visible.
window.api.onWindows((windows) => {
  if (ed.phase === 'loading') return;
  ed.windows = windows;
  hoverWindow();
});
