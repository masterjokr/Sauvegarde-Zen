'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray
} = require('electron');
const { ConfigStore } = require('./config-store');
const { BackupManager } = require('./backup-manager');
const { Scheduler, nextJobOccurrence } = require('./scheduler');
const { sanitizeJob, sanitizeSettings } = require('./validation');
const { inspectPaths } = require('./storage');
const { listVersionRuns, restoreVersionFile } = require('./version-store');
const { createUpdater } = require('./updater');

let mainWindow = null;
let tray = null;
let store = null;
let scheduler = null;
let backupManager = null;
let updater = null;
let isQuitting = false;
let trayHintShown = false;

// La version installée possède une identité Windows propre. Le mode
// développement en utilise une autre afin qu'un lancement par `npm start` ne
// puisse plus contaminer l'icône épinglée de la version installée.
const WINDOWS_APP_ID = app.isPackaged
  ? 'fr.sauvegardezen.desktop'
  : 'fr.sauvegardezen.desktop.dev';
const appIconPath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.ico')
  : path.join(__dirname, '..', 'build', 'icon.ico');

if (process.platform === 'win32') app.setAppUserModelId(WINDOWS_APP_ID);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
  // Aucun autre code d’initialisation ne doit s’exécuter dans cette instance.
  process.exit(0);
}

function makeTrayIcon() {
  const appIcon = nativeImage.createFromPath(appIconPath);
  if (!appIcon.isEmpty()) return appIcon.resize({ width: 16, height: 16 });

  // Repli de sécurité si l'icône empaquetée est absente ou illisible.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4nGNQTX79nxLMMGoAbgPQwagBJBhACAwBAwZPSiQWAwBAnbXXjJXoJgAAAABJRU5ErkJggg==';
  return nativeImage.createFromDataURL(`data:image/png;base64,${png}`).resize({ width: 16, height: 16 });
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

function emit(type, payload = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backup:event', { type, payload });
  }
}

function publicState() {
  const snapshot = store.snapshot();
  const now = new Date();
  return {
    ...snapshot,
    jobs: snapshot.jobs.map((job) => ({
      ...job,
      running: backupManager?.isRunning(job.id) || false,
      nextRunAt: job.enabled ? nextJobOccurrence(job, now)?.toISOString() || null : null
    }))
  };
}

function broadcastState() {
  emit('state', publicState());
}

function applyLoginSettings() {
  if (!app.isPackaged) return;
  const enabled = store.snapshot().settings.startWithWindows;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: enabled ? ['--hidden'] : []
  });
}

function createWindow() {
  const windowIcon = nativeImage.createFromPath(appIconPath);
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 650,
    show: false,
    backgroundColor: '#f5f7fb',
    autoHideMenuBar: true,
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  if (process.platform === 'win32') {
    mainWindow.setIcon(windowIcon);
    mainWindow.setAppDetails({
      appId: WINDOWS_APP_ID,
      // L'icône intégrée à l'exécutable est la référence la plus stable pour
      // les raccourcis et regroupements maintenus par l'Explorateur Windows.
      appIconPath: app.isPackaged ? process.execPath : appIconPath,
      appIconIndex: 0,
      relaunchCommand: `"${process.execPath}"`,
      relaunchDisplayName: 'Sauvegarde Zen'
    });
  }

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) {
      mainWindow.show();
      mainWindow.focus();
      // Windows peut conserver le focus sur PowerShell après npm start.
      // moveTop() est appliqué uniquement au démarrage pour placer la fenêtre
      // devant, sans la rendre toujours au-dessus des autres applications.
      if (process.platform === 'win32') mainWindow.moveTop();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('close', (event) => {
    const minimizeToTray = store.snapshot().settings.minimizeToTray;
    if (!isQuitting && minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (!trayHintShown) {
        trayHintShown = true;
        notify('Sauvegarde Zen reste active', 'Les sauvegardes planifiées continuent en arrière-plan.');
      }
    }
  });
}

async function runAllEnabled() {
  const jobs = store.snapshot().jobs.filter((job) => job.enabled);
  for (const job of jobs) {
    try {
      await backupManager.run(job.id, 'manual');
    } catch {
      // Les erreurs sont déjà enregistrées et notifiées individuellement.
    }
  }
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Sauvegarde Zen');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Ouvrir Sauvegarde Zen',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    { label: 'Lancer toutes les sauvegardes actives', click: () => runAllEnabled() },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function safeHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      return { ok: false, error: 'Requête non autorisée.' };
    }
    try {
      return { ok: true, data: await handler(...args) };
    } catch (error) {
      return { ok: false, error: error?.message || 'Une erreur inattendue est survenue.' };
    }
  });
}

