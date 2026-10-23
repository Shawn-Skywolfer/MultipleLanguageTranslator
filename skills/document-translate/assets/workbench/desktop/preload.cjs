'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  platform: process.platform,
  saveVerifiedPptx(payload) {
    return ipcRenderer.invoke('pptx:save-verified', payload);
  },
});
