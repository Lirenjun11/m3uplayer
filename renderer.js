const playlistContainer = document.getElementById('playlist-container');
const channelName = document.getElementById('channel-name');
const channelGroup = document.getElementById('channel-group');

let hls = null;
let flvPlayer = null;
let channels = [];          // 去重后的频道: [{name, attributes, lines: [{url, group, attrs}]}]
let filteredChannels = [];  // 当前过滤后的频道
let currentCategory = '全部';
let currentChannelIdx = -1;
let currentLineIdx = -1;
let failedLines = new Set(); // "频道索引:线路索引"
let m3uUrl = '';
let selectedUrl = '';

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

function channelFailedKey(chIdx, lineIdx) { return chIdx + ':' + lineIdx; }

function isLineFailed(chIdx, lineIdx) {
  return failedLines.has(channelFailedKey(chIdx, lineIdx));
}

function channelAllFailed(chIdx) {
  const ch = channels[chIdx];
  if (!ch) return false;
  return ch.lines.every((_, i) => isLineFailed(chIdx, i));
}

function updateStats() {
  document.getElementById('stat-total').textContent = channels.length;
  document.getElementById('stat-failed').textContent =
    channels.reduce((n, _, i) => n + (channelAllFailed(i) ? 1 : 0), 0);
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

// 同名频道去重，合并为多线路
function buildChannels(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const name = t.name || '未知频道';
    if (!map.has(name)) {
      map.set(name, { name, attributes: { ...t.attributes }, lines: [] });
    }
    map.get(name).lines.push({
      url: t.url,
      group: t.attributes['group-title'] || '未分组',
      attrs: t.attributes
    });
  }
  return [...map.values()];
}

function primaryGroup(ch) {
  return ch.lines[0].group;
}

function detectFormatLabel(url) {
  const u = url.toLowerCase();
  if (u.includes('m3u8')) return 'HLS';
  if (u.includes('flv')) return 'FLV';
  if (u.startsWith('rtmp://')) return 'RTMP';
  if (u.includes('mp4')) return 'MP4';
  return 'LIVE';
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
  document.getElementById('standby-retry').classList.remove('show');
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

// 视频区加载动画
function showVideoLoading(name, lineIdx) {
  const el = document.getElementById('video-loading');
  document.getElementById('video-loading-name').textContent = name || '';
  document.getElementById('video-loading-text').textContent =
    lineIdx !== undefined ? `正在连接线路${lineIdx + 1}…` : '正在连接频道…';
  el.classList.add('show');
}

function hideVideoLoading() {
  document.getElementById('video-loading').classList.remove('show');
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

function setInfoBar(ch) {
  const infoLogoBox = document.getElementById('info-logo');
  const tmp = document.createElement('div');
  tmp.innerHTML = logoHTML(ch, 'info-logo');
  const el = tmp.firstChild;
  el.id = 'info-logo';
  infoLogoBox.replaceWith(el);

  channelName.textContent = ch.name;
  const fmt = detectFormatLabel(ch.lines[currentLineIdx]?.url || ch.lines[0].url);
  channelGroup.textContent = `分组: ${primaryGroup(ch)} · ${fmt}`;
  document.getElementById('stat-format').textContent = fmt;

  // 线路切换胶囊
  const lineSwitch = document.getElementById('line-switch');
  if (ch.lines.length > 1) {
    lineSwitch.style.display = 'flex';
    lineSwitch.innerHTML = ch.lines.map((l, i) => {
      const failed = isLineFailed(currentChannelIdx, i);
      return `<span class="line-pill ${i === currentLineIdx ? 'active' : ''} ${failed ? 'failed' : ''}" data-line="${i}">线路${i + 1}·${detectFormatLabel(l.url)}</span>`;
    }).join('');
    lineSwitch.querySelectorAll('.line-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        playLine(currentChannelIdx, Number(pill.dataset.line));
      });
    });
  } else {
    lineSwitch.style.display = 'none';
    lineSwitch.innerHTML = '';
  }
}

// ============ 频道列表渲染 ============
function getCategories() {
  const map = new Map();
  channels.forEach(ch => {
    const g = primaryGroup(ch);
    map.set(g, (map.get(g) || 0) + 1);
  });
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function renderCategories() {
  const bar = document.getElementById('cat-bar');
  const cats = getCategories();
  const items = [['全部', channels.length], ...cats];
  bar.innerHTML = items.map(([name, count]) => `
    <div class="cat-chip ${name === currentCategory ? 'active' : ''}" data-cat="${escapeHtml(name)}">
      ${escapeHtml(name)}<span class="count">${count}</span>
    </div>`).join('');
  bar.querySelectorAll('.cat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      if (catDragMoved) return; // 拖拽滑动结束后不触发点击
      currentCategory = chip.dataset.cat;
      renderCategories();   // 刷新胶囊选中态
      filterAndRender();    // 刷新列表
    });
  });
}