function registerIpc() {
  safeHandle('app:get-version', () => app.getVersion());
  safeHandle('update:check', () => updater.check());
  safeHandle('update:install', () => updater.install());
  safeHandle('state:get', () => publicState());

  safeHandle('directory:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choisir un dossier',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent']
    });
    return { canceled: result.canceled, path: result.filePaths[0] || null };
  });

  safeHandle('job:save', (rawJob) => {
    const requestedId = typeof rawJob?.id === 'string' ? rawJob.id : null;
    const existing = requestedId ? store.findJob(requestedId) : null;
    if (requestedId && !existing) throw new Error('La sauvegarde à modifier n’existe plus.');
    const job = sanitizeJob(rawJob, existing);
    store.upsertJob(job);
    broadcastState();
    return job;
  });

  safeHandle('job:delete', (jobId) => {
    if (backupManager.isRunning(jobId)) throw new Error('Attendez la fin de la sauvegarde avant de la supprimer.');
    if (!store.deleteJob(jobId)) throw new Error('Cette sauvegarde n’existe plus.');
    broadcastState();
    return true;
  });

  safeHandle('job:toggle', (jobId, enabled) => {
    const job = store.updateJob(jobId, (current) => ({ ...current, enabled: Boolean(enabled), updatedAt: new Date().toISOString() }));
    if (!job) throw new Error('Cette sauvegarde n’existe plus.');
    broadcastState();
    return job;
  });

  safeHandle('job:run', async (jobId) => backupManager.run(jobId, 'manual'));

  safeHandle('storage:inspect', async (source, destination) => inspectPaths(source, destination));

  safeHandle('job:versions', async (jobId) => {
    const job = store.findJob(jobId);
    if (!job) throw new Error('Cette sauvegarde n’existe plus.');
    return listVersionRuns({ destination: job.destination, jobId });
  });

  safeHandle('job:restore-file', async (jobId, runId, relativePath) => {
    const job = store.findJob(jobId);
    if (!job) throw new Error('Cette sauvegarde n’existe plus.');
    if (backupManager.isRunning(jobId)) throw new Error('Attendez la fin de la sauvegarde avant de restaurer un fichier.');
    const restored = await restoreVersionFile({
      destination: job.destination,
      jobId,
      runId,
      relativePath
    });
    const finishedAt = new Date().toISOString();
    store.addHistory({
      jobId,
      jobName: job.name,
      trigger: 'restore',
      status: 'success',
      copied: 0,
      updated: 1,
      skipped: 0,
      excluded: 0,
      archived: restored.savedCurrentPath ? 1 : 0,
      errors: [],
      errorCount: 0,
      bytesCopied: 0,
      totalFiles: 1,
      totalBytes: 0,
      oldVersionsDeleted: 0,
      versionsKept: 0,
      startedAt: finishedAt,
      finishedAt,
      restoredPath: restored.restoredPath,
      restoredFromRun: restored.runId
    });
    broadcastState();
    return restored;
  });

  safeHandle('job:open-destination', async (jobId) => {
    const job = store.findJob(jobId);
    if (!job) throw new Error('Cette sauvegarde n’existe plus.');
    const errorMessage = await shell.openPath(job.destination);
    if (errorMessage) throw new Error(errorMessage);
    return true;
  });

  safeHandle('settings:save', (rawSettings) => {
    const settings = sanitizeSettings(rawSettings);
    store.updateSettings(settings);
    applyLoginSettings();
    broadcastState();
    return settings;
  });

  safeHandle('window:show', () => {
    mainWindow.show();
    mainWindow.focus();
    return true;
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  scheduler?.stop();
});

app.whenReady().then(() => {
  store = new ConfigStore(app.getPath('userData'));
  backupManager = new BackupManager({
    store,
    emit,
    notify,
    getSettings: () => store.snapshot().settings
  });
  scheduler = new Scheduler({
    store,
    backupManager,
    notify,
    onStateChanged: broadcastState
  });
  createWindow();
  createTray();
  updater = createUpdater({ emit, notify });
  registerIpc();
  applyLoginSettings();
  scheduler.start();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (!store?.snapshot().settings.minimizeToTray) app.quit();
});
