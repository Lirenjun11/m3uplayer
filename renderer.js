const playlistContainer = document.getElementById('playlist-container');
const channelName = document.getElementById('channel-name');
const channelGroup = document.getElementById('channel-group');

let hls = null;
let flvPlayer = null;
let allTracks = [];
let filteredTracks = [];
let currentTrackIndex = -1;
let failedTracks = new Set();
let isSwitching = false;
let m3uUrl = '';
let selectedUrl = '';
let currentCategory = '全部';

// 台标配色（按频道名哈希取色，保持稳定）
const LOGO_COLORS = ['#c94f4f','#4f7cc9','#5aa66a','#a68a4f','#8a5ac9','#4fa6a0','#c96a4f','#5a6bc9','#7aa64f','#a64f86'];

function hashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return LOGO_COLORS[h % LOGO_COLORS.length];
}

// 从频道名生成台标缩写：CCTV-1 综合 -> C1，湖南卫视 -> 湖南
function shortLogo(name) {
  if (!name) return 'TV';
  let n = name.trim();
  const m = n.match(/^CCTV[-\s]?(\d+)/i);
  if (m) return 'C' + m[1];
  const m2 = n.match(/^CGTN/i);
  if (m2) return 'CG';
  const clean = n.replace(/[-_·]/g, ' ').trim();
  return clean.slice(0, 2) || 'TV';
}

// ============ 工具 ============
let toastTimer = null;
function showToast(msg, duration = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

function showLoading(text) {
  const overlay = document.getElementById('loading-overlay');
  document.getElementById('loading-text').textContent = text || '正在加载频道列表…';
  overlay.classList.add('show');
}
function hideLoading() {
  document.getElementById('loading-overlay').classList.remove('show');
}

function updateSourcePill() {
  const el = document.getElementById('source-pill-text');
  if (!el) return;
  try {
    const u = new URL(m3uUrl);
    el.textContent = u.hostname + (u.pathname !== '/' ? u.pathname : '');
  } catch (e) {
    el.textContent = m3uUrl || '未设置源';
  }
  document.getElementById('status-source').textContent = '当前源：' + (m3uUrl || '-');
}

function updateStats() {
  document.getElementById('stat-total').textContent = allTracks.length;
  document.getElementById('stat-failed').textContent = failedTracks.size;
}

function updateClock() {
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  document.getElementById('status-clock').textContent =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

// ============ 配置初始化 ============
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
  updateSourcePill();
}

// ============ M3U 解析 ============
function parseM3U(content) {
  const lines = content.split('\n');
  const tracks = [];
  let currentTrack = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXTINF:')) {
      currentTrack = { name: '', url: '', attributes: {} };

      const attrMatch = line.match(/([a-zA-Z-]+)="([^"]+)"/g);
      if (attrMatch) {
        attrMatch.forEach(attr => {
          const [key, value] = attr.replace(/"/g, '').split('=');
          currentTrack.attributes[key] = value;
        });
      }

      const nameMatch = line.match(/,(.+)$/);
      if (nameMatch) {
        currentTrack.name = nameMatch[1].trim();
      }
    } else if (line && !line.startsWith('#') && currentTrack) {
      currentTrack.url = line;
      tracks.push(currentTrack);
      currentTrack = null;
    }
  }

  return tracks;
}

// ============ 播放器管理 ============
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

function showPlayError(message) {
  channelName.textContent = '播放失败';
  channelGroup.textContent = message;
  channelGroup.style.color = 'var(--accent)';
  setTimeout(() => { channelGroup.style.color = ''; }, 3000);
  showToast(message);
}

function setStandby(logo, name, hint) {
  const standby = document.getElementById('video-standby');
  if (logo === null) {
    standby.classList.add('hidden');
    document.getElementById('live-tag').style.display = 'flex';
  } else {
    standby.classList.remove('hidden');
    document.getElementById('live-tag').style.display = 'none';
    const logoEl = document.getElementById('standby-logo');
    logoEl.textContent = logo;
    logoEl.style.background = hashColor(name || logo);
    document.getElementById('standby-name').textContent = name;
    document.getElementById('standby-hint').textContent = hint || 'SELECT A CHANNEL';
  }
}

