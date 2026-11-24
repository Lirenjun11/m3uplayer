// 临时测试：自动加载源、播放指定频道并收集错误证据
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const TEST_CHANNEL = process.argv[2] || 'CCTV5体育';

app.whenReady().then(async () => {
  // 与 npx electron . / 打包版保持一致的 userData
  app.setPath('userData', path.join(app.getPath('appData'), 'm3uplayer'));
  // preload 依赖的 IPC（与 main.js 保持一致）
  ipcMain.on('config:path', (e) => {
    e.returnValue = path.join(app.getPath('userData'), 'm3u-config.json');
  });
  ipcMain.handle('update:get-app-version', () => app.getVersion());

  const win = new BrowserWindow({
    width: 1100,
    height: 700,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  win.webContents.on('console-message', (...args) => {
    const e = args[0];
    if (e && typeof e === 'object' && 'message' in e) {
      if (e.level >= 1) console.log('[page]', e.level, e.message);
    } else {
      console.log('[page]', args[1], args[2]);
    }
  });
  win.webContents.on('preload-error', (e, p, err) => console.log('[preload-error]', p, err.message));
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('[did-fail-load]', code, desc, url));
  win.webContents.on('render-process-gone', (e, details) => console.log('[render-gone]', JSON.stringify(details)));
  win.webContents.on('did-finish-load', () => console.log('[did-finish-load]'));
  await win.loadFile('index.html');

  // 等待频道加载完成
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await win.webContents.executeJavaScript('typeof channels !== "undefined" ? channels.length : -1').catch(e => { console.log('[eval-err]', e.message); return -1; });
    if (n > 0) { console.log('>>> 频道加载完成:', n); break; }
    if (i === 59) {
      const diag = await win.webContents.executeJavaScript('JSON.stringify({ready: document.readyState, channels: typeof channels, m3uUrl: typeof m3uUrl !== "undefined" ? m3uUrl : null, hlsApi: typeof Hls, cfg: window.__configPath, loaded: JSON.stringify(loadConfig())})').catch(e => 'diag-err ' + e.message);
      console.log('>>> 诊断:', diag);
      console.log('>>> 频道加载超时');
      app.quit();
      return;
    }
  }

  // 找到目标频道并播放
  const idx = await win.webContents.executeJavaScript(`
    channels.findIndex(c => c.name.toLowerCase().includes(${JSON.stringify(TEST_CHANNEL.toLowerCase())}))
  `);
  console.log('>>> 目标频道索引:', idx);
  if (idx < 0) {
    const names = await win.webContents.executeJavaScript('channels.slice(0,20).map(c=>c.name).join(" | ")');
    console.log('>>> 前20频道:', names);
    app.quit();
    return;
  }
  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const ch = channels[${idx}];
        playChannel(ch, ${idx});
        return ch.name + ' | 线路数:' + ch.lines.length + ' | ' + ch.lines[0].url;
      } catch (e) {
        return 'PLAY_ERROR: ' + e.message + ' | ' + e.stack.split('\\n').slice(0, 4).join(' / ');
      }
    })()
  `).then(console.log).catch(e => console.log('[eval-err]', e.message));

  // 等待播放状态稳定
  await new Promise(r => setTimeout(r, 20000));
  const state = await win.webContents.executeJavaScript(`
    (() => {
      const v = document.getElementById('my-video');
      return JSON.stringify({
        name: channels[${idx}].name,
        url: channels[${idx}].lines[0].url,
        readyState: v.readyState,
        networkState: v.networkState,
        paused: v.paused,
        error: v.error ? v.error.code + '/' + v.error.message : null,
        currentTime: v.currentTime.toFixed(2),
        videoSize: v.videoWidth + 'x' + v.videoHeight,
        currentLine: currentLineIdx + 1,
        standbyVisible: !document.getElementById('video-standby').classList.contains('hidden')
      }, null, 1);
    })()
  `);
  console.log('>>> 播放状态:\n' + state);
  app.quit();
});
