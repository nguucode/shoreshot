// ShoreShot editor (renderer). Script thuần, không import, chạy trong overlay toàn màn hình.

type Tool = 'rect' | 'pen' | 'text';
interface Pt { x: number; y: number }
interface Box { x: number; y: number; w: number; h: number }
interface RectShape { kind: 'rect'; x: number; y: number; w: number; h: number; color: string; size: number }
interface PenShape { kind: 'pen'; points: Pt[]; color: string; size: number }
interface TextShape { kind: 'text'; x: number; y: number; text: string; color: string; size: number }
type Shape = RectShape | PenShape | TextShape;

const SIZE_LIMITS: Record<Tool, [number, number]> = { rect: [1, 40], pen: [1, 40], text: [10, 160] };
const SIZE_STEP: Record<Tool, number> = { rect: 1, pen: 1, text: 2 };
const SIZE_LABEL: Record<Tool, string> = { rect: 'Viền', pen: 'Nét bút', text: 'Cỡ chữ' };
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const LINE_HEIGHT = 1.2;

const ed = {
  phase: 'loading' as 'loading' | 'selecting' | 'editing',
  img: new Image(),
  viewW: 0,
  viewH: 0,
  dpr: window.devicePixelRatio || 1,
  selection: null as Box | null,
  selStart: null as Pt | null,
  tool: 'rect' as Tool,
  color: '#ff3b30',
  sizes: { rect: 4, pen: 4, text: 28 } as Record<Tool, number>,
  shapes: [] as Shape[],
  redo: [] as Shape[],
  draft: null as Shape | null,
  draftStart: null as Pt | null,
  textEdit: null as { x: number; y: number; original: TextShape | null } | null,
  wheelAcc: 0,
  enterPastes: false, // Enter / nút ✓ = copy + tự dán
  pendingPaste: false, // chờ nhả hết phím bổ trợ rồi mới dán
  hudTimer: 0 as number,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d')!;
const toolbarEl = $<HTMLDivElement>('toolbar');
const sizeBadge = $<HTMLDivElement>('sizeBadge');
const hud = $<HTMLDivElement>('hud');
const hint = $<HTMLDivElement>('hint');
const textInput = $<HTMLTextAreaElement>('textInput');
const colorInput = $<HTMLInputElement>('colorCustom');
const sizeReadout = $<HTMLSpanElement>('sizeReadout');

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
const pixelScale = () => (ed.viewW ? ed.img.naturalWidth / ed.viewW : 1);
const activeSizeTool = (): Tool => (ed.textEdit ? 'text' : ed.tool);

// ---------- drawing ----------
function drawShape(c: CanvasRenderingContext2D, s: Shape): void {
  c.save();
  if (s.kind === 'rect') {
    const b = norm(s);
    c.strokeStyle = s.color;
    c.lineWidth = s.size;
    c.lineJoin = 'round';
    c.strokeRect(b.x, b.y, b.w, b.h);
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
      // Làm mượt nét bằng quadratic curve qua trung điểm.
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

function render(): void {
  const { viewW: W, viewH: H } = ed;
  ctx.setTransform(ed.dpr, 0, 0, ed.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(ed.img, 0, 0, W, H);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, H);

  if (ed.selection) {
    const s = norm(ed.selection);
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.clip();
    ctx.drawImage(ed.img, 0, 0, W, H);
    ed.shapes.forEach((sh) => drawShape(ctx, sh));
    if (ed.draft) drawShape(ctx, ed.draft);
    ctx.restore();

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(s.x) + 0.5, Math.round(s.y) + 0.5, Math.round(s.w) - 1, Math.round(s.h) - 1);
    ctx.fillStyle = '#3b82f6';
    for (const [hx, hy] of [
      [s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h],
      [s.x + s.w / 2, s.y], [s.x + s.w / 2, s.y + s.h], [s.x, s.y + s.h / 2], [s.x + s.w, s.y + s.h / 2],
    ]) ctx.fillRect(hx - 3, hy - 3, 6, 6);

    const k = pixelScale();
    sizeBadge.textContent = `${Math.round(s.w * k)} × ${Math.round(s.h * k)}`;
    sizeBadge.classList.remove('hidden');
    const by = s.y - 28 >= 4 ? s.y - 28 : s.y + 6;
    sizeBadge.style.transform = `translate(${Math.max(4, s.x)}px, ${by}px)`;
  } else {
    sizeBadge.classList.add('hidden');
  }
  positionToolbar();
}

function positionToolbar(): void {
  if (ed.phase !== 'editing' || !ed.selection) {
    toolbarEl.classList.add('hidden');
    return;
  }
  toolbarEl.classList.remove('hidden');
  const s = norm(ed.selection);
  const tw = toolbarEl.offsetWidth;
  const th = toolbarEl.offsetHeight;
  const gap = 8;
  let y = s.y + s.h + gap;
  if (y + th > ed.viewH - 4) y = s.y - th - gap;
  if (y < 4) y = s.y + s.h - th - gap;
  const x = clamp(s.x + s.w - tw, 4, ed.viewW - tw - 4);
  toolbarEl.style.transform = `translate(${x}px, ${y}px)`;
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
  $('colorCustomWrap').style.setProperty('--c', ed.color);
  const t = activeSizeTool();
  sizeReadout.textContent = `${SIZE_LABEL[t]} ${ed.sizes[t]}`;
  ($('btnUndo') as HTMLButtonElement).disabled = ed.shapes.length === 0;
  canvas.style.cursor = ed.phase === 'editing' && ed.tool === 'text' ? 'text' : 'crosshair';
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
  if (ed.draft) ed.draft.color = c;
  syncToolbar();
  render();
}

function pushShape(s: Shape): void {
  ed.shapes.push(s);
  ed.redo = [];
  syncToolbar();
}

// ---------- text ----------
function openText(x: number, y: number, original: TextShape | null): void {
  ed.textEdit = { x, y, original };
  if (original) {
    ed.color = original.color;
    ed.sizes.text = original.size;
  }
  textInput.value = original?.text ?? '';
  textInput.classList.remove('hidden');
  textInput.style.left = `${x}px`;
  textInput.style.top = `${y}px`;
  applyTextStyle();
  syncToolbar();
  render();
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
  render();
}

function cancelText(): void {
  if (!ed.textEdit) return;
  const original = ed.textEdit.original;
  ed.textEdit = null;
  textInput.classList.add('hidden');
  if (original) ed.shapes.push(original); // khôi phục chữ cũ nếu đang sửa
  syncToolbar();
  render();
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
  render();
}
function redoAction(): void {
  const s = ed.redo.pop();
  if (s) ed.shapes.push(s);
  syncToolbar();
  render();
}

function exportPNG(): string {
  commitText();
  const s = norm(ed.selection!);
  const k = pixelScale();
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(s.w * k));
  out.height = Math.max(1, Math.round(s.h * k));
  const c = out.getContext('2d')!;
  c.drawImage(ed.img, s.x * k, s.y * k, s.w * k, s.h * k, 0, 0, out.width, out.height);
  c.setTransform(k, 0, 0, k, -s.x * k, -s.y * k);
  ed.shapes.forEach((sh) => drawShape(c, sh));
  return out.toDataURL('image/png');
}

async function copyAndClose(): Promise<void> {
  if (ed.phase !== 'editing') return;
  await window.api.copy(exportPNG());
}
async function pasteAndClose(): Promise<void> {
  if (ed.phase !== 'editing') return;
  await window.api.copyPaste(exportPNG());
}

const modsHeld = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

/** Dán bằng phím tắt: đợi nhả hết Ctrl/⌘/Shift/Alt để phím ảo ⌘V/Ctrl+V không bị lẫn phím người dùng đang giữ. */
function requestPaste(e?: KeyboardEvent): void {
  if (e && modsHeld(e)) {
    ed.pendingPaste = true;
    return;
  }
  void pasteAndClose();
}

/** Hành động chính (Enter, nút ✓) và hành động phụ, theo cài đặt. */
function primaryAction(e?: KeyboardEvent): void {
  if (ed.enterPastes) requestPaste(e);
  else void copyAndClose();
}
function secondaryAction(): void {
  if (ed.enterPastes) void copyAndClose();
  else requestPaste();
}

async function saveAndClose(): Promise<void> {
  if (ed.phase !== 'editing') return;
  await window.api.save(exportPNG());
}
function closeOverlay(): void {
  window.api.close();
}

function startSelecting(p: Pt): void {
  ed.phase = 'selecting';
  ed.shapes = [];
  ed.redo = [];
  ed.selStart = p;
  ed.selection = { x: p.x, y: p.y, w: 0, h: 0 };
  hint.classList.add('hidden');
}

// ---------- pointer ----------
const pt = (e: MouseEvent): Pt => ({ x: e.clientX, y: e.clientY });

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const p = pt(e);
  if (ed.phase === 'selecting') {
    startSelecting(p);
    render();
    return;
  }
  if (ed.phase !== 'editing' || !ed.selection) return;
  const sel = norm(ed.selection);

  if (!inBox(p, sel)) {
    commitText();
    // Chưa vẽ gì thì cho chọn lại vùng mới.
    if (ed.shapes.length === 0) {
      startSelecting(p);
      render();
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
  ed.draft =
    ed.tool === 'rect'
      ? { kind: 'rect', x: p.x, y: p.y, w: 0, h: 0, color: ed.color, size: ed.sizes.rect }
      : { kind: 'pen', points: [p], color: ed.color, size: ed.sizes.pen };
  render();
});

window.addEventListener('mousemove', (e) => {
  const p = pt(e);
  if (ed.phase === 'selecting' && ed.selStart && ed.selection) {
    const q = { x: clamp(p.x, 0, ed.viewW), y: clamp(p.y, 0, ed.viewH) };
    ed.selection = { x: ed.selStart.x, y: ed.selStart.y, w: q.x - ed.selStart.x, h: q.y - ed.selStart.y };
    render();
    return;
  }
  if (ed.draft && ed.draftStart) {
    const q = clampToSel(p);
    if (ed.draft.kind === 'rect') {
      ed.draft.w = q.x - ed.draftStart.x;
      ed.draft.h = q.y - ed.draftStart.y;
    } else if (ed.draft.kind === 'pen') {
      ed.draft.points.push(q);
    }
    render();
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (ed.phase === 'selecting' && ed.selStart) {
    let s = norm(ed.selection!);
    // Click không kéo = chụp cả màn hình.
    if (s.w < 5 || s.h < 5) s = { x: 0, y: 0, w: ed.viewW, h: ed.viewH };
    ed.selection = s;
    ed.selStart = null;
    ed.phase = 'editing';
    syncToolbar();
    render();
    return;
  }
  if (ed.draft) {
    const d = ed.draft;
    ed.draft = null;
    ed.draftStart = null;
    const keep = d.kind === 'rect' ? Math.abs(d.w) > 2 && Math.abs(d.h) > 2 : d.kind === 'pen';
    if (keep) pushShape(d);
    render();
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (ed.textEdit) return cancelText();
  if (ed.phase === 'editing' && ed.shapes.length === 0) {
    // Chuột phải khi chưa vẽ: bỏ vùng chọn, chọn lại.
    ed.phase = 'selecting';
    ed.selection = null;
    hint.classList.remove('hidden');
    syncToolbar();
    render();
  } else if (ed.phase === 'selecting' && !ed.selStart) {
    closeOverlay();
  }
});

// ---------- wheel: tăng/giảm viền, nét bút, cỡ chữ ----------
window.addEventListener(
  'wheel',
  (e) => {
    if (ed.phase !== 'editing') return;
    e.preventDefault();
    let dir = 0;
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50) {
      dir = Math.sign(e.deltaY); // chuột có nấc
      ed.wheelAcc = 0;
    } else {
      ed.wheelAcc += e.deltaY; // trackpad: cộng dồn để không nhảy quá nhanh
      if (Math.abs(ed.wheelAcc) >= 50) {
        dir = Math.sign(ed.wheelAcc);
        ed.wheelAcc = 0;
      }
    }
    if (!dir) return;
    const t = activeSizeTool();
    const [min, max] = SIZE_LIMITS[t];
    // Lăn lên = to hơn, lăn xuống = nhỏ hơn.
    ed.sizes[t] = clamp(ed.sizes[t] - dir * SIZE_STEP[t], min, max);
    if (ed.draft && ed.draft.kind === t) ed.draft.size = ed.sizes[t];
    if (ed.textEdit) applyTextStyle();
    showHud(`${SIZE_LABEL[t]}: ${ed.sizes[t]}px`, e.clientX, e.clientY);
    syncToolbar();
    render();
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
  if (e.key === 'Escape') return closeOverlay();
  if (ed.phase !== 'editing') return;
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); return undo(); }
  if ((mod && k === 'z' && e.shiftKey) || (mod && k === 'y')) { e.preventDefault(); return redoAction(); }
  // ⌘V / Ctrl+V (và cả bản có Shift) = copy + tự dán vào app trước đó.
  if (mod && k === 'v') { e.preventDefault(); return requestPaste(e); }
  if (mod && k === 'c') { e.preventDefault(); void copyAndClose(); return; }
  if (mod && k === 's') { e.preventDefault(); void saveAndClose(); return; }
  if (e.key === 'Enter') { e.preventDefault(); return primaryAction(e); }
  if (mod) return;
  if (k === 'r') setTool('rect');
  else if (k === 'p') setTool('pen');
  else if (k === 't') setTool('text');
});