// 台标 HTML：优先使用 tvg-logo 图片，失败回退到文字缩写
function logoHTML(track, cls) {
  const name = track.name || '';
  const logoText = shortLogo(name);
  const color = hashColor(name || logoText);
  const imgUrl = track.attributes['tvg-logo'];
  if (imgUrl) {
    return `<div class="${cls}" style="background:#fff"><img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.remove();this.parentElement.textContent='${escapeHtml(logoText)}';this.parentElement.style.background='${color}'"></div>`;
  }
  return `<div class="${cls}" style="background:${color}">${escapeHtml(logoText)}</div>`;
}

function setInfoBar(track) {
  const infoLogoBox = document.getElementById('info-logo');
  const tmp = document.createElement('div');
  tmp.innerHTML = logoHTML(track, 'info-logo');
  const el = tmp.firstChild;
  el.id = 'info-logo';
  infoLogoBox.replaceWith(el);
  channelName.textContent = track.name || '未知频道';
  const fmt = detectFormatLabel(track.url);
  channelGroup.textContent = `分组: ${track.attributes['group-title'] || '未分组'} · ${fmt}`;
  document.getElementById('stat-format').textContent = fmt;
}

function detectFormatLabel(url) {
  const u = url.toLowerCase();
  if (u.includes('m3u8')) return 'HLS';
  if (u.includes('flv')) return 'FLV';
  if (u.startsWith('rtmp://')) return 'RTMP';
  if (u.includes('mp4')) return 'MP4';
  return 'LIVE';
}

// ============ 频道列表渲染 ============
function getCategories() {
  const map = new Map();
  allTracks.forEach(t => {
    const g = t.attributes['group-title'] || '未分组';
    map.set(g, (map.get(g) || 0) + 1);
  });
  // 按频道数降序
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function renderCategories() {
  const bar = document.getElementById('cat-bar');
  const cats = getCategories();
  const items = [['全部', allTracks.length], ...cats];
  bar.innerHTML = items.map(([name, count]) => `
    <div class="cat-chip ${name === currentCategory ? 'active' : ''}" data-cat="${name}">
      ${name}<span class="count">${count}</span>
    </div>`).join('');
  bar.querySelectorAll('.cat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentCategory = chip.dataset.cat;
      filterAndRender();
    });
  });
}

function filterTracks() {
  const kw = document.getElementById('search-input').value.toLowerCase().trim();
  let list = currentCategory === '全部' ? allTracks : allTracks.filter(t => (t.attributes['group-title'] || '未分组') === currentCategory);
  if (kw) {
    list = list.filter(t =>
      (t.name || '').toLowerCase().includes(kw) ||
      (t.attributes['group-title'] || '').toLowerCase().includes(kw)
    );
  }
  return list;
}

function filterAndRender() {
  filteredTracks = filterTracks();
  updatePlaylist();
  document.getElementById('list-label').textContent =
    currentCategory === '全部' ? '频道列表' : currentCategory;
  document.getElementById('list-count').textContent = filteredTracks.length + ' 个';
}

