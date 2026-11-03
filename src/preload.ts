// Written as a plain script (no import/export) so it runs in Electron's sandboxed preload.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electron = require('electron') as typeof import('electron');

electron.contextBridge.exposeInMainWorld('api', {
  onCapture: (cb: (cap: unknown) => void) => electron.ipcRenderer.on('capture:show', (_e, cap) => cb(cap)),
  onHidden: (cb: () => void) => electron.ipcRenderer.on('capture:hidden', () => cb()),
  onWindows: (cb: (w: unknown) => void) => electron.ipcRenderer.on('capture:windows', (_e, w) => cb(w)),
  ready: () => electron.ipcRenderer.send('capture:ready'),
  copy: (png: Uint8Array) => electron.ipcRenderer.invoke('capture:copy', png),
  save: (png: Uint8Array) => electron.ipcRenderer.invoke('capture:save', png),
  copyPaste: (png: Uint8Array) => electron.ipcRenderer.invoke('capture:copyPaste', png),
  close: () => electron.ipcRenderer.send('capture:close'),
  settings: {
    get: () => electron.ipcRenderer.invoke('settings:get'),
    setHotkey: (mode: string, accel: string) => electron.ipcRenderer.invoke('settings:setHotkey', mode, accel),
    setRecording: (on: boolean) => electron.ipcRenderer.send('settings:recording', on),
    setOption: (name: string, on: boolean) => electron.ipcRenderer.invoke('settings:setOption', name, on),
    link: (name: string) => electron.ipcRenderer.send('settings:link', name),
  },
});