window.addEventListener('keyup', (e) => {
  if (ed.pendingPaste && !modsHeld(e)) {
    ed.pendingPaste = false;
    void pasteAndClose();
  }
});

// ---------- toolbar ----------
toolbarEl.addEventListener('mousedown', (e) => {
  // Không cho toolbar cướp focus của ô nhập chữ (trừ color picker).
  if (!(e.target as HTMLElement).closest('#colorCustomWrap')) e.preventDefault();
});
toolbarEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.dataset.tool) setTool(btn.dataset.tool as Tool);
  else if (btn.dataset.color) setColor(btn.dataset.color);
  else if (btn.id === 'btnUndo') undo();
  else if (btn.id === 'btnSave') void saveAndClose();
  else if (btn.id === 'btnPrimary') primaryAction();
  else if (btn.id === 'btnSecondary') secondaryAction();
  else if (btn.id === 'btnClose') closeOverlay();
});
colorInput.addEventListener('input', () => setColor(colorInput.value));
colorInput.addEventListener('change', () => {
  if (ed.textEdit) textInput.focus();
});

// ---------- boot ----------
function resize(): void {
  ed.viewW = window.innerWidth;
  ed.viewH = window.innerHeight;
  ed.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(ed.viewW * ed.dpr);
  canvas.height = Math.round(ed.viewH * ed.dpr);
  canvas.style.width = `${ed.viewW}px`;
  canvas.style.height = `${ed.viewH}px`;
  if (ed.phase !== 'loading') render();
}
window.addEventListener('resize', resize);

