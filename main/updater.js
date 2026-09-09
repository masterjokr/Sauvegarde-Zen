'use strict';

const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

function createUpdater({ emit, notify }) {
  let downloadedVersion = null;
  let availableVersion = null;

  function send(status, payload = {}) {
    emit('update-status', { status, ...payload });
  }

  if (!app.isPackaged) {
    return {
      check: async () => {
        send('development');
        return { status: 'development' };
      },
      install: () => {
        throw new Error('Les mises à jour sont disponibles après installation de la version Windows.');
      }
    };
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => send('checking'));
  autoUpdater.on('update-available', (info) => {
    availableVersion = info.version;
    send('available', { version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => send('not-available', { version: info.version }));
  autoUpdater.on('download-progress', (progress) => send('downloading', {
    version: availableVersion,
    percent: Math.round(progress.percent),
    transferred: progress.transferred,
    total: progress.total
  }));
  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    send('downloaded', { version: info.version });
    notify('Mise à jour prête', `Sauvegarde Zen ${info.version} sera installée à la fermeture.`);
  });
  autoUpdater.on('error', (error) => send('error', { message: error?.message || String(error) }));

  async function check() {
    try {
      await autoUpdater.checkForUpdates();
      return { status: 'checking' };
    } catch (error) {
      send('error', { message: error?.message || String(error) });
      return { status: 'error', message: error?.message || String(error) };
    }
  }

  function install() {
    if (!downloadedVersion) throw new Error('Aucune mise à jour téléchargée.');
    autoUpdater.quitAndInstall();
    return true;
  }

  setTimeout(() => check(), 8_000);
  return { check, install };
}

module.exports = { createUpdater };