// 分类条：滚轮横滚 + 鼠标拖拽滑动
let catDragging = false, catDragStartX = 0, catDragStartScroll = 0, catDragMoved = false;
function initCatBarScroll() {
  const bar = document.getElementById('cat-bar');

  bar.addEventListener('wheel', e => {
    if (bar.scrollWidth > bar.clientWidth) {
      e.preventDefault();
      bar.scrollLeft += (e.deltaY + e.deltaX);
    }
  }, { passive: false });

  bar.addEventListener('mousedown', e => {
    if (bar.scrollWidth <= bar.clientWidth) return;
    catDragging = true;
    catDragMoved = false;
    catDragStartX = e.pageX;
    catDragStartScroll = bar.scrollLeft;
  });
  window.addEventListener('mousemove', e => {
    if (!catDragging) return;
    const dx = e.pageX - catDragStartX;
    if (Math.abs(dx) > 5) catDragMoved = true;
    bar.scrollLeft = catDragStartScroll - dx;
  });
  window.addEventListener('mouseup', () => { catDragging = false; });
}

function filterChannels() {
  const kw = document.getElementById('search-input').value.toLowerCase().trim();
  let list = currentCategory === '全部'
    ? channels
    : channels.filter(ch => primaryGroup(ch) === currentCategory);
  if (kw) {
    list = list.filter(ch => ch.name.toLowerCase().includes(kw));
  }
  return list;
}

function filterAndRender() {
  filteredChannels = filterChannels();
  updatePlaylist();
  document.getElementById('list-label').textContent =
    currentCategory === '全部' ? '频道列表' : currentCategory;
  document.getElementById('list-count').textContent = filteredChannels.length + ' 个';
}