const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON_PASTE = '<svg viewBox="0 0 24 24"><path d="M9 4h6v3H9z"/><path d="M15 5h2a2 2 0 0 1 2 2v3M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M14 16h7M18 13l3 3-3 3"/></svg>';

function setupActionButtons(): void {
  const mac = navigator.platform.toLowerCase().includes('mac');
  const m = mac ? '⌘' : 'Ctrl+';
  const copyTitle = `Copy vào clipboard (${m}C)`;
  const pasteTitle = `Copy và tự dán vào app trước đó (${m}V)`;
  const primary = $<HTMLButtonElement>('btnPrimary');
  const secondary = $<HTMLButtonElement>('btnSecondary');
  primary.title = `${ed.enterPastes ? pasteTitle : copyTitle} · Enter`;
  secondary.title = ed.enterPastes ? copyTitle : pasteTitle;
  secondary.setAttribute('aria-label', ed.enterPastes ? 'Copy' : 'Copy và dán');
  secondary.innerHTML = ed.enterPastes ? ICON_COPY : ICON_PASTE;
}

async function boot(): Promise<void> {
  const cap = await window.api.getCapture();
  if (!cap) return closeOverlay();
  ed.enterPastes = cap.enterPastes;
  setupActionButtons();
  ed.img.src = cap.dataURL;
  await ed.img.decode();
  resize();
  ed.phase = 'selecting';
  syncToolbar();
  render();
  requestAnimationFrame(() => window.api.ready());
}
void boot();
