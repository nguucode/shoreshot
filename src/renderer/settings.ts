// Cửa sổ Cài đặt: ghi phím tắt chụp màn hình + chọn hành động của Enter.
// Bọc trong IIFE để không đụng biến toàn cục với editor.ts.
(() => {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const field = el<HTMLButtonElement>('hotkeyField');
  const msg = el<HTMLParagraphElement>('msg');
  const resetBtn = el<HTMLButtonElement>('btnReset');
  const enterPastes = el<HTMLInputElement>('enterPastes');
  const isMac = navigator.platform.toLowerCase().includes('mac');

  let current = '';
  let defaultHotkey = '';
  let recording = false;

  // KeyboardEvent.code -> tên phím trong Electron Accelerator.
  // Dùng `code` (vị trí phím vật lý) để không phụ thuộc bộ gõ / layout bàn phím.
  const CODE_MAP: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    PrintScreen: 'PrintScreen', ScrollLock: 'Scrolllock',
    NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  };
  const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn',
  ]);

  function keyFromCode(code: string): string | null {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
    if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
    return CODE_MAP[code] ?? null;
  }

  function modifiers(e: KeyboardEvent): string[] {
    const m: string[] = [];
    if (e.ctrlKey) m.push('Control');
    if (e.altKey) m.push('Alt');
    if (e.shiftKey) m.push('Shift');
    if (e.metaKey) m.push(isMac ? 'Command' : 'Super');
    return m;
  }

  /** Hiển thị trong lúc đang giữ phím, chưa thành tổ hợp hoàn chỉnh. */
  function prettyLive(mods: string[], key = ''): string {
    const macSym: Record<string, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘' };
    const winSym: Record<string, string> = { Control: 'Ctrl', Super: 'Win' };
    const order = isMac ? ['Control', 'Alt', 'Shift', 'Command'] : ['Control', 'Super', 'Alt', 'Shift'];
    const sorted = order.filter((o) => mods.includes(o));
    const parts = sorted.map((p) => (isMac ? macSym[p] : winSym[p] ?? p));
    if (key) parts.push(key);
    return parts.join(isMac ? '' : '+');
  }

  function setMsg(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    msg.textContent = text;
    msg.dataset.kind = kind;
  }

  async function showCurrent(): Promise<void> {
    field.textContent = current ? await window.api.settings.pretty(current) : 'Chưa gán';
    resetBtn.disabled = current === defaultHotkey;
  }

  function startRecording(): void {
    if (recording) return;
    recording = true;
    window.api.settings.setRecording(true);
    field.classList.add('recording');
    field.textContent = 'Bấm tổ hợp phím…';
    setMsg('Esc để huỷ. Cần ít nhất 1 phím bổ trợ (Ctrl, Alt, Shift, ⌘/Win), trừ F1 đến F24 và PrintScreen.');
  }

  async function stopRecording(): Promise<void> {
    if (!recording) return;
    recording = false;
    field.classList.remove('recording');
    window.api.settings.setRecording(false);
    await showCurrent();
  }

  async function apply(accel: string): Promise<void> {
    recording = false;
    field.classList.remove('recording');
    field.textContent = 'Đang lưu…';
    const res = await window.api.settings.setHotkey(accel);
    if (res.ok) {
      current = res.hotkey;
      setMsg(`Đã lưu. Bấm ${res.pretty} ở bất cứ đâu để chụp.`, 'ok');
    } else {
      setMsg(res.error, 'error');
    }
    window.api.settings.setRecording(false);
    await showCurrent();
  }

  field.addEventListener('click', () => (recording ? void stopRecording() : startRecording()));
  field.addEventListener('blur', () => void stopRecording());

  window.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape' && !modifiers(e).length) {
      void stopRecording();
      setMsg('Đã huỷ, giữ nguyên phím tắt cũ.');
      return;
    }
    const mods = modifiers(e);
    if (MODIFIER_CODES.has(e.code)) {
      field.textContent = prettyLive(mods) || 'Bấm tổ hợp phím…';
      return;
    }
    const key = keyFromCode(e.code);
    if (!key) {
      setMsg(`Không dùng được phím "${e.key}". Chọn phím khác.`, 'error');
      return;
    }
    const standalone = /^F\d+$/.test(key) || key === 'PrintScreen';
    if (!mods.length && !standalone) {
      field.textContent = key;
      setMsg('Cần thêm ít nhất 1 phím bổ trợ (Ctrl, Alt, Shift, ⌘/Win).', 'error');
      return;
    }
    field.textContent = prettyLive(mods, key);
    void apply([...mods, key].join('+'));
  });

  window.addEventListener('keyup', (e) => {
    if (recording && MODIFIER_CODES.has(e.code)) {
      field.textContent = prettyLive(modifiers(e)) || 'Bấm tổ hợp phím…';
    }
  });

  resetBtn.addEventListener('click', () => void apply(defaultHotkey));

  enterPastes.addEventListener('change', async () => {
    enterPastes.checked = await window.api.settings.setEnterPastes(enterPastes.checked);
    setMsg(
      enterPastes.checked
        ? 'Enter / nút ✓ giờ sẽ copy và tự dán vào app trước đó.'
        : 'Enter / nút ✓ giờ chỉ copy vào clipboard.',
      'ok',
    );
  });

  async function boot(): Promise<void> {
    const s = await window.api.settings.get();
    current = s.hotkey;
    defaultHotkey = s.defaultHotkey;
    enterPastes.checked = s.enterPastes;
    el('pasteKey').textContent = isMac ? '⌘V' : 'Ctrl+V';
    await showCurrent();
    if (!s.active) {
      setMsg(`${s.pretty} đang bị app khác dùng nên chưa hoạt động. Bấm vào ô trên để chọn phím khác.`, 'error');
    } else {
      setMsg('Bấm vào ô trên rồi nhấn tổ hợp phím mới.');
    }
  }
  void boot();
})();