function updatePlaylist() {
  playlistContainer.innerHTML = '';

  if (filteredChannels.length === 0) {
    playlistContainer.innerHTML = '<div class="ch-list-empty">没有匹配的频道</div>';
    return;
  }

  filteredChannels.forEach((ch, index) => {
    const originalIndex = channels.indexOf(ch);
    const item = document.createElement('div');
    item.className = 'ch-item';
    item.dataset.index = originalIndex;
    if (originalIndex === currentChannelIdx) item.classList.add('active');
    if (channelAllFailed(originalIndex)) item.classList.add('failed');

    const fmt = detectFormatLabel(ch.lines[0].url);
    const lineCount = ch.lines.length > 1 ? ` · ${ch.lines.length}线路` : '';
    const stateHtml = channelAllFailed(originalIndex)
      ? '<div class="fail-dot"></div>'
      : (originalIndex === currentChannelIdx ? '<div class="live-dot"></div>' : '');

    item.innerHTML = `
      <div class="ch-idx">${String(index + 1).padStart(2, '0')}</div>
      ${logoHTML(ch, 'ch-logo')}
      <div class="ch-meta">
        <div class="ch-name">${escapeHtml(ch.name)}</div>
        <div class="ch-sub">${escapeHtml(primaryGroup(ch))} · ${fmt}${lineCount}</div>
      </div>
      <div class="ch-state">${stateHtml}</div>`;

    item.addEventListener('click', () => {
      playChannel(ch, originalIndex);
    });

    playlistContainer.appendChild(item);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function markActiveItem(index) {
  document.querySelectorAll('.ch-item').forEach(el => {
    const idx = Number(el.dataset.index);
    const isActive = idx === index;
    el.classList.toggle('active', isActive);
    const state = el.querySelector('.ch-state');
    if (state) {
      state.innerHTML = channelAllFailed(idx) ? '<div class="fail-dot"></div>' : (isActive ? '<div class="live-dot"></div>' : '');
    }
  });
  const activeEl = playlistContainer.querySelector('.ch-item.active');
  if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 线路失效处理：标记、更新行状态，若正播该线路则自动切换下一条可用线路
function onLineFailed(chIdx, lineIdx) {
  failedLines.add(channelFailedKey(chIdx, lineIdx));
  updateStats();

  document.querySelectorAll('.ch-item').forEach(el => {
    if (Number(el.dataset.index) === chIdx && channelAllFailed(chIdx)) {
      el.classList.add('failed');
    }
  });
  updateLinePills();

  if (chIdx !== currentChannelIdx) return;

  const ch = channels[chIdx];
  const nextLine = ch.lines.findIndex((_, i) => !isLineFailed(chIdx, i));
  if (nextLine >= 0) {
    showToast(`线路${lineIdx + 1} 失效，自动切换到线路${nextLine + 1}`);
    setTimeout(() => playLine(chIdx, nextLine), 800);
  } else {
    hideVideoLoading();
    showPlayError('该频道所有线路均不可用，请选择其他频道');
    setStandby(shortLogo(ch.name), ch.name, 'ALL LINES FAILED');
    // 显示重试按钮：上游源可能只是临时故障，清除失效标记后重新连接
    document.getElementById('standby-retry').classList.add('show');
  }
}

function updateLinePills() {
  if (currentChannelIdx < 0 || currentLineIdx < 0) return;
  const ch = channels[currentChannelIdx];
  if (!ch || ch.lines.length <= 1) return;
  document.querySelectorAll('.line-pill').forEach(pill => {
    const i = Number(pill.dataset.line);
    pill.classList.toggle('active', i === currentLineIdx);
    pill.classList.toggle('failed', isLineFailed(currentChannelIdx, i));
  });
}

// ============ 播放 ============
function playChannel(ch, chIdx, lineIdx = null) {
  if (lineIdx === null) {
    // 从第一条可用线路开始
    lineIdx = ch.lines.findIndex((_, i) => !isLineFailed(chIdx, i));
    if (lineIdx < 0) lineIdx = 0;
  }
  currentChannelIdx = chIdx;
  currentLineIdx = lineIdx;

  markActiveItem(chIdx);
  setStandby(null);
  setInfoBar(ch);
  showVideoLoading(ch.name, lineIdx);

  const line = ch.lines[lineIdx];
  console.log(`开始播放频道 ${chIdx} 线路${lineIdx + 1}: ${ch.name} <- ${line.url}`);

  const video = document.getElementById('my-video');
  cleanupPlayers();
  video.pause();
  video.removeAttribute('src');
  video.load();

  const url = line.url.toLowerCase();
  // 明确的直接视频扩展名 -> 原生播放
  if (/\.(mp4|webm|ogg|ogv|mkv|mov|avi)(\?|$)/.test(url)) {
    playNative(video, line.url, chIdx, lineIdx);
  } else if (url.includes('.flv') || url.includes('/flv') || url.includes('flv?')) {
    playFLV(video, line.url, chIdx, lineIdx);
  } else if (line.url.startsWith('rtmp://')) {
    onLineFailed(chIdx, lineIdx);
    showPlayError('RTMP格式暂不支持');
    setStandby(shortLogo(ch.name), ch.name, 'RTMP NOT SUPPORTED');
  } else {
    // m3u8 及无扩展名 URL（如 /lirj/641886683，跳转后为 HLS）一律走 hls.js
    playHLS(video, line.url, chIdx, lineIdx);
  }
}

function playLine(chIdx, lineIdx) {
  playChannel(channels[chIdx], chIdx, lineIdx);
}

// HLS 解析失败时回退原生播放（每条线路只试一次）
const nativeFallbackTried = new Set();

function playHLS(video, url, chIdx, lineIdx) {
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
        onLineFailed(chIdx, lineIdx);
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
            clearTimeout(playTimeout);
            onLineFailed(chIdx, lineIdx);
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
              onLineFailed(chIdx, lineIdx);
            } else {
              hasError = false;
              hls.startLoad();
            }
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hasError = false;
            hls.recoverMediaError();
            break;
          default: {
            // manifest 解析失败/为空：URL 可能是伪装成无扩展名的直链视频，回退原生播放
            const fbKey = chIdx + ':' + lineIdx;
            if ((data.details === 'manifestParsingError' || data.details === 'manifestEmptyError') && !nativeFallbackTried.has(fbKey)) {
              nativeFallbackTried.add(fbKey);
              hasError = false;
              if (playTimeout) clearTimeout(playTimeout);
              try { hls.destroy(); } catch (e) {}
              hls = null;
              console.log('HLS解析失败，回退原生播放:', url);
              playNative(video, url, chIdx, lineIdx);
              return;
            }
            if (hls) {
              try { hls.destroy(); } catch (e) {}
              hls = null;
            }
            onLineFailed(chIdx, lineIdx);
            break;
          }
        }
      } else {
        if (data.details === 'bufferStalledError') {
          bufferStalledCount++;
          if (bufferStalledCount >= 3 && !manifestLoaded) {
            console.warn('缓冲区多次不足，可能线路无法播放');
          }
        }
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    const errorHandler = function() {
      video.removeEventListener('error', errorHandler);
      onLineFailed(chIdx, lineIdx);
    };
    video.addEventListener('error', errorHandler);
    video.play().catch(e => {
      video.removeEventListener('error', errorHandler);
      onLineFailed(chIdx, lineIdx);
    });
  } else {
    onLineFailed(chIdx, lineIdx);
    showToast('您的浏览器不支持HLS播放');
  }
}

function playFLV(video, url, chIdx, lineIdx) {
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
        onLineFailed(chIdx, lineIdx);
      }, 30000);

      flvPlayer.play().then(() => {
        if (playTimeout) clearTimeout(playTimeout);
      }).catch(e => {
        if (playTimeout) clearTimeout(playTimeout);
        onLineFailed(chIdx, lineIdx);
      });

      flvPlayer.on(flvjs.Events.ERROR, function() {
        if (playTimeout) clearTimeout(playTimeout);
        onLineFailed(chIdx, lineIdx);
      });
    } catch (e) {
      onLineFailed(chIdx, lineIdx);
    }
  } else {
    showToast('您的浏览器不支持FLV播放');
  }
}