function updatePlaylist() {
  playlistContainer.innerHTML = '';

  if (filteredTracks.length === 0) {
    playlistContainer.innerHTML = '<div class="ch-list-empty">没有匹配的频道</div>';
    return;
  }

  filteredTracks.forEach((track, index) => {
    const originalIndex = allTracks.findIndex(t => t.url === track.url);
    const item = document.createElement('div');
    item.className = 'ch-item';
    item.dataset.index = originalIndex;
    if (originalIndex === currentTrackIndex) item.classList.add('active');
    if (failedTracks.has(originalIndex)) item.classList.add('failed');

    const stateHtml = failedTracks.has(originalIndex)
      ? '<div class="fail-dot"></div>'
      : (originalIndex === currentTrackIndex ? '<div class="live-dot"></div>' : '');

    item.innerHTML = `
      <div class="ch-idx">${String(index + 1).padStart(2, '0')}</div>
      ${logoHTML(track, 'ch-logo')}
      <div class="ch-meta">
        <div class="ch-name">${escapeHtml(track.name || '未知频道')}</div>
        <div class="ch-sub">${escapeHtml(track.attributes['group-title'] || '未分组')} · ${detectFormatLabel(track.url)}</div>
      </div>
      <div class="ch-state">${stateHtml}</div>`;

    item.addEventListener('click', () => {
      playChannel(track, originalIndex);
    });

    playlistContainer.appendChild(item);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function markActiveItem(index) {
  document.querySelectorAll('.ch-item').forEach(el => {
    const isActive = Number(el.dataset.index) === index;
    el.classList.toggle('active', isActive);
    const state = el.querySelector('.ch-state');
    if (state) state.innerHTML = failedTracks.has(Number(el.dataset.index)) ? '<div class="fail-dot"></div>' : (isActive ? '<div class="live-dot"></div>' : '');
  });
  const activeEl = playlistContainer.querySelector('.ch-item.active');
  if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function markTrackAsFailed(index) {
  failedTracks.add(index);
  document.querySelectorAll('.ch-item').forEach(el => {
    if (Number(el.dataset.index) === index) el.classList.add('failed');
  });
  updateStats();
  console.log(`频道 ${index} 标记为失败，已失败频道数: ${failedTracks.size}/${allTracks.length}`);
}

function playNextAvailable() {
  if (allTracks.length === 0 || isSwitching) return;

  isSwitching = true;
  for (let i = currentTrackIndex + 1; i < allTracks.length; i++) {
    const track = allTracks[i];
    if (!failedTracks.has(i) && !track.url.startsWith('rtmp://')) {
      currentTrackIndex = i;
      markActiveItem(i);
      playChannel(track, i);
      setTimeout(() => { isSwitching = false; }, 500);
      return;
    }
  }

  showPlayError(`已尝试所有频道，${failedTracks.size}/${allTracks.length} 个频道不可用`);
  isSwitching = false;
}

// ============ 播放 ============
function playChannel(track, index) {
  if (index !== undefined) {
    currentTrackIndex = index;
  }

  currentCategory = '全部';
  document.getElementById('search-input').value = '';
  filterAndRender();

  setStandby(null);
  setInfoBar(track);
  markActiveItem(currentTrackIndex);

  console.log(`开始播放频道 ${index}: ${track.name}`);

  const video = document.getElementById('my-video');
  cleanupPlayers();
  video.pause();
  video.removeAttribute('src');
  video.load();

  const url = track.url.toLowerCase();
  if (url.includes('.m3u8') || url.includes('/m3u8') || url.includes('hls') || url.includes('playlist')) {
    playHLS(video, track.url, index);
  } else if (url.includes('.flv') || url.includes('/flv') || url.includes('flv?')) {
    playFLV(video, track.url, index);
  } else if (track.url.startsWith('rtmp://')) {
    markTrackAsFailed(index);
    showPlayError('RTMP格式暂不支持，请手动选择其他频道');
    setStandby(shortLogo(track.name), track.name, 'RTMP NOT SUPPORTED');
  } else {
    playNative(video, track.url, index);
  }
}

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
    let bufferStalledCount = 0;

    playTimeout = setTimeout(() => {
      if (!manifestLoaded && !hasError) {
        hasError = true;
        if (hls) {
          try { hls.destroy(); } catch (e) {}
          hls = null;
        }
        markTrackAsFailed(trackIndex);
        showPlayError('频道加载超时，请手动选择其他频道');
        setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'TIMEOUT');
      }
    }, 30000);

    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, function() {
      if (hasError) return;
      manifestLoaded = true;
      if (playTimeout) clearTimeout(playTimeout);
      setTimeout(() => {
        video.play().catch(e => {
          if (e.name === 'AbortError') return;
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
      if (data.fatal) {
        hasError = true;
        if (playTimeout) clearTimeout(playTimeout);

        switch(data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            if (data.details === 'manifestLoadError') {
              markTrackAsFailed(trackIndex);
              showPlayError('频道链接失效或无法访问，请手动选择其他频道');
              setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'LINK FAILED');
            } else {
              hasError = false;
              hls.startLoad();
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hasError = false;
            hls.recoverMediaError();
            break;
          default:
            markTrackAsFailed(trackIndex);
            if (hls) {
              try { hls.destroy(); } catch (e) {}
              hls = null;
            }
            showPlayError('播放错误，请手动选择其他频道');
            setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'ERROR');
            break;
        }
      } else {
        if (data.details === 'bufferStalledError') {
          bufferStalledCount++;
          if (bufferStalledCount >= 3 && !manifestLoaded) {
            console.warn('缓冲区多次不足，可能频道无法播放');
          }
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    const errorHandler = function() {
      video.removeEventListener('error', errorHandler);
      markTrackAsFailed(trackIndex);
      showPlayError('视频格式不支持，请手动选择其他频道');
    };
    video.addEventListener('error', errorHandler);
    video.play().catch(e => {
      video.removeEventListener('error', errorHandler);
      markTrackAsFailed(trackIndex);
      showPlayError('播放失败，请手动选择其他频道');
    });
  } else {
    markTrackAsFailed(trackIndex);
    showPlayError('您的浏览器不支持HLS播放，请手动选择其他频道');
  }
}

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
        if (flvPlayer) {
          try { flvPlayer.destroy(); } catch (e) {}
          flvPlayer = null;
        }
        markTrackAsFailed(trackIndex);
        showPlayError('FLV加载超时，请手动选择其他频道');
        setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'TIMEOUT');
      }, 30000);

      flvPlayer.play().then(() => {
        if (playTimeout) clearTimeout(playTimeout);
      }).catch(e => {
        if (playTimeout) clearTimeout(playTimeout);
        markTrackAsFailed(trackIndex);
        showPlayError('FLV播放失败，请手动选择其他频道');
      });

      flvPlayer.on(flvjs.Events.ERROR, function() {
        markTrackAsFailed(trackIndex);
        showPlayError('FLV播放错误，请手动选择其他频道');
        setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'ERROR');
      });
    } catch (e) {
      markTrackAsFailed(trackIndex);
      showPlayError('FLV初始化失败，请手动选择其他频道');
    }
  } else {
    showToast('您的浏览器不支持FLV播放');
  }
}

