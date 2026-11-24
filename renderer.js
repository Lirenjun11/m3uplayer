const playlistContainer = document.getElementById('playlist-container');
const channelName = document.getElementById('channel-name');
const channelGroup = document.getElementById('channel-group');

let hls = null;
let flvPlayer = null;
let allTracks = [];
let filteredTracks = [];
let currentTrackIndex = 0;
let failedTracks = new Set();
let isSwitching = false;
let m3uUrl = '';
let selectedUrl = '';

function initializeConfig() {
  const config = loadConfig();
  if (config.urls.length > 0) {
    m3uUrl = config.currentUrl || config.urls[0];
    selectedUrl = m3uUrl;
  } else {
    m3uUrl = 'https://codeberg.org/Jsnzkpg/Jsnzkpg/raw/branch/Jsnzkpg/Jsnzkpg1.m3u';
    selectedUrl = m3uUrl;
    addUrl(m3uUrl);
  }
}

// 手动解析M3U文件
function parseM3U(content) {
  const lines = content.split('\n');
  const tracks = [];
  let currentTrack = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      // 解析EXTINF行
      currentTrack = {
        name: '',
        url: '',
        attributes: {}
      };

      // 解析属性
      const attrMatch = line.match(/([a-zA-Z-]+)="([^"]+)"/g);
      if (attrMatch) {
        attrMatch.forEach(attr => {
          const [key, value] = attr.replace(/"/g, '').split('=');
          currentTrack.attributes[key] = value;
        });
      }

      // 解析频道名称（在最后一个逗号之后）
      const nameMatch = line.match(/,(.+)$/);
      if (nameMatch) {
        currentTrack.name = nameMatch[1].trim();
      }
    } else if (line && !line.startsWith('#') && currentTrack) {
      // 这是URL行
      currentTrack.url = line;
      tracks.push(currentTrack);
      currentTrack = null;
    }
  }

  return tracks;
}

// 清理之前的播放器
function cleanupPlayers() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  if (flvPlayer) {
    flvPlayer.destroy();
    flvPlayer = null;
  }
}

// 显示播放错误
function showPlayError(message) {
  channelName.textContent = '播放失败';
  channelGroup.textContent = message;
  channelGroup.style.color = '#e74c3c';

  // 3秒后恢复颜色
  setTimeout(() => {
    channelGroup.style.color = '';
  }, 3000);
}

// 标记频道为失败
function markTrackAsFailed(index) {
  failedTracks.add(index);
  // 更新UI显示失败状态
  const items = document.querySelectorAll('.playlist-item');
  if (items[index]) {
    items[index].style.opacity = '0.5';
    items[index].style.textDecoration = 'line-through';
  }
  console.log(`频道 ${index} 标记为失败，已失败频道数: ${failedTracks.size}/${allTracks.length}`);
}

