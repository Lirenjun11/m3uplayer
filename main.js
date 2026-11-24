const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    // frame: false, // 隐藏标题栏 - 恢复默认
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // 隐藏菜单栏
  mainWindow.setMenu(null);

  mainWindow.loadFile('index.html');
//   mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  setupAutoUpdater();
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

// 窗口控制事件
ipcMain.on('minimize-window', () => {
  mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.restore();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.on('close-window', () => {
  mainWindow.close();
});

// ============ 自动更新（GitHub Releases） ============
const { autoUpdater } = require('electron-updater');

// 配置文件路径（userData 目录，打包安装后可写）
ipcMain.on('config:path', (e) => {
  e.returnValue = path.join(app.getPath('userData'), 'm3u-config.json');
});

function sendUpdaterEvent(type, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:event', { type, ...data });
  }
}

function setupAutoUpdater() {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true; // 发现新版本后自动后台下载
  autoUpdater.autoInstallOnAppQuit = true; // 下载完成后退出应用时自动安装

  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('available', { version: info.version }));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('not-available', { version: info.version }));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('progress', {
    percent: progress.percent,
    transferred: progress.transferred,
    total: progress.total
  }));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => sendUpdaterEvent('error', { message: err ? (err.message || String(err)) : '未知错误' }));
}

ipcMain.handle('update:get-app-version', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  try {
    const result = await autoUpdater.checkForUpdatesAndNotify();
    const updateInfo = result && result.updateInfo ? result.updateInfo : null;
    return { ok: true, currentVersion: app.getVersion(), latestVersion: updateInfo ? updateInfo.version : null };
  } catch (err) {
    sendUpdaterEvent('error', { message: err ? (err.message || String(err)) : '未知错误' });
    throw err;
  }
});

ipcMain.on('update:install', () => {
  autoUpdater.quitAndInstall(false, true);
});