function playNative(video, url, trackIndex) {
  const mediaType = getMediaType(url);
  const canPlay = video.canPlayType(mediaType);

  if (canPlay === '') {
    markTrackAsFailed(trackIndex);
    showPlayError('格式不支持，请手动选择其他频道');
    setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'FORMAT ERROR');
    return;
  }

  video.src = url;

  const errorHandler = function() {
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    if (playTimeout) clearTimeout(playTimeout);
    markTrackAsFailed(trackIndex);
    showPlayError('视频格式不支持，请手动选择其他频道');
    setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'FORMAT ERROR');
  };

  const canPlayHandler = function() {
    video.removeEventListener('canplay', canPlayHandler);
    if (playTimeout) clearTimeout(playTimeout);
  };

  video.addEventListener('error', errorHandler);
  video.addEventListener('canplay', canPlayHandler);

  let playTimeout = setTimeout(() => {
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    markTrackAsFailed(trackIndex);
    showPlayError('视频加载超时，请手动选择其他频道');
    setStandby(shortLogo(allTracks[trackIndex]?.name), allTracks[trackIndex]?.name, 'TIMEOUT');
  }, 30000);

  video.play().then(() => {
    if (playTimeout) clearTimeout(playTimeout);
  }).catch(e => {
    if (playTimeout) clearTimeout(playTimeout);
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    markTrackAsFailed(trackIndex);
    showPlayError('无法播放此频道，请手动选择其他频道');
  });
}

function getMediaType(url) {
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
    return 'video/mp4';
  }
}