function playNative(video, url, chIdx, lineIdx) {
  const mediaType = getMediaType(url);
  const canPlay = video.canPlayType(mediaType);

  if (canPlay === '') {
    onLineFailed(chIdx, lineIdx);
    return;
  }

  video.src = url;

  const errorHandler = function() {
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    if (playTimeout) clearTimeout(playTimeout);
    onLineFailed(chIdx, lineIdx);
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
    onLineFailed(chIdx, lineIdx);
  }, 30000);

  video.play().then(() => {
    if (playTimeout) clearTimeout(playTimeout);
  }).catch(e => {
    if (playTimeout) clearTimeout(playTimeout);
    video.removeEventListener('error', errorHandler);
    video.removeEventListener('canplay', canPlayHandler);
    onLineFailed(chIdx, lineIdx);
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
    channels = buildChannels(tracks);
    console.log(`共加载 ${tracks.length} 个频道，去重后 ${channels.length} 个频道`);

    currentCategory = '全部';
    failedLines.clear();
    currentChannelIdx = -1;
    currentLineIdx = -1;
    renderCategories();
    filterAndRender();
    updateStats();

    if (channels.length > 0) {
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

  // 视频真正出画面后隐藏加载动画
  video.addEventListener('playing', hideVideoLoading);

  // 待机画面重试按钮：清除该频道的失效标记后重新连接
  document.getElementById('standby-retry').addEventListener('click', () => {
    if (currentChannelIdx < 0) return;
    channels[currentChannelIdx].lines.forEach((_, i) => failedLines.delete(channelFailedKey(currentChannelIdx, i)));
    document.querySelectorAll('.ch-item').forEach(el => {
      if (Number(el.dataset.index) === currentChannelIdx) el.classList.remove('failed');
    });
    updateStats();
    showToast('正在重试连接…');
    playLine(currentChannelIdx, 0);
  });

  const playIconPlay = 'M8 5v14l11-7z';
  const playIconPause = 'M6 5h4v14H6zM14 5h4v14h-4z';
  document.getElementById('osd-play').addEventListener('click', () => {
    if (currentChannelIdx < 0) return;
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

  // 音量条：点击/拖动设置音量
  const vol = document.getElementById('osd-vol');
  function setVolume(e) {
    const rect = vol.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.volume = ratio;
    video.muted = false;
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

// 切换频道（在当前过滤列表内导航，跳过全失效频道）
function switchChannel(direction) {
  if (channels.length === 0) return;
  const list = filteredChannels.length > 1 ? filteredChannels : channels;
  const idxInList = list.indexOf(channels[currentChannelIdx]);
  for (let k = 1; k <= list.length; k++) {
    const next = list[(idxInList + direction * k + list.length * k) % list.length];
    const gi = channels.indexOf(next);
    if (!channelAllFailed(gi)) {
      playChannel(next, gi);
      return;
    }
  }
  showToast('没有可用频道');
}

// ============ 检查更新 ============
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
    try {
      await window.updateAPI.check();
    } catch (err) {
      // 错误通过 updater 事件处理，这里兜底
      checkBtn.disabled = false;
      checkBtn.textContent = '检查更新';
    }
    setTimeout(() => {
      if (checkBtn.textContent === '检查中…') {
        checkBtn.disabled = false;
        checkBtn.textContent = '检查更新';
        statusEl.className = 'update-status err';
        statusEl.textContent = '检查超时，请检查网络后重试';
      }
    }, 20000);
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
  initCatBarScroll();
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
    failedLines.clear();
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
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); switchChannel(-1); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); switchChannel(1); }
  });
});
