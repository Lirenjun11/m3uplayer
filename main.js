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

  // 部分源（如 iptv.lrj.qzz.io）按 User-Agent 嗅探，只给浏览器 UA 返回真实流地址
  // Electron 默认 UA 会被拒绝（返回空 JSON），这里伪装成标准 Chrome
  mainWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );

  mainWindow.loadFile('index.html');

  // 渲染进程日志转发到终端（调试用）
  mainWindow.webContents.on('console-message', (...args) => {
    const e = args[0];
    if (e && typeof e === 'object' && 'message' in e) {
      if (e.level >= 2) console.log('[renderer]', e.message);
    } else {
      const level = args[1];
      if (level >= 2) console.log('[renderer]', args[2]);
    }
  });
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
  // 开发模式下没有 app-update.yml，electron-updater 无法工作
  if (!app.isPackaged) {
    const err = new Error('开发模式下不支持检查更新，请使用打包安装版测试');
    sendUpdaterEvent('error', { message: err.message });
    throw err;
  }
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