// ============ 加载 M3U ============
async function loadM3U() {
  showLoading('正在加载频道列表…');

  try {
    channelName.textContent = '加载中...';
    channelGroup.textContent = '正在获取频道列表';
    setStandby('TV', '加载中…', 'LOADING');

    const response = await fetch(m3uUrl);

    if (!response.ok) {
      throw new Error(`HTTP错误: ${response.status} ${response.statusText}`);
    }

    const m3uContent = await response.text();
    const tracks = parseM3U(m3uContent);
    console.log(`共加载 ${tracks.length} 个频道`);

    allTracks = tracks;
    currentCategory = '全部';
    failedTracks.clear();
    currentTrackIndex = -1;
    renderCategories();
    filterAndRender();
    updateStats();

    if (tracks.length > 0) {
      channelName.textContent = '请选择一个频道';
      channelGroup.textContent = '在左侧列表中选择频道开始播放';
      setStandby('TV', '请选择一个频道', 'SELECT A CHANNEL');
    } else {
      channelName.textContent = '无可用频道';
      channelGroup.textContent = 'M3U文件中没有找到频道';
      setStandby('TV', '无可用频道', 'EMPTY LIST');
    }
  } catch (error) {
    console.error('加载M3U文件失败:', error);
    channelName.textContent = '加载失败';
    channelGroup.textContent = `错误: ${error.message}`;
    channelGroup.style.color = 'var(--accent)';
    setTimeout(() => { channelGroup.style.color = ''; }, 3000);
    setStandby('TV', '加载失败', 'LOAD FAILED');
    showToast('加载失败: ' + error.message);
  } finally {
    hideLoading();
  }
}

// ============ 源管理 ============
function renderUrlList() {
  const urlList = document.getElementById('url-list');
  const config = loadConfig();

  urlList.innerHTML = '';

  if (config.urls.length === 0) {
    urlList.innerHTML = '<div class="ch-list-empty">暂无链接，请添加</div>';
    return;
  }

  config.urls.forEach(url => {
    const item = document.createElement('div');
    item.className = 'src-item';
    if (url === selectedUrl) item.classList.add('active');

    const radio = document.createElement('div');
    radio.className = 'src-radio';

    const content = document.createElement('div');
    content.className = 'src-url';
    content.textContent = url;
    content.title = url;

    const delBtn = document.createElement('button');
    delBtn.className = 'src-del';
    delBtn.innerHTML = '&times;';
    delBtn.title = '删除此源';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteUrl(url);
    };

    item.appendChild(radio);
    item.appendChild(content);
    item.appendChild(delBtn);

    item.onclick = () => {
      selectedUrl = url;
      renderUrlList();
    };

    urlList.appendChild(item);
  });
}

function addNewUrl() {
  const input = document.getElementById('m3u-url-input');
  const url = input.value.trim();

  if (!url) {
    showToast('请输入链接地址');
    return;
  }

  addUrl(url);
  selectedUrl = url;
  input.value = '';
  renderUrlList();
}

function deleteUrl(url) {
  const config = removeUrl(url);
  if (selectedUrl === url) {
    selectedUrl = config.currentUrl;
  }
  renderUrlList();
}

function applySelectedUrl() {
  if (selectedUrl && selectedUrl !== m3uUrl) {
    m3uUrl = selectedUrl;
    setCurrentUrl(selectedUrl);
    updateSourcePill();
    loadM3U();
  }
}

