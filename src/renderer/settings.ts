// Settings window: capture hotkey, options (Retina 1x, open at login), version + links.
// Wrapped in an IIFE so its globals don't clash with editor.ts.
(() => {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const field = el<HTMLButtonElement>('hotkeyField');
  const msg = el<HTMLParagraphElement>('msg');
  const resetBtn = el<HTMLButtonElement>('btnReset');
  const isMac = navigator.platform.toLowerCase().includes('mac');

  let current = '';
  let currentPretty = ''; // main already returns the display form, no extra IPC
  let defaultHotkey = '';
  let recording = false;

  // KeyboardEvent.code -> Electron Accelerator key name.
  // Uses `code` (physical key position) so it doesn't depend on the input method / keyboard layout.
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
  const isModifier = (e: KeyboardEvent) => ['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn'].includes(e.key);

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

  /** Shown while keys are held, before the combination is complete. */
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

  function showCurrent(): void {
    field.textContent = current ? currentPretty : 'Not set';
    resetBtn.disabled = current === defaultHotkey;
  }

  function startRecording(): void {
    if (recording) return;
    recording = true;
    window.api.settings.setRecording(true);
    field.classList.add('recording');
    field.textContent = 'Press a key combination…';
    setMsg('Esc to cancel. Needs at least one modifier (Ctrl, Alt, Shift, ⌘/Win), except F1 to F24 and PrintScreen.');
  }

  function stopRecording(): void {
    if (!recording) return;
    recording = false;
    field.classList.remove('recording');
    window.api.settings.setRecording(false);
    showCurrent();
  }

  async function apply(accel: string): Promise<void> {
    recording = false;
    field.classList.remove('recording');
    field.textContent = 'Saving…';
    const res = await window.api.settings.setHotkey(accel);
    if (res.ok) {
      current = res.hotkey;
      currentPretty = res.pretty;
      setMsg(`Saved. Press ${res.pretty} anywhere to capture.`, 'ok');
    } else {
      setMsg(res.error, 'error');
    }
    window.api.settings.setRecording(false);
    showCurrent();
  }

  field.addEventListener('click', () => (recording ? stopRecording() : startRecording()));
  field.addEventListener('blur', stopRecording);

  window.addEventListener('keydown', (e) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape' && !modifiers(e).length) {
      stopRecording();
      setMsg('Cancelled, kept the previous hotkey.');
      return;
    }
    const mods = modifiers(e);
    if (isModifier(e)) {
      field.textContent = prettyLive(mods) || 'Press a key combination…';
      return;
    }
    const key = keyFromCode(e.code);
    if (!key) {
      setMsg(`The "${e.key}" key can't be used. Pick another key.`, 'error');
      return;
    }
    const standalone = /^F\d+$/.test(key) || key === 'PrintScreen';
    if (!mods.length && !standalone) {
      field.textContent = key;
      setMsg('Add at least one modifier (Ctrl, Alt, Shift, ⌘/Win).', 'error');
      return;
    }
    field.textContent = prettyLive(mods, key);
    void apply([...mods, key].join('+'));
  });

  window.addEventListener('keyup', (e) => {
    if (recording && isModifier(e)) {
      field.textContent = prettyLive(modifiers(e)) || 'Press a key combination…';
    }
  });

  resetBtn.addEventListener('click', () => void apply(defaultHotkey));

  // Checkbox options: id = option name in main. The message under the hotkey confirms the change.
  const OPTIONS = {
    retina1x: ['Screenshots on Retina displays are now exported at 1×.', 'Screenshots are exported at full resolution.'],
    openAtLogin: ['ShoreShot will open at login.', "ShoreShot won't open at login."],
  } as const;
  for (const name of Object.keys(OPTIONS) as (keyof typeof OPTIONS)[]) {
    const box = el<HTMLInputElement>(name);
    box.addEventListener('change', async () => {
      box.checked = await window.api.settings.setOption(name, box.checked);
      setMsg(OPTIONS[name][box.checked ? 0 : 1], 'ok');
    });
  }

  el('linkAbout').addEventListener('click', () => window.api.settings.link('about'));
  el('linkIssues').addEventListener('click', () => window.api.settings.link('issues'));
  el('linkUpdate').addEventListener('click', () => window.api.settings.link('update'));

  async function boot(): Promise<void> {
    const s = await window.api.settings.get();
    current = s.hotkey;
    currentPretty = s.pretty;
    defaultHotkey = s.defaultHotkey;
    for (const name of ['retina1x', 'openAtLogin'] as const) el<HTMLInputElement>(name).checked = s[name];
    el('version').textContent = `ShoreShot ${s.version}`;
    if (s.update) {
      el('linkUpdate').textContent = `Update to ${s.update}`;
      el('linkUpdate').classList.remove('hidden');
    }
    showCurrent();
    if (!s.active) {
      setMsg(`${s.pretty} is used by another app, so it isn't active. Click the field above to pick another.`, 'error');
    } else {
      setMsg('Click the field above, then press a new key combination.');
    }
  }
  void boot();
})();
