const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// 配置文件存放在 userData 目录（打包安装后可写），首次运行时从旧位置迁移
const LEGACY_CONFIG_FILE = path.join(__dirname, 'm3u-config.json');
const CONFIG_FILE = ipcRenderer.sendSync('config:path');

try {
  if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG_FILE)) {
    fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_FILE);
    console.log('已迁移配置文件到:', CONFIG_FILE);
  }
} catch (error) {
  console.error('迁移配置文件失败:', error);
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('加载配置文件失败:', error);
  }
  return { urls: [], currentUrl: '' };
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('保存配置文件失败:', error);
    return false;
  }
}

function addUrl(url) {
  const config = loadConfig();
  if (!config.urls.includes(url)) {
    config.urls.push(url);
    saveConfig(config);
  }
  return config;
}

function removeUrl(url) {
  const config = loadConfig();
  config.urls = config.urls.filter(u => u !== url);
  if (config.currentUrl === url) {
    config.currentUrl = config.urls[0] || '';
  }
  saveConfig(config);
  return config;
}

function setCurrentUrl(url) {
  const config = loadConfig();
  config.currentUrl = url;
  saveConfig(config);
  return config;
}

window.loadConfig = loadConfig;
window.addUrl = addUrl;
window.removeUrl = removeUrl;
window.setCurrentUrl = setCurrentUrl;

// 自动更新 API
window.updateAPI = {
  getAppVersion: () => ipcRenderer.invoke('update:get-app-version'),
  check: () => ipcRenderer.invoke('update:check'),
  install: () => ipcRenderer.send('update:install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater:event', (_event, data) => callback(data));
  }
};

window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector, text) => {
    const element = document.getElementById(selector);
    if (element) element.innerText = text;
  };

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type]);
  }
});