// ============ OSD 控制 ============
function initOSD() {
  const video = document.getElementById('my-video');

  document.getElementById('osd-prev').addEventListener('click', () => switchChannel(-1));
  document.getElementById('osd-next').addEventListener('click', () => switchChannel(1));

  const playIconPlay = 'M8 5v14l11-7z';
  const playIconPause = 'M6 5h4v14H6zM14 5h4v14h-4z';
  document.getElementById('osd-play').addEventListener('click', () => {
    if (currentTrackIndex < 0) return;
    if (video.paused) { video.play().catch(() => {}); } else { video.pause(); }
  });
  video.addEventListener('play', () => {
    document.getElementById('osd-play-icon').querySelector('path').setAttribute('d', playIconPause);
  });
  video.addEventListener('pause', () => {
    document.getElementById('osd-play-icon').querySelector('path').setAttribute('d', playIconPlay);
  });

  const muteIconOn = 'M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z';
  const muteIconOff = 'M16.5 12A4.5 4.5 0 0 0 14 8v2.18l2.3 2.3c.13-.15.2-.31.2-.48zM19 12a7 7 0 0 1-1.2 3.95l1.16 1.16A8.9 8.9 0 0 0 21 12c0-4.05-2.68-7.49-6.36-8.62l-.7 2.1A6.9 6.9 0 0 1 19 12zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9zM12 4L9.91 6.09 12 8.18z';
  document.getElementById('osd-mute').addEventListener('click', () => {
    video.muted = !video.muted;
    document.getElementById('osd-mute-icon').querySelector('path').setAttribute('d', video.muted ? muteIconOff : muteIconOn);
  });

  // 音量条：点击设置音量
  const vol = document.getElementById('osd-vol');
  function setVolume(e) {
    const rect = vol.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.volume = ratio;
    video.muted = false;
    updateVolumeUI();
    document.getElementById('osd-mute-icon').querySelector('path').setAttribute('d', muteIconOn);
  }
  let dragging = false;
  vol.addEventListener('mousedown', e => { dragging = true; setVolume(e); });
  window.addEventListener('mousemove', e => { if (dragging) setVolume(e); });
  window.addEventListener('mouseup', () => { dragging = false; });
  function updateVolumeUI() {
    const pct = (video.muted ? 0 : video.volume) * 100;
    document.getElementById('osd-vol-fill').style.width = pct + '%';
    document.getElementById('osd-vol-thumb').style.left = pct + '%';
  }
  video.addEventListener('volumechange', updateVolumeUI);
  updateVolumeUI();

  document.getElementById('osd-full').addEventListener('click', () => {
    const wrap = document.querySelector('.video-wrap');
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrap.requestFullscreen().catch(() => {});
    }
  });

  // 双击视频区全屏
  document.querySelector('.video-wrap').addEventListener('dblclick', () => {
    document.getElementById('osd-full').click();
  });
}

function switchChannel(direction) {
  if (allTracks.length === 0) return;
  // 优先在当前过滤列表内切换，否则全局切换
  let list = filteredTracks.length > 1 ? filteredTracks : allTracks;
  if (filteredTracks.length > 1) {
    const pos = filteredTracks.findIndex(t => allTracks.findIndex(x => x.url === t.url) === currentTrackIndex);
    for (let k = 1; k <= list.length; k++) {
      const next = filteredTracks[(pos + direction * k + list.length * k) % list.length];
      const gi = allTracks.findIndex(x => x.url === next.url);
      if (!failedTracks.has(gi) && !next.url.startsWith('rtmp://')) {
        playChannel(next, gi);
        return;
      }
    }
  } else {
    for (let k = 1; k <= allTracks.length; k++) {
      const idx = (currentTrackIndex + direction * k + allTracks.length * k) % allTracks.length;
      const t = allTracks[idx];
      if (!failedTracks.has(idx) && !t.url.startsWith('rtmp://')) {
        playChannel(t, idx);
        return;
      }
    }
  }
  showToast('没有可用频道');
}

// ============ 检查更新 ============
const UPDATE_STATUS = {
  idle: '连接 GitHub Release 检查新版本',
};
let updateDownloaded = false;