// 播放下一个可用频道
function playNextAvailable() {
  if (allTracks.length === 0 || isSwitching) return;

  isSwitching = true;
  console.log(`查找可用频道，当前索引: ${currentTrackIndex}, 已失败: ${failedTracks.size}/${allTracks.length}`);

  // 从当前索引的下一个开始查找
  for (let i = currentTrackIndex + 1; i < allTracks.length; i++) {
    const track = allTracks[i];
    // 跳过已失败的和RTMP链接
    if (!failedTracks.has(i) && !track.url.startsWith('rtmp://')) {
      currentTrackIndex = i;
      console.log(`找到可用频道: ${i} - ${track.name}`);
      // 更新UI选中状态
      document.querySelectorAll('.playlist-item').forEach((el, idx) => {
        el.classList.toggle('active', idx === i);
      });
      // 滚动到该频道
      const items = document.querySelectorAll('.playlist-item');
      if (items[i]) {
        items[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      playChannel(track, i);
      setTimeout(() => { isSwitching = false; }, 500);
      return;
    }
  }

  // 如果到达末尾还没有找到，显示提示
  console.log('到达列表末尾，没有找到可用频道');
  showPlayError(`已尝试所有频道，${failedTracks.size}/${allTracks.length} 个频道不可用`);
  isSwitching = false;
}

// 使用原生HTML5视频播放器
function playChannel(track, index) {
  if (index !== undefined) {
    currentTrackIndex = index;
  }

  channelName.textContent = track.name || '未知频道';
  channelGroup.textContent = `分组: ${track.attributes['group-title'] || '未分组'}`;

  console.log(`开始播放频道 ${index}: ${track.name}`);
  console.log('播放URL:', track.url);

  // 获取视频元素
  const video = document.getElementById('my-video');

  // 清理之前的播放器
  cleanupPlayers();

  // 停止当前播放并重置视频元素
  video.pause();
  video.removeAttribute('src');
  video.load();

  // 根据URL类型选择播放方式
  const url = track.url.toLowerCase();
  if (url.includes('.m3u8') || url.includes('/m3u8') || url.includes('hls') || url.includes('playlist')) {
    // HLS流
    console.log('识别为HLS格式:', track.url.substring(0, 50));
    playHLS(video, track.url, index);
  } else if (url.includes('.flv') || url.includes('/flv') || url.includes('flv?')) {
    // FLV流
    playFLV(video, track.url, index);
  } else if (track.url.startsWith('rtmp://')) {
    // RTMP流 - 需要使用其他方案
    console.warn('RTMP流不支持直接播放:', track.url);
    markTrackAsFailed(index);
    showPlayError('RTMP格式暂不支持，请手动选择其他频道');
    return;
  } else {
    // 普通MP4或其他格式
    playNative(video, track.url, index);
  }
}

// 播放HLS流
function playHLS(video, url, trackIndex) {
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 300,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      maxLiveSyncPlaybackRate: 1.5,
      manifestLoadingTimeOut: 10000,
      manifestLoadingMaxRetry: 2,
      levelLoadingTimeOut: 10000,
      levelLoadingMaxRetry: 2,
      fragLoadingTimeOut: 10000,
      fragLoadingMaxRetry: 2
    });

    let manifestLoaded = false;
    let playTimeout = null;
    let hasError = false;
    let bufferStalledCount = 0; // 记录缓冲区不足次数

    // 设置播放超时 - 增加到30秒
    playTimeout = setTimeout(() => {
      if (!manifestLoaded && !hasError) {
        console.warn('HLS加载超时');
        hasError = true;
        if (hls) {
          try {
            hls.destroy();
          } catch (e) {
            console.log('HLS销毁时出错:', e);
          }
          hls = null;
        }
        markTrackAsFailed(trackIndex);
        showPlayError('频道加载超时，请手动选择其他频道');
      }
    }, 30000);

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function() {
      if (hasError) return;
      manifestLoaded = true;
      if (playTimeout) clearTimeout(playTimeout);

      // 延迟一点再播放，确保资源准备好
      setTimeout(() => {
        video.play().catch(e => {
          if (e.name === 'AbortError') {
            console.log('播放被中断，可能是正在切换频道');
            return;
          }
          console.error('HLS播放失败:', e);
          if (!hasError) {
            hasError = true;
            markTrackAsFailed(trackIndex);
            showPlayError('播放失败，请手动选择其他频道');
          }
        });
      }, 100);
    });

    hls.on(Hls.Events.ERROR, function(event, data) {
      if (hasError) return;
      console.warn('HLS警告/错误:', data);

      if (data.fatal) {
        console.error('HLS致命错误:', data);
        hasError = true;
        if (playTimeout) clearTimeout(playTimeout);

        switch(data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (data.details === 'manifestLoadError') {
              console.log(`频道 ${trackIndex} manifest加载失败`);
              markTrackAsFailed(trackIndex);
              showPlayError('频道链接失效或无法访问，请手动选择其他频道');
            } else {
              console.log('网络错误，尝试恢复...');
              hls.startLoad();
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            console.log('媒体错误，尝试恢复...');
            hls.recoverMediaError();
            break;
          default:
            markTrackAsFailed(trackIndex);
            console.log('无法恢复的错误');
            if (hls) {
              try {
                hls.destroy();
              } catch (e) {
                console.log('HLS销毁时出错:', e);
              }
              hls = null;
            }
            showPlayError('播放错误，请手动选择其他频道');
            break;
        }
      } else {
        // 非致命错误，如bufferStalledError，通常会自动恢复
        if (data.details === 'bufferStalledError') {
          bufferStalledCount++;
          console.log(`缓冲区不足(${bufferStalledCount}/3)，等待加载...`);
          // 如果缓冲区不足超过3次，可能是频道有问题
          if (bufferStalledCount >= 3 && !manifestLoaded) {
            console.warn('缓冲区多次不足，可能频道无法播放');
          }
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari原生支持HLS
    video.src = url;

    // 添加错误监听
    const errorHandler = function() {
      console.error('视频加载错误:', video.error);
      video.removeEventListener('error', errorHandler);
      markTrackAsFailed(trackIndex);
      showPlayError('视频格式不支持，请手动选择其他频道');
    };
    video.addEventListener('error', errorHandler);

    video.play().catch(e => {
      console.error('播放失败:', e);
      video.removeEventListener('error', errorHandler);
      markTrackAsFailed(trackIndex);
      showPlayError('播放失败，请手动选择其他频道');
    });
  } else {
    markTrackAsFailed(trackIndex);
    showPlayError('您的浏览器不支持HLS播放，请手动选择其他频道');
  }
}

// 播放FLV流
function playFLV(video, url, trackIndex) {
  if (typeof flvjs !== 'undefined' && flvjs.isSupported()) {
    try {
      flvPlayer = flvjs.createPlayer({
        type: 'flv',
        url: url,
        isLive: true,
        hasAudio: true,
        hasVideo: true
      });
      flvPlayer.attachMediaElement(video);
      flvPlayer.load();

      let playTimeout = setTimeout(() => {
        console.warn('FLV加载超时');
        if (flvPlayer) {
          try {
            flvPlayer.destroy();
          } catch (e) {
            console.log('FLV销毁时出错:', e);
          }
          flvPlayer = null;
        }
        markTrackAsFailed(trackIndex);
        showPlayError('FLV加载超时，请手动选择其他频道');
      }, 30000);

      flvPlayer.play().then(() => {
        if (playTimeout) clearTimeout(playTimeout);
      }).catch(e => {
        if (playTimeout) clearTimeout(playTimeout);
        console.error('FLV播放失败:', e);
        markTrackAsFailed(trackIndex);
        showPlayError('FLV播放失败，请手动选择其他频道');
      });

      flvPlayer.on(flvjs.Events.ERROR, function(errorType, errorDetail, errorInfo) {
        console.error('FLV错误:', errorType, errorDetail, errorInfo);
        markTrackAsFailed(trackIndex);
        showPlayError('FLV播放错误，请手动选择其他频道');
      });
    } catch (e) {
      console.error('FLV初始化失败:', e);
      markTrackAsFailed(trackIndex);
      showPlayError('FLV初始化失败，请手动选择其他频道');
    }
  } else {
    alert('您的浏览器不支持FLV播放');
  }
}

// 原生播放
function playNative(video, url, trackIndex) {
  // 检查视频格式是否支持
  const mediaType = getMediaType(url);
  const canPlay = video.canPlayType(mediaType);

  console.log(`检测格式支持: ${url.substring(0, 50)}..., 类型: ${mediaType}, 支持: ${canPlay || '否'}`);

  if (canPlay === '') {
    console.warn('不支持的格式:', url);
    markTrackAsFailed(trackIndex);
    showPlayError('格式不支持，请手动选择其他频道');
    return;
  }

  video.src = url;

  // 添加错误监听
  const errorHandler = function() {
    console.error('视频加载错误:', video.error);
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    if (playTimeout) clearTimeout(playTimeout);
    markTrackAsFailed(trackIndex);
    showPlayError('视频格式不支持，请手动选择其他频道');
  };

  const canPlayHandler = function() {
    console.log('视频可以播放了');
    video.removeEventListener('canplay', canPlayHandler);
    if (playTimeout) clearTimeout(playTimeout);
  };

  video.addEventListener('error', errorHandler);
  video.addEventListener('canplay', canPlayHandler);

  let playTimeout = setTimeout(() => {
    console.warn('视频加载超时');
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    markTrackAsFailed(trackIndex);
    showPlayError('视频加载超时，请手动选择其他频道');
  }, 30000);

  video.play().then(() => {
    if (playTimeout) clearTimeout(playTimeout);
  }).catch(e => {
    if (playTimeout) clearTimeout(playTimeout);
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    console.error('播放失败:', e);
    markTrackAsFailed(trackIndex);
    showPlayError('无法播放此频道，请手动选择其他频道');
  });
}

function getMediaType(url) {
  // 检测更多格式
  if (url.includes('.m3u8') || url.includes('m3u8')) {
    return 'application/vnd.apple.mpegurl';
  } else if (url.includes('.mp4')) {
    return 'video/mp4';
  } else if (url.includes('.webm')) {
    return 'video/webm';
  } else if (url.includes('.ogg') || url.includes('.ogv')) {
    return 'video/ogg';
  } else if (url.includes('.mkv')) {
    return 'video/x-matroska';
  } else if (url.includes('.avi')) {
    return 'video/x-msvideo';
  } else if (url.includes('.mov')) {
    return 'video/quicktime';
  } else if (url.includes('.ts') || url.includes('.mpegts')) {
    return 'video/mp2t';
  } else {
    // 默认尝试video/mp4，但很可能是流媒体格式
    console.log('未知格式，尝试作为MP4播放:', url.substring(0, 50));
    return 'video/mp4';
  }
}

function displayPlaylist(tracks) {
  allTracks = tracks; // 保存所有频道
  filteredTracks = tracks; // 初始过滤列表
  updatePlaylist();
}

// 更新播放列表显示
function updatePlaylist() {
  playlistContainer.innerHTML = '';

  filteredTracks.forEach((track, index) => {
    const originalIndex = allTracks.findIndex(t => t.url === track.url);
    const item = document.createElement('div');
    item.className = 'playlist-item';
    item.textContent = track.name || `频道 ${index + 1}`;
    item.dataset.index = originalIndex;
    item.dataset.url = track.url;
    item.dataset.group = track.attributes['group-title'] || '';
    item.dataset.name = track.name || '';

    // 检查是否失败
    if (failedTracks.has(originalIndex)) {
      item.style.opacity = '0.5';
      item.style.textDecoration = 'line-through';
    }

    item.addEventListener('click', () => {
      // 移除所有active类
      document.querySelectorAll('.playlist-item').forEach(el => el.classList.remove('active'));
      // 添加active类到当前点击的项目
      item.classList.add('active');
      // 播放选中的频道
      playChannel(track, originalIndex);
    });

    playlistContainer.appendChild(item);
  });
}

async function loadM3U() {
  const loadingOverlay = document.getElementById('loading-overlay');
  
  try {
    channelName.textContent = '加载中...';
    channelGroup.textContent = '正在获取频道列表';
    
    const response = await fetch(m3uUrl);
    
    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
    }
    
    const m3uContent = await response.text();

    const tracks = parseM3U(m3uContent);
    console.log('解析结果:', tracks);
    console.log(`共加载 ${tracks.length} 个频道`);

    displayPlaylist(tracks);

    const rtmpCount = tracks.filter(t => t.url.startsWith('rtmp://')).length;
    const hlsCount = tracks.filter(t => t.url.includes('.m3u8') || t.url.includes('m3u8')).length;
    const flvCount = tracks.filter(t => t.url.includes('.flv')).length;
    console.log(`HLS: ${hlsCount}, RTMP: ${rtmpCount}, FLV: ${flvCount}, 其他: ${tracks.length - hlsCount - rtmpCount - flvCount}`);
    
    if (tracks.length > 0) {
      channelName.textContent = '请选择一个频道';
      channelGroup.textContent = '';
    } else {
      channelName.textContent = '无可用频道';
      channelGroup.textContent = 'M3U文件中没有找到频道';
    }
  } catch (error) {
    console.error('加载M3U文件失败:', error);
    channelName.textContent = '加载失败';
    channelGroup.textContent = `错误: ${error.message}`;
    channelGroup.style.color = '#e74c3c';
    
    setTimeout(() => {
      channelGroup.style.color = '';
    }, 3000);
  } finally {
    if (loadingOverlay) {
      loadingOverlay.style.display = 'none';
    }
  }
}

function renderUrlList() {
  const urlList = document.getElementById('url-list');
  const config = loadConfig();
  
  urlList.innerHTML = '';
  
  if (config.urls.length === 0) {
    urlList.innerHTML = '<div style="text-align: center; color: #999; padding: 20px;">暂无链接，请添加</div>';
    return;
  }
  
  config.urls.forEach(url => {
    const item = document.createElement('div');
    item.className = 'url-item';
    if (url === selectedUrl) {
      item.classList.add('active');
    }
    
    const content = document.createElement('div');
    content.className = 'url-item-content';
    content.textContent = url;
    
    const actions = document.createElement('div');
    actions.className = 'url-item-actions';
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '删除';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteUrl(url);
    };
    
    actions.appendChild(deleteBtn);
    item.appendChild(content);
    item.appendChild(actions);
    
    item.onclick = () => {
      selectUrl(url);
    };
    
    urlList.appendChild(item);
  });
}

function addNewUrl() {
  const input = document.getElementById('m3u-url-input');
  const url = input.value.trim();
  
  if (!url) {
    alert('请输入链接地址');
    return;
  }
  
  const config = addUrl(url);
  input.value = '';
  renderUrlList();
}

function deleteUrl(url) {
  if (confirm('确定要删除这个链接吗？')) {
    const config = removeUrl(url);
    if (selectedUrl === url) {
      selectedUrl = config.currentUrl;
    }
    renderUrlList();
  }
}

function selectUrl(url) {
  selectedUrl = url;
  renderUrlList();
}

function applySelectedUrl() {
  if (selectedUrl && selectedUrl !== m3uUrl) {
    m3uUrl = selectedUrl;
    setCurrentUrl(selectedUrl);
    failedTracks.clear();
    currentTrackIndex = 0;
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
      loadingOverlay.style.display = 'flex';
    }
    loadM3U();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initializeConfig();
  loadM3U();
  
  document.getElementById('settings-btn').addEventListener('click', () => {
    const modal = document.getElementById('settings-modal');
    renderUrlList();
    modal.style.display = 'flex';
  });
  
  document.getElementById('cancel-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
  });
  
  document.getElementById('confirm-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
    applySelectedUrl();
  });
  
  document.getElementById('add-url-btn').addEventListener('click', addNewUrl);
  
  document.getElementById('m3u-url-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      addNewUrl();
    }
  });
  
  document.getElementById('search-input').addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase().trim();
    if (searchTerm) {
      filteredTracks = allTracks.filter(track => {
        const trackName = (track.name || '').toLowerCase();
        const trackGroup = (track.attributes['group-title'] || '').toLowerCase();
        return trackName.includes(searchTerm) || trackGroup.includes(searchTerm);
      });
    } else {
      filteredTracks = allTracks;
    }
    updatePlaylist();
  });
  
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-modal')) {
      document.getElementById('settings-modal').style.display = 'none';
    }
  });
});
