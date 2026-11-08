'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { loadCatalog, loadCatalogChain, Store, safeId } = require('./core');

const DEV = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..', '..');

if (DEV) app.setPath('userData', path.join(app.getPath('userData'), '..', 'ToolsLauncher-dev'));

// The release pipeline attaches catalog.json to every (non-pre) release; "latest" always resolves to the newest one.
const DEFAULT_CATALOG_URL = 'https://github.com/xotwodfr/toolslauncher/releases/latest/download/catalog.json';

const DEFAULT_SETTINGS = {
  // Empty = the default catalog above (falling back to the last cached copy, then the one bundled with the app).
  catalogUrl: '',
  checkUpdatesOnStart: true,
};

const store = new Store(path.join(app.getPath('userData'), 'data'));
let win = null;
let catalogCache = null;
const busy = new Set(); // tool ids currently installing

function bundledCatalogPath() {
  return DEV
    ? path.join(ROOT, 'dev-catalog', 'catalog.dev.json')
    : path.join(ROOT, 'catalog', 'catalog.json');
}

async function getCatalog(force = false) {
  if (catalogCache && !force) return catalogCache;
  if (DEV) {
    // Dev mode only ever uses the offline dev catalog (file:// assets are allowed there).
    catalogCache = { ...(await loadCatalog(bundledCatalogPath())), _source: 'dev' };
    return catalogCache;
  }
  const settings = await store.getSettings(DEFAULT_SETTINGS);
  const r = await loadCatalogChain({
    remote: settings.catalogUrl || DEFAULT_CATALOG_URL,
    cacheFile: path.join(store.dataDir, 'catalog-cache.json'),
    bundled: bundledCatalogPath(),
  });
  catalogCache = { ...r.catalog, _source: r.source, _remoteError: r.remoteError ? String(r.remoteError.message || r.remoteError) : null };
  return catalogCache;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0f1117',
    title: 'Tools Launcher',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

ipcMain.handle('library:get', async (_e, { refresh } = {}) => {
  const catalog = await getCatalog(!!refresh);
  return {
    tools: await store.buildLibrary(catalog),
    source: catalog._source, // 'remote' | 'cache' | 'bundled' | 'dev'
    remoteError: catalog._remoteError || null,
    dev: DEV,
    platform: process.platform,
    appVersion: app.getVersion(),
  };
});

ipcMain.handle('tool:install', async (_e, id) => {
  safeId(id);
  if (busy.has(id)) throw new Error('Already in progress');
  const catalog = await getCatalog();
  const tool = catalog.tools.find((t) => t.id === id);
  if (!tool) throw new Error('Unknown tool');
  busy.add(id);
  try {
    await store.install(tool, (p) => send('tool:progress', { id, ...p }), { allowLocal: DEV });
  } finally {
    busy.delete(id);
  }
  return true;
});

ipcMain.handle('tool:uninstall', async (_e, id) => {
  safeId(id);
  if (busy.has(id)) throw new Error('Busy');
  await store.uninstall(id);
  return true;
});

ipcMain.handle('tool:launch', async (_e, id) => {
  const { file, args, cwd } = await store.resolveLaunch(id);
  const isScript = process.platform === 'win32' && /\.(bat|cmd)$/i.test(file);
  const child = spawn(isScript ? `"${file}"` : file, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    shell: isScript,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  return true;
});

ipcMain.handle('tool:reveal', async (_e, id) => {
  const { cwd } = await store.resolveLaunch(id);
  shell.openPath(cwd);
  return true;
});

ipcMain.handle('settings:get', () => store.getSettings(DEFAULT_SETTINGS));
ipcMain.handle('settings:set', async (_e, patch) => {
  const clean = {};
  if (typeof patch.catalogUrl === 'string') {
    const v = patch.catalogUrl.trim();
    if (v && !/^https:\/\//i.test(v)) throw new Error('Catalog URL must start with https://');
    clean.catalogUrl = v;
  }
  if (typeof patch.checkUpdatesOnStart === 'boolean') clean.checkUpdatesOnStart = patch.checkUpdatesOnStart;
  const next = await store.setSettings(clean, DEFAULT_SETTINGS);
  catalogCache = null;
  return next;
});
ipcMain.handle('app:open-data-dir', () => shell.openPath(store.dataDir));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