function initUpdaterUI() {
  const checkBtn = document.getElementById('check-update-btn');
  const installBtn = document.getElementById('install-update-btn');
  const statusEl = document.getElementById('update-status');

  if (!window.updateAPI) {
    document.getElementById('update-current-ver').textContent = '不可用';
    statusEl.textContent = '更新模块不可用（非打包环境）';
    checkBtn.style.display = 'none';
    return;
  }

  window.updateAPI.getAppVersion().then(v => {
    document.getElementById('update-current-ver').textContent = 'v' + v;
  });

  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = '检查中…';
    statusEl.className = 'update-status';
    statusEl.textContent = '正在连接 GitHub Release…';
    try {
      const result = await window.updateAPI.check();
      // result 由事件驱动，这里只做超时兜底
      setTimeout(() => {
        if (checkBtn.textContent === '检查中…') {
          checkBtn.disabled = false;
          checkBtn.textContent = '检查更新';
          statusEl.className = 'update-status err';
          statusEl.textContent = '检查超时，请检查网络后重试';
        }
      }, 20000);
    } catch (err) {
      checkBtn.disabled = false;
      checkBtn.textContent = '检查更新';
      statusEl.className = 'update-status err';
      statusEl.textContent = '检查失败: ' + (err.message || err);
    }
  });

  installBtn.addEventListener('click', () => {
    window.updateAPI.install();
  });

  window.updateAPI.onUpdaterEvent(data => {
    switch (data.type) {
      case 'checking':
        statusEl.className = 'update-status';
        statusEl.textContent = '正在连接 GitHub Release…';
        break;
      case 'available':
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
        document.getElementById('update-latest-ver').style.display = 'block';
        document.getElementById('update-latest-ver-num').textContent = 'v' + data.version;
        statusEl.className = 'update-status';
        statusEl.textContent = `发现新版本 v${data.version}，正在后台下载…`;
        showToast(`发现新版本 v${data.version}`);
        break;
      case 'not-available':
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
        statusEl.className = 'update-status ok';
        statusEl.textContent = '当前已是最新版本';
        showToast('当前已是最新版本');
        break;
      case 'progress': {
        const box = document.getElementById('update-progress');
        box.classList.add('show');
        document.getElementById('update-progress-bar').style.width = (data.percent || 0) + '%';
        statusEl.className = 'update-status';
        const mb = data.transferred && data.total ? ` (${(data.transferred / 1048576).toFixed(1)} / ${(data.total / 1048576).toFixed(1)} MB)` : '';
        statusEl.textContent = `正在下载更新… ${Math.floor(data.percent || 0)}%${mb}`;
        break;
      }
      case 'downloaded':
        updateDownloaded = true;
        document.getElementById('update-progress').classList.remove('show');
        installBtn.style.display = 'inline-block';
        statusEl.className = 'update-status ok';
        statusEl.textContent = `更新已下载完成（v${data.version}），点击"重启安装"完成更新`;
        showToast('更新已下载，点击"重启安装"完成更新');
        checkBtn.style.display = 'none';
        break;
      case 'error':
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
        statusEl.className = 'update-status err';
        statusEl.textContent = '更新出错: ' + (data.message || '未知错误');
        break;
    }
  });
}

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
  initializeConfig();
  loadM3U();
  initOSD();
  initUpdaterUI();
  updateClock();
  setInterval(updateClock, 1000);

  // 解码器版本显示
  const decoders = [];
  if (typeof Hls !== 'undefined') decoders.push('hls.js ' + Hls.version);
  if (typeof flvjs !== 'undefined') decoders.push('flv.js ' + flvjs.version);
  document.getElementById('status-decoder').textContent = decoders.join(' · ') || 'no decoder';

  // 顶栏
  document.getElementById('settings-btn').addEventListener('click', () => {
    renderUrlList();
    document.getElementById('settings-modal').classList.add('open');
  });
  document.getElementById('source-pill').addEventListener('click', () => {
    renderUrlList();
    document.getElementById('settings-modal').classList.add('open');
  });
  document.getElementById('refresh-btn').addEventListener('click', () => {
    failedTracks.clear();
    loadM3U();
  });
  document.getElementById('settings-close').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('open');
  });
  document.getElementById('cancel-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('open');
  });
  document.getElementById('confirm-btn').addEventListener('click', () => {
    document.getElementById('settings-modal').classList.remove('open');
    applySelectedUrl();
  });
  document.getElementById('add-url-btn').addEventListener('click', addNewUrl);
  document.getElementById('m3u-url-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addNewUrl();
  });

  // 搜索
  document.getElementById('search-input').addEventListener('input', filterAndRender);

  // 点击遮罩关闭
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-modal')) {
      document.getElementById('settings-modal').classList.remove('open');
    }
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    const modalOpen = document.getElementById('settings-modal').classList.contains('open');
    if (e.key === 'Escape' && modalOpen) {
      document.getElementById('settings-modal').classList.remove('open');
      return;
    }
    if (modalOpen) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); switchChannel(-1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); switchChannel(1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); switchChannel(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); switchChannel(1); }
  });
});
