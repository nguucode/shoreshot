// Viết dạng script (không import/export) để chạy được trong preload sandbox của Electron.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const electron = require('electron') as typeof import('electron');

electron.contextBridge.exposeInMainWorld('api', {
  getCapture: () => electron.ipcRenderer.invoke('capture:get'),
  ready: () => electron.ipcRenderer.send('capture:ready'),
  copy: (dataURL: string) => electron.ipcRenderer.invoke('capture:copy', dataURL),
  save: (dataURL: string) => electron.ipcRenderer.invoke('capture:save', dataURL),
  copyPaste: (dataURL: string) => electron.ipcRenderer.invoke('capture:copyPaste', dataURL),
  close: () => electron.ipcRenderer.send('capture:close'),
  settings: {
    get: () => electron.ipcRenderer.invoke('settings:get'),
    setHotkey: (accel: string) => electron.ipcRenderer.invoke('settings:setHotkey', accel),
    setRecording: (on: boolean) => electron.ipcRenderer.send('settings:recording', on),
    setEnterPastes: (on: boolean) => electron.ipcRenderer.invoke('settings:setEnterPastes', on),
  },
});
