'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response?.ok) throw new Error(response?.error || 'Opération impossible.');
  return response.data;
}

contextBridge.exposeInMainWorld('backupAPI', Object.freeze({
  getAppVersion: () => invoke('app:get-version'),
  checkForUpdates: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  getState: () => invoke('state:get'),
  selectDirectory: () => invoke('directory:select'),
  saveJob: (job) => invoke('job:save', job),
  deleteJob: (jobId) => invoke('job:delete', jobId),
  toggleJob: (jobId, enabled) => invoke('job:toggle', jobId, enabled),
  runJob: (jobId) => invoke('job:run', jobId),
  inspectPaths: (source, destination) => invoke('storage:inspect', source, destination),
  getVersions: (jobId) => invoke('job:versions', jobId),
  restoreFile: (jobId, runId, relativePath) => invoke('job:restore-file', jobId, runId, relativePath),
  openDestination: (jobId) => invoke('job:open-destination', jobId),
  saveSettings: (settings) => invoke('settings:save', settings),
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('backup:event', listener);
    return () => ipcRenderer.removeListener('backup:event', listener);
  }
}));
