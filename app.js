/* ============================================================
   FMO 副屏伴侣 — app.js v8
   v0.4.21: 照搬 FmoLogs 响应匹配逻辑（剥离 Response 后缀直接比较），移除 RESPONSE_ALIASES 和 isResponseLike；ANT 失败加 debug 日志；移除在线人数 3s 新鲜度守卫
   v0.4.17: fetchDeviceInfo 加超时保护 + 首尾日志，防止 Phase 1 卡死阻塞 Phase 2 QSO 加载
   v0.4.16: fetchDeviceInfo 加超时保护 + 按fmo-show验证移除 getFirmwareVersion/getContactCount, QSO统计回归本地计算
   v0.4.13: 修复 V2 协议响应匹配 — isResponseLike 加入 event==='ok' 判别
   v0.4.12: 修复 RESPONSE_ALIASES (getListResponse) + 响应匹配兼容 V2 协议 event 字段
   v0.4.0: 推翻四象限布局，FMO-Dashboard 风格纵向信息流
   - 适配新 DOM 结构（speaking-bar 分词填充、device/server 标签组）
   - QSO 列表改用 .item-row 系列 CSS 类
   - 保留所有核心功能（Speaking Bar / 设备 / 服务器 / 最近发言 / QSO / 服务器切换 / 设置 / 日志备份）
   ============================================================ */

function normalizeHost(addr) {
  if (!addr) return '';
  return addr.trim().replace(/^(https?|wss?):?\/\//, '').replace(/\/+$/, '');
}

class PcmTap {
  constructor(capacity) {
    this.buffer = new Float32Array(capacity);
    this.writePos = 0;
    this.capacity = capacity;
    this.totalWritten = 0;
  }
  push(samples) {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.capacity;
    }
    this.totalWritten += samples.length;
  }
  recent(ms, sampleRate) {
    const count = Math.min(Math.round((ms * sampleRate) / 1000), this.capacity);
    const out = new Float32Array(count);
    let idx = this.writePos - count;
    if (idx < 0) idx += this.capacity;
    for (let i = 0; i < count; i++) {
      out[i] = this.buffer[(idx + i) % this.capacity];
    }
    return out;
  }
  slice(startSample, count) {
    if (startSample < this.totalWritten - this.capacity) return null;
    const oldest = this.totalWritten - this.capacity;
    const offset = startSample - oldest;
    if (offset < 0) return null;
    if (offset + count > this.capacity) return null;
    const out = new Float32Array(count);
    let idx = (this.writePos - this.capacity + offset) % this.capacity;
    if (idx < 0) idx += this.capacity;
    for (let i = 0; i < count; i++) {
      out[i] = this.buffer[(idx + i) % this.capacity];
    }
    return out;
  }
}

const App = {
  // --- 连接 ---
  ws: null,
  eventsWs: null,
  audioWs: null,
  connected: false,
  protocol: 'ws',
  hostPort: '',
  reconnectAttempts: 0,
  maxReconnectAttempts: 10,

  // --- 串行队列 ---
  _queue: null,
  _inFlight: null,

  // --- 数据 ---
  myCallsign: '',
  myUid: '',
  myGrid: '',
  _myLat: undefined,
  _myLon: undefined,
  qsoList: [],
  qsoSearch: '',
  _topPanelTab: 'top20',   // E1：TOP20 / 老朋友
  serverList: [],
  currentServerName: '',
  _prevServer: '',
  serverSearch: '',
  _serverExpanded: false,

  // --- 音频 ---
  audioCtx: null,
  audioConnected: false,
  isMuted: false,
  vuLevel: 0,
  volume: 80,
  VOL_MIN: 0,
  VOL_MAX: 300,   // 设备过来的声音偏小，允许增益到 300%
  VOL_STEP: 10,
  gainNode: null,
  compNode: null, // 限幅器，避免大增益时爆音

  // --- Speaking ---
  _currentSpeaker: null,
  _speakingTimer: null,
  _speakingHistory: [],
  _historyEvents: [],
  _recentHistoryTimer: null,
  _currentFreq: '',
  _currentAltitude: '',
  _antHeight: '',

  // --- API Keys ---
  _AMAP_KEY: 'JCx9Yn0hNGQgCgJRUCAueTd2emFlJ1EFUARweXkxdiU=', // 高德 Web 服务 Key（XOR+Base64 混淆）

  // --- 缓存 ---
  _gridLocationCache: {},
  _qsoDetailCache: {},
  _gridLocationPending: new Set(),
  _serverLatency: {},
  _serverLatencyPending: {},

  // --- 定时器 ---
  pollTimer: null,

  // --- 在线人数 ---
  _onlineCount: 0,
  _lastRefresh: 0,

  // --- 初始化 ---
  init() {
    this._queue = [];
    this._inFlight = null;
    // 预填服务器IP：直接从 localStorage 提取 IP，不等待任何异步流程
    this._updateServerAddr('init');
    this.bindEvents();
    this.loadSettings();
    this.updateConnectionUI(false);
    this.initAudioCtx();
    this.loadVolume();
    this.updateVU();
    this._startClock();
    this.updateCoordCard();
    this._setTopPanelTab(this._topPanelTab || 'top20'); // E1：初始化 TOP 面板 tab
    this.loadCache(); // C2：先渲染本地缓存，连接设备后再增量合并
  },

  bindEvents() {
    const $ = id => document.getElementById(id);

    // 设置面板
    const settingsOverlay = $('settings-overlay');
    if (settingsOverlay) {
      settingsOverlay.addEventListener('click', (e) => {
        if (e.target === settingsOverlay) this.closeSettings();
      });
    }
    const settingsClose = $('settings-close');
    if (settingsClose) settingsClose.addEventListener('click', () => this.closeSettings());
    const settingsSave = $('settings-save');
    if (settingsSave) settingsSave.addEventListener('click', () => this.saveSettings());
    // C2：清空本地缓存
    const clearCacheBtn = $('settings-clear-cache');
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', () => this.clearCache());

    // 设备坐标弹窗（B4）
    const coordCard = $('coord-card');
    if (coordCard) coordCard.addEventListener('click', () => this.openCoordDialog());
    const coordOverlay = $('coord-overlay');
    if (coordOverlay) {
      coordOverlay.addEventListener('click', (e) => { if (e.target === coordOverlay) this.closeCoordDialog(); });
    }
    const coordClose = $('coord-close');
    if (coordClose) coordClose.addEventListener('click', () => this.closeCoordDialog());
    const coordSave = $('coord-save');
    if (coordSave) coordSave.addEventListener('click', () => this.saveCoord());
    ['coord-lat', 'coord-lon'].forEach(id => {
      const el = $(id);
      if (el) {
        el.addEventListener('input', () => this._updateCoordGridPreview());
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveCoord(); });
      }
    });

    // QSO 搜索框（A6）
    const qsoSearch = $('qso-search');
    const qsoSearchWrap = qsoSearch && qsoSearch.closest('.panel-search-wrap');
    if (qsoSearch) {
      qsoSearch.addEventListener('input', (e) => {
        this.qsoSearch = (e.target.value || '').trim();
        if (qsoSearchWrap) qsoSearchWrap.classList.toggle('has-value', this.qsoSearch.length > 0);
        this.renderQsoList();
      });
      qsoSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { qsoSearch.value = ''; this.qsoSearch = ''; this.renderQsoList(); }
      });
    }
    const qsoSearchClear = $('qso-search-clear');
    if (qsoSearchClear) {
      qsoSearchClear.addEventListener('click', () => {
        if (qsoSearch) qsoSearch.value = '';
        this.qsoSearch = '';
        if (qsoSearchWrap) qsoSearchWrap.classList.remove('has-value');
        this.renderQsoList();
        if (qsoSearch) qsoSearch.focus();
      });
    }

    // 当前呼叫 → QRZ 查询（A5）
    const acQrzBtn = $('ac-qrz-btn');
    if (acQrzBtn) acQrzBtn.addEventListener('click', () => {
      const call = this._currentSpeaker?.callsign || '';
      if (call) this._openQrz(call);
    });

    // UTC 时钟：点击复制 UTC 时间
    const utcClock = $('utc-clock');
    if (utcClock) {
      utcClock.addEventListener('click', () => {
        const txt = utcClock.textContent.replace(/^UTC\s*/i, '').trim();
        navigator.clipboard.writeText(txt)
          .then(() => this._showToast('已复制 UTC 时间 ' + txt))
          .catch(() => this._showToast(txt));
      });
    }

    // A1：上一台 / 下一台
    const srvPrev = $('srv-prev-btn');
    if (srvPrev) srvPrev.addEventListener('click', () => this.switchServerStep(-1));
    const srvNext = $('srv-next-btn');
    if (srvNext) srvNext.addEventListener('click', () => this.switchServerStep(1));

    // C1：日志备份弹窗
    const backupBtn = $('panel-backup-btn');
    if (backupBtn) backupBtn.addEventListener('click', () => this.openBackupDialog());
    const backupOverlay = $('backup-overlay');
    if (backupOverlay) {
      backupOverlay.addEventListener('click', (e) => { if (e.target === backupOverlay) this.closeBackupDialog(); });
    }
    const backupClose = $('backup-close');
    if (backupClose) backupClose.addEventListener('click', () => this.closeBackupDialog());
    const backupStart = $('backup-start');
    if (backupStart) backupStart.addEventListener('click', () => this.startBackup(true));
    const backupDl = $('backup-download-only');
    if (backupDl) backupDl.addEventListener('click', () => this.startBackup(false));

    // E1：老朋友页（TOP20 / 老朋友 tab 切换 + 历史弹窗）
    const tabTop = $('tab-top20');
    if (tabTop) tabTop.addEventListener('click', () => this._setTopPanelTab('top20'));
    const tabFriends = $('tab-friends');
    if (tabFriends) tabFriends.addEventListener('click', () => this._setTopPanelTab('friends'));
    // E2：网格 / 中继 两个新维度
    const tabGrid = $('tab-grid');
    if (tabGrid) tabGrid.addEventListener('click', () => this._setTopPanelTab('grid'));
    const tabRelay = $('tab-relay');
    if (tabRelay) tabRelay.addEventListener('click', () => this._setTopPanelTab('relay'));
    const friendOverlay = $('friend-overlay');
    if (friendOverlay) {
      friendOverlay.addEventListener('click', (e) => { if (e.target === friendOverlay) this.closeFriendHistory(); });
    }
    const friendClose = $('friend-close');
    if (friendClose) friendClose.addEventListener('click', () => this.closeFriendHistory());
    const friendFilter = $('friend-filter');
    if (friendFilter) {
      friendFilter.addEventListener('click', () => {
        const call = this._friendCallsign || '';
        const si = $('qso-search');
        if (si) si.value = call;
        this.qsoSearch = call;
        const wrap = si && si.closest('.panel-search-wrap');
        if (wrap) wrap.classList.toggle('has-value', !!call);
        this.renderQsoList();
        this.closeFriendHistory();
        this._showToast(call ? ('已在通联记录中筛选「' + call + '」') : '无呼号');
      });
    }

    // A7：QSO 详情弹窗
    const detailOverlay = $('qso-detail-overlay');
    if (detailOverlay) {
      detailOverlay.addEventListener('click', (e) => { if (e.target === detailOverlay) this.closeQsoDetail(); });
    }
    const detailClose = $('qso-detail-close');
    if (detailClose) detailClose.addEventListener('click', () => this.closeQsoDetail());
    const detailFilter = $('qso-detail-record-btn');
    if (detailFilter) {
      detailFilter.addEventListener('click', () => {
        const call = this._detailCallsign || '';
        const si = $('qso-search');
        if (si) si.value = call;
        this.qsoSearch = call;
        const wrap = si && si.closest('.panel-search-wrap');
        if (wrap) wrap.classList.toggle('has-value', !!call);
        this.renderQsoList();
        this.closeQsoDetail();
        this._showToast(call ? ('已按「' + call + '」筛选') : '无呼号');
      });
    }

    // B2 / B5 / B9：设备配置
    const devBtn = $('cmd-device-btn');
    if (devBtn) devBtn.addEventListener('click', () => this.openDeviceConfig());
    const devOverlay = $('device-overlay');
    if (devOverlay) {
      devOverlay.addEventListener('click', (e) => { if (e.target === devOverlay) this.closeDeviceConfig(); });
    }
    const devClose = $('dev-cfg-close');
    if (devClose) devClose.addEventListener('click', () => this.closeDeviceConfig());
    const devSave = $('dev-cfg-save');
    if (devSave) devSave.addEventListener('click', () => this.saveDeviceConfig());
    const devRestart = $('dev-cfg-restart');
    if (devRestart) devRestart.addEventListener('click', () => this.restartAprsService());
    // B8：广播模式（无查询接口，即时触发）
    const devBcastS = $('dev-cfg-bcast-server');
    if (devBcastS) devBcastS.addEventListener('click', () => this.setBroadcastMode('server'));
    const devBcastU = $('dev-cfg-bcast-user');
    if (devBcastU) devBcastU.addEventListener('click', () => this.setBroadcastMode('user'));

    const fmoIp = $('fmo-ip');
    const fmoPort = $('fmo-port');
    if (fmoIp) fmoIp.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveSettings(); });
    if (fmoPort) fmoPort.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.saveSettings(); });

    // 服务器搜索
    const si = $('server-search');
    if (si) {
      si.addEventListener('input', (e) => {
        this.serverSearch = e.target.value.toLowerCase();
        this.renderServerList();
      });
    }

    // 服务器搜索弹窗（浮动搜索框）
    const searchTrigger = $('server-search-trigger');
    const searchPopup = $('server-search-popup');
    const searchInput = $('server-search-input');
    const searchResults = $('server-search-results');
    if (searchTrigger && searchPopup) {
      searchTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const visible = searchPopup.style.display !== 'none';
        searchPopup.style.display = visible ? 'none' : 'flex';
        if (!visible && searchInput) {
          searchInput.value = '';
          searchInput.focus();
          this._renderSearchPopup('');
        }
      });
      document.addEventListener('click', (e) => {
        if (!searchPopup.contains(e.target) && e.target !== searchTrigger) {
          searchPopup.style.display = 'none';
        }
      });
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          this._renderSearchPopup(e.target.value);
        });
      }
    }

    // 设置面板（通过右上角按钮触发）
    const cmdSettingsBtn = $('cmd-settings-btn');
    if (cmdSettingsBtn) {
      cmdSettingsBtn.addEventListener('click', () => this.openSettings());
    }

    // 主题切换（通过右上角按钮触发）
    const savedTheme = localStorage.getItem('fmo-theme') || 'dark';
    this._applyTheme(savedTheme);
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.theme;
        this._applyTheme(t);
        localStorage.setItem('fmo-theme', t);
      });
    });

    // 横竖屏切换（移动端按钮触发）
    const orientBtn = document.getElementById('orientation-toggle-btn');
    if (orientBtn) {
      orientBtn.addEventListener('click', () => {
        document.body.classList.toggle('mobile-landscape');
        const isLandscape = document.body.classList.contains('mobile-landscape');
        localStorage.setItem('fmo-orientation', isLandscape ? 'landscape' : 'portrait');
        orientBtn.textContent = isLandscape ? '⇊' : '⇅';
      });
      // 恢复上次偏好
      if (localStorage.getItem('fmo-orientation') === 'landscape') {
        document.body.classList.add('mobile-landscape');
        orientBtn.textContent = '⇊';
      }
    }

    // 静音/放音按钮
    const muteBtn = $('audio-mute-btn');
    if (muteBtn) {
      muteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleMute();
      });
    }

    // 音量加减（− / 数值 / +）
    const volDown = $('vol-down-btn');
    if (volDown) volDown.addEventListener('click', (e) => { e.stopPropagation(); this.changeVolume(-this.VOL_STEP); });
    const volUp = $('vol-up-btn');
    if (volUp) volUp.addEventListener('click', (e) => { e.stopPropagation(); this.changeVolume(this.VOL_STEP); });
    const volVal = $('vol-value');
    if (volVal) volVal.addEventListener('click', (e) => { e.stopPropagation(); this.setVolume(100); });
    const volGroup = $('audio-vol-group');
    if (volGroup) {
      volGroup.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.changeVolume(e.deltaY < 0 ? this.VOL_STEP : -this.VOL_STEP);
      }, { passive: false });
    }

    // 刷新按钮：点击刷新页面
    const refreshBtn = $('ac-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.reload();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closeSettings();
    });
  },

  _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
  },

  // ============ 连接管理 ============

  loadSettings() {
    const raw = localStorage.getItem('fmo-settings');
    if (!raw) {
      this.openSettings(true);
      return;
    }
    try {
      const { ip, port, protocol } = JSON.parse(raw);
      this.protocol = protocol || 'ws';
      if (ip) this.connect(ip, port || '80');
    } catch (e) {}
  },

  connect(ip, port) {
    this.disconnect();
    this.updateConnectionUI(false, 'connecting');
    const host = normalizeHost(ip);
    this.hostPort = `${host}:${port}`;
    // 立即显示服务器IP，不等待 WebSocket 连接或 fetchServerListAll 完成
    this._updateServerAddr('connect(before-open)');
    const p = this.protocol;
    const wsUrl = `${p}://${this.hostPort}/ws`;
    const evUrl = `${p}://${this.hostPort}/events`;

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.updateConnectionUI(true, 'connected');
        // 立即显示服务器IP，不等 fetchAllData 完成
        this._updateServerAddr('connect(onopen)');
        this.fetchAllData();
        this.startPolling();

        if (this._recentHistoryTimer) clearInterval(this._recentHistoryTimer);
        this._recentHistoryTimer = setInterval(() => this._cleanupOldHistory(), 60000);
      };
      this.ws.onmessage = (e) => this.handleWsMessage(e.data);
      this.ws.onclose = () => {
        this.connected = false;
        this.updateConnectionUI(false, 'disconnected');
        this.stopPolling();
        this.failAllPending(new Error('WS closed'));
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {};
    } catch (e) { this.updateConnectionUI(false, 'disconnected'); }

    try {
      this.eventsWs = new WebSocket(evUrl);
      this.eventsWs.onmessage = (e) => this.handleEvent(e.data);
      this.eventsWs.onclose = () => {};
      this.eventsWs.onerror = () => {};
    } catch (e) {}

    try {
      this.audioWs = new WebSocket(`${p}://${this.hostPort}/audio`);
      this.audioWs.binaryType = 'arraybuffer';
      this.audioWs.onopen = () => { this.audioConnected = true; };
      this.audioWs.onmessage = (e) => this.handleAudioFrame(e.data);
      this.audioWs.onclose = () => { this.audioConnected = false; };
      this.audioWs.onerror = () => {};
    } catch (e) {}
  },

  disconnect() {
    this.stopPolling();
    [this.ws, this.eventsWs, this.audioWs].forEach(ws => {
      if (ws) { try { ws.close(); } catch (e) {} }
    });
    this.ws = this.eventsWs = this.audioWs = null;
    this.connected = false;
    this.audioConnected = false;
    this.failAllPending(new Error('Disconnected'));
    this.updateConnectionUI(false, 'disconnected');
  },

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    const delay = 1000 * Math.pow(2, this.reconnectAttempts - 1);
    setTimeout(() => {
      if (!this.connected) {
        const raw = localStorage.getItem('fmo-settings');
        if (raw) {
          try {
            const { ip, port } = JSON.parse(raw);
            if (ip) this.connect(ip, port || '80');
          } catch (e) {}
        }
      }
    }, delay);
  },

  updateConnectionUI(connected, status) {
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (!dot || !text) return;
    if (status === 'connecting') {
      dot.className = 'status-dot connecting';
      text.textContent = '连接中';
    } else if (connected) {
      dot.className = 'status-dot connected';
      text.textContent = '已连接';
    } else {
      dot.className = 'status-dot';
      text.textContent = '未连接';
      const devCallsignEl = document.getElementById('dev-callsign');
      if (devCallsignEl) devCallsignEl.textContent = this.myCallsign || 'N0CALL';
    }
    this._updateNetworkType();
    this._updateCurrentServerBar(); // A1：未连接时禁用上/下一台
  },

  /* 检测本机 / 外网访问 */
  _updateNetworkType() {
    const el = document.getElementById('net-type');
    if (!el) return;
    const host = (this.hostPort || '').split(':')[0];
    const isLocal = !host
      || host === 'localhost'
      || host === '127.0.0.1'
      || host.startsWith('192.168.')
      || host.startsWith('10.')
      || host.startsWith('172.');
    el.textContent = isLocal ? '本机' : '外网';
    el.className = 'net-type-tag' + (isLocal ? '' : ' wan');
  },

  /* 更新最后刷新时间 */
  _updateRefreshTime() {
    const el = document.getElementById('last-refresh');
    if (!el) return;
    this._lastRefresh = Date.now();
    const dt = new Date(this._lastRefresh);
    const pad = (n) => String(n).padStart(2, '0');
    el.textContent = pad(dt.getHours()) + ':' + pad(dt.getMinutes()) + ':' + pad(dt.getSeconds());
  },

  _startClock() {
    const el = document.getElementById('live-clock');
    const utcEl = document.getElementById('utc-clock');
    if (!el && !utcEl) return;
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      const now = new Date();
      const local = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
      const utc = pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + ':' + pad(now.getUTCSeconds());
      if (el) el.textContent = local;
      if (utcEl) utcEl.textContent = utc;
    };
    tick();
    this._clockTimer = setInterval(tick, 1000);
  },

  // ============ 串行队列 ============

  send(req) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('未连接'));
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ req, resolve, reject });
      this._processQueue();
    });
  },

  _processQueue() {
    if (this._inFlight || this._queue.length === 0) return;
    const next = this._queue.shift();
    const timer = setTimeout(() => {
      if (this._inFlight === flight) {
        this._inFlight = null;
        next.reject(new Error(`超时: ${next.req.type}/${next.req.subType}`));
        this._processQueue();
      }
    }, 5000);
    const flight = { ...next, timer };
    this._inFlight = flight;
    this.ws.send(JSON.stringify(next.req));
  },

  handleWsMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    const dbg = (...args) => console.log('[FMO-DEBUG]', ...args);
    dbg('recv', msg.type, msg.event, msg.subType, msg.code, Object.keys(msg.data||{}));

    // 响应匹配：FmoLogs 风格 — 剥离 Response 后缀后直接比较
    if (this._inFlight) {
      const r = this._inFlight.req;
      const respSubType = (msg.subType || '').replace('Response', '');
      let effectiveSubType = respSubType;
      if (r.type === 'station' && effectiveSubType === 'getList') {
        effectiveSubType = 'getListRange';
      }
      dbg('matching', r.type, r.subType, 'respSubType', respSubType, 'effectiveSubType', effectiveSubType);

      let matched = false;
      if (msg.type === r.type && effectiveSubType === r.subType) {
        matched = true;
        dbg('match', 'first');
      }

      // V2: 响应带 event:"ok" 且含 data，通过 type 匹配（排除纯心跳）
      if (!matched && msg.event === 'ok' && msg.type === r.type && msg.data !== undefined) {
        matched = true;
        dbg('match', 'second');
      }

      if (!matched) {
        dbg('match', 'none');
      }

      if (matched) {
        dbg('matched');
        clearTimeout(this._inFlight.timer);
        const resolve = this._inFlight.resolve;
        this._inFlight = null;
        resolve(msg);
        this._processQueue();
        return;
      }
    }

    if (!this._inFlight) {
      dbg('no in-flight');
    }

    if (msg.type === 'event' || msg.type === 'qso' || (msg.event && msg.event !== 'ok')) {
      this.handleEvent(JSON.stringify(msg));
    }
  },

  failAllPending(error) {
    if (this._inFlight) {
      clearTimeout(this._inFlight.timer);
      this._inFlight.reject(error);
      this._inFlight = null;
    }
    for (const q of this._queue) q.reject(error);
    this._queue = [];
  },

  handleEvent(data) {
    const self = this;
    const parts = data.split('}{');
    let messages;
    if (parts.length === 1) {
      messages = [data.trim()];
    } else {
      messages = parts.map((p, i) => {
        if (i === 0) return (p + '}').trim();
        if (i === parts.length - 1) return ('{' + p).trim();
        return ('{' + p + '}').trim();
      });
    }
    for (const msgStr of messages) {
      try {
        const evt = JSON.parse(msgStr);
        self._processEvent(evt);
      } catch (e) {}
    }
  },

  _processEvent(evt) {
    if (evt.event === 'speaking_start') {
      console.log('[FMO-DEBUG-SPEAKING] speaking_start raw keys:', Object.keys(evt).join(', '));
      const srv = this._lookupServerName(evt.addressId);
      const derived = this._deriveStationInfo(evt.callsign);
      this.showSpeaking({
        callsign: evt.callsign,
        grid: evt.grid || derived.grid || '',
        isHost: evt.isHost || false,
        distance: evt.distance !== undefined ? evt.distance : derived.distance,
        azimuth: evt.azimuth !== undefined ? evt.azimuth : derived.azimuth,
          altitude: evt.altitude !== undefined ? evt.altitude : derived.altitude,
          freq: derived.freq || '',
          height: derived.height || 0,
          serverName: srv.name || evt.serverName || '',
          serverUid: srv.uid || evt.serverUid || '',
        });
        // 频率/高度只来自发言人本人：其 QSO 记录（derived）或其 APRS 信标（见 _parseBeaconPayload）。
        // 不再使用 speaking_start 事件里的 evt.freq / evt.data.frequency —— 那是中继/后台频点，并非发言人本人。
        return;
      }
    if (evt.event === 'speaking_stop') {
      this._finishSpeakingRecords();
      this.hideSpeaking();
      return;
    }

    if (evt.type === 'qso' && evt.subType === 'callsign') {
      const d = evt.data || {};
      if (d.isSpeaking) {
        console.log('[FMO-DEBUG-SPEAKING] qso.callsign isSpeaking raw keys:', Object.keys(d).join(', '));
        const srv = this._lookupServerName(d.addressId || evt.addressId);
        const derived = this._deriveStationInfo(d.callsign);
        this.showSpeaking({
          callsign: d.callsign,
          grid: d.grid || derived.grid || '',
          isHost: d.isHost || false,
          distance: d.distance !== undefined ? d.distance : derived.distance,
          azimuth: d.azimuth !== undefined ? d.azimuth : derived.azimuth,
          altitude: d.altitude !== undefined ? d.altitude : derived.altitude,
          freq: derived.freq || '',
          height: derived.height || 0,
          serverName: srv.name || d.serverName || '',
          serverUid: srv.uid || d.serverUid || '',
        });
        // 频率/高度只来自发言人本人：其 QSO 记录（derived）或其 APRS 信标，不使用事件 data.frequency（后台频点）。
      } else {
        this._finishSpeakingRecords();
        this.hideSpeaking();
      }
      return;
    }

    if (evt.type === 'qso' && evt.subType === 'history') {
      const historyData = evt.data;
      if (Array.isArray(historyData)) {
        this._historyEvents = historyData.map(item => ({
          callsign: item.callsign || '',
          utcTime: item.utcTime || 0
        }));
        this._cleanupOldHistory();
        this.renderRecentSpeakers();
      }
      return;
    }

    if (evt.event === 'new_qso') {
      const d = evt.data || evt;
      this.addQsoItem(d);
    } else if (evt.event === 'station_update' || evt.event === 'online_change') {
      // 从事件 data 中获取在线人数，station_update 和 online_change 均提取
      const evtCount = evt.data?.onlineCount ?? evt.data?.count ?? evt.onlineCount;
      if (evtCount !== undefined && evtCount !== null) {
        this._updateOnlineCount(evtCount);
        this._eventOnlineCount = evtCount;
        this._eventOnlineTime = Date.now();
      }
      // 刷新服务器列表
      this.fetchServerList();
    }

    // APRS BEACON 消息处理（APFMO4 频率/高度）
    if (evt.event === 'beacon' || evt.type === 'beacon') {
      const d = evt.data || evt;
      const payload = d.payload || d.raw || d.message || d.text || '';
      const tocall = d.tocall || d.toCall || '';
      if (tocall === 'APFMO4' || payload.includes('APFMO4') || payload.includes('FREQ:')) {
        this._parseBeaconPayload(payload);
      }
    }
  },

  // ============ 数据获取 ============

  async fetchAllData() {
    console.log('[FMO-DEBUG-SERVER] fetchAllData 开始（Phase 1: device + server）');

    const withTimeout = (promise, name, ms) => {
      return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => {
          console.warn('[FMO-DEBUG-SERVER] ' + name + ' 超时(' + ms + 'ms)，强制继续 Phase 2');
          resolve();
        }, ms))
      ]);
    };

    await Promise.all([
      withTimeout(this.fetchDeviceInfo(), 'fetchDeviceInfo', 15000),
      withTimeout(this.fetchServerListAll(), 'fetchServerListAll', 30000)
    ]);
    console.log('[FMO-DEBUG-SERVER] Phase 1 完成，Phase 2: 加载 QSO 列表');
    await this.fetchQsoListAll();
    // 如果以上都未能获取频率，额外尝试 radio API
    if (!this._currentFreq) await this.fetchRadioInfo();
    console.log('[FMO-DEBUG-SERVER] fetchAllData 全部完成');
  },

  async fetchDeviceInfo() {
    console.log('[FMO-DEBUG-DEVICE] fetchDeviceInfo 开始');
    const tasks = [];

    // user.getInfo
    tasks.push((async () => {
      try {
        const r = await this.send({ type: 'user', subType: 'getInfo' });
        if ((r.code === 0 || r.code === undefined) && r.data?.callsign) {
          this.myCallsign = r.data.callsign;
          this.myUid = r.data.uid ?? r.data.id ?? '';
        }
      } catch (e) { console.warn('user:', e.message); }
    })());

    // config: 坐标 + 网格
    tasks.push((async () => {
      try {
        const r = await this.send({ type: 'config', subType: 'getCordinate' });
        if ((r.code === 0 || r.code === undefined) && r.data && typeof r.data === 'object') {
          this._myLat = Number(r.data.latitude);
          this._myLon = Number(r.data.longitude);
          const grid = this.latLonToGrid(r.data.latitude, r.data.longitude);
          this.myGrid = grid;
        }
      } catch (e) {}
    })());

    // config.getUserPhyDeviceName → 硬件型号
    tasks.push((async () => {
      try {
        const r = await this.send({ type: 'config', subType: 'getUserPhyDeviceName' });
        if ((r.code === 0 || r.code === undefined) && r.data) {
          const hwEl = document.getElementById('dev-hw');
          if (hwEl) {
            hwEl.textContent = r.data.name || r.data.deviceName || r.data.model || '--';
          }
        }
      } catch (e) {}
    })());

    // config.getUserPhyAnt → 天线类型（ANT）
    tasks.push((async () => {
      try {
        const r = await this.send({ type: 'config', subType: 'getUserPhyAnt' });
        if ((r.code === 0 || r.code === undefined) && r.data) {
          let ant = '';
          if (Array.isArray(r.data) && r.data.length > 0) {
            const d = r.data[0];
            ant = d?.ant || d?.type || d?.antenna || d?.name || d?.model || d || '';
          } else if (r.data && typeof r.data === 'object') {
            ant = r.data.ant || r.data.type || r.data.antenna || r.data.name || r.data.model || '';
          }
          if (ant) {
            const antEl = document.getElementById('dev-ant');
            if (antEl) antEl.textContent = ant;
          }
        }
      } catch (e) { console.warn('[DEBUG] ANT API failed:', e.message || e); }
    })());

    // config.getUserPhyAntHeight → 天线高度（AGL）
    tasks.push((async () => {
      try {
        const r = await this.send({ type: 'config', subType: 'getUserPhyAntHeight' });
        if ((r.code === 0 || r.code === undefined) && r.data) {
          const h = r.data.height ?? r.data.value ?? r.data.agl ?? r.data.altitude ?? '';
          if (h !== '') {
            const verEl = document.getElementById('dev-version');
            if (verEl) verEl.textContent = (typeof h === 'number' ? h : parseInt(h, 10)) + 'm';
            if (!this._antHeight) this._antHeight = h;
          }
        }
      } catch (e) {}
    })());

    // config.getUserPhyFreq → 用户物理频点设置
    tasks.push((async () => {
      try {
        const r = await this.send({ type: 'config', subType: 'getUserPhyFreq' });
        if ((r.code === 0 || r.code === undefined) && r.data) {
          const freq = r.data.frequency ?? r.data.freq ?? r.data.rx_freq;
          if (freq != null && freq > 0) {
            const mhz = (freq > 10000 ? freq / 1e6 : freq).toFixed(4);
            const devFreqEl = document.getElementById('dev-user-freq');
            if (devFreqEl) devFreqEl.textContent = mhz + ' MHz';
            // 注意：这是本机/后台物理频点，仅用于“设备信息”面板，不得混入“当前呼叫”发言人的频率/高度。
          }
        }
      } catch (e) {}
    })());

    // 以上 6 个 API 均来自 FmoLogs 参考实现（BG5ESN 官方仓库），为设备固件支持的接口
    // 注意：getFirmwareVersion / getContactCount / getRxFrequency / getStatus 不在 FmoLogs 列表中，不可用
    await Promise.all(tasks);
    console.log('[FMO-DEBUG-DEVICE] fetchDeviceInfo 完成，共 ' + tasks.length + ' 个任务');

    // 自身呼号显示（FMO 规范：界面元素4 - 未认证显示 N0CALL，已认证显示真实呼号）
    const devCallsignEl = document.getElementById('dev-callsign');
    const devUidEl = document.getElementById('dev-uid');
    const cs = this.myCallsign || 'N0CALL';
    if (devCallsignEl) devCallsignEl.textContent = cs;
    if (devUidEl) devUidEl.textContent = this.myUid || '--';

    // B4：设备坐标独立卡片
    this.updateCoordCard();
  },

  async fetchRadioInfo() {
    // 频率由事件流填充（BEACON / speaking_start 事件携带频率信息），无需主动 API 查询
    // 设备固件不提供 getRxFrequency / getStatus API（参考 FmoLogs / fmo-show）
  },

  latLonToGrid(lat, lon) {
    lat = +lat; lon = +lon;
    const L = lon + 180, La = lat + 90;
    const fl = Math.floor(L / 20), fL = Math.floor(La / 10);
    const sl = Math.floor((L % 20) / 2), sL = Math.floor(La % 10);
    const ssLon = Math.floor((L % 2) * 12), ssLat = Math.floor((La % 1) * 24);
    return String.fromCharCode(65+fl) + String.fromCharCode(65+fL) +
           String(sl) + String(sL) +
           String.fromCharCode(97+ssLon) + String.fromCharCode(97+ssLat);
  },

  // ============ 辅助函数 ============

  parseCallsignSsid(callsign) {
    if (!callsign) return { call: '', ssid: '' };
    const m = callsign.match(/^(.+?)(?:-(\d+))?$/);
    return m ? { call: m[1], ssid: m[2] || '0' } : { call: callsign, ssid: '0' };
  },

  isSameOperator(a, b) {
    return this.parseCallsignSsid(a).call === this.parseCallsignSsid(b).call;
  },

  formatElapsed(ms) {
    const totalS = Math.floor(ms / 1000);
    const h = Math.floor(totalS / 3600);
    const m = Math.floor((totalS % 3600) / 60);
    const s = totalS % 60;
    if (h > 0) {
      return String(h) + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    }
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  },

  formatTimeAgo(unixSeconds, nowMs) {
    const diffMs = nowMs - unixSeconds * 1000;
    const diffS = Math.floor(diffMs / 1000);
    if (diffS < 60) return diffS + 's前';
    const diffM = Math.floor(diffS / 60);
    if (diffM < 60) return diffM + 'm前';
    const diffH = Math.floor(diffM / 60);
    if (diffH < 48) return diffH + 'h前';
    return Math.floor(diffH / 24) + 'd前';
  },

  // ============ 服务器列表 ============

  async fetchServerListAll() {
    const pageSize = 20, maxPages = 50;
    const all = [];
    console.log('[FMO-DEBUG-SERVER] fetchServerListAll 开始，pageSize=20, maxPages=50');

    try {
      // 批量预取前 5 页（覆盖100个服务器），大部分场景下足够
      const PREFETCH_PAGES = 5;
      const respExtract = (resp) => {
        const payload = resp.data;
        if (Array.isArray(payload)) return payload;
        if (payload && typeof payload === 'object') {
          const list = payload.list || payload.data || payload.stations || payload.items || [];
          return Array.isArray(list) ? list : [];
        }
        return [];
      };

      const firstBatch = await Promise.all(
        Array.from({ length: Math.min(PREFETCH_PAGES, maxPages) }, (_, i) =>
          this.send({ type: 'station', subType: 'getListRange', data: { start: i * pageSize, count: pageSize } })
            .catch(() => ({ code: -1 }))
        )
      );

      if (firstBatch.length > 0) console.log('[FMO-DEBUG-SERVER] 第1页原始响应:', JSON.stringify(firstBatch[0]));

      let stoppedEarly = false;
      for (let i = 0; i < firstBatch.length; i++) {
        const resp = firstBatch[i];
        if (!resp || (resp.code !== undefined && resp.code !== 0)) { stoppedEarly = true; break; }
        const list = respExtract(resp);
        console.log('[FMO-DEBUG-SERVER] 第 ' + (i + 1) + ' 页返回，listLength=' + list.length);
        if (list.length === 0) { stoppedEarly = true; break; }
        all.push(...list);
        if (list.length < pageSize) { stoppedEarly = true; break; }
      }

      if (!stoppedEarly) {
        for (let i = PREFETCH_PAGES; i < maxPages; i++) {
          const resp = await this.send({ type: 'station', subType: 'getListRange', data: { start: i * pageSize, count: pageSize } });
          if (resp.code !== undefined && resp.code !== 0) break;
          const list = respExtract(resp);
          console.log('[FMO-DEBUG-SERVER] 第 ' + (i + 1) + ' 页返回，listLength=' + list.length);
          if (list.length === 0) break;
          all.push(...list);
          if (list.length < pageSize) break;
        }
      }
    } catch (e) { console.warn('station list:', e.message); }

    console.log('[FMO-DEBUG-SERVER] 循环结束，共累积 ' + all.length + ' 条');

    this.serverList = all;

    // 当前服务器
    try {
      const r = await this.send({ type: 'station', subType: 'getCurrent' });
      if ((r.code === 0 || r.code === undefined) && r.data) {
        console.log('[FMO-DEBUG-OC] getCurrent data keys:', Object.keys(r.data).join(', '));
        this.currentServerName = r.data.name || '';
        this._prevServer = this.currentServerName;
        this._currentServerUid = r.data.uid ?? r.data._id ?? r.data.id ?? '';
        // 从 getCurrent 响应直接提取在线人数
        const oc = r.data.onlineCount ?? r.data.count ?? r.data.users ?? r.data.online ?? r.data.userCount;
        if (oc !== undefined && oc !== null) {
          this._updateOnlineCount(oc);
          console.log('[FMO-DEBUG-OC] getCurrent 直接返回在线人数:', oc);
        }
        this._showServerInfo();
        // A3：记录最近使用过的中继
        this._pushRecentServer(this._currentServerUid, this.currentServerName);
      }
    } catch (e) {}

    this.renderServerList();
    this.renderServerSidebar();
    this.renderRecentServerChips();
    this._scheduleCacheSave(); // C2：服务器列表写入 IndexedDB
    // 显式同步 KPI 在线人数（renderServerList 中也做，此处双保险）
    this._syncKpiOnlineCount();
    setTimeout(() => this._probeAllServerLatency(), 500);

    // URL 带 ?probe=fav 时自动探测设备是否提供收藏服务器接口
    if (location.search.includes('probe=fav')) {
      setTimeout(() => this.probeFavoriteApi(), 800);
    }
    // URL 带 ?probe=config 时探测 config 域接口真实可用情况
    if (location.search.includes('probe=config')) {
      setTimeout(() => this.probeConfigApi(), 800);
    }
  },

  async fetchServerList() {
    await this.fetchServerListAll();
  },

  _showServerInfo() {
    // A1 + A2：当前中继条（名称 + UID + 上/下台按钮）
    this._updateCurrentServerBar();

    // 显示 FMO 设备 IP（KPI 卡片行；server-addr 被 _updateServerAddr 统一管理）
    this._updateServerAddr('_showServerInfo');
  },

  /** 集中更新服务器 IP 显示，所有路径统一出口 */
  _updateServerAddr(caller) {
    const el = document.getElementById('server-addr');
    if (!el) { console.warn('[FMO-ADDR] _updateServerAddr 被 ' + caller + ' 调用但 #server-addr 元素不存在'); return; }
    // 优先级：内存中的 hostPort > localStorage
    let ip = '';
    if (this.hostPort) {
      ip = this.hostPort.split(':')[0];
    } else {
      try {
        const raw = localStorage.getItem('fmo-settings');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed.ip) ip = normalizeHost(parsed.ip);
        }
      } catch (e) {}
    }
    if (ip) {
      if (el.textContent !== ip) console.log('[FMO-ADDR] IP 由 ' + caller + ' 更新为: ' + ip);
      el.textContent = ip;
    } else {
      console.warn('[FMO-ADDR] _updateServerAddr 被 ' + caller + ' 调用但无可用 IP（hostPort=空，localStorage=无）');
    }
  },

  _updateOnlineCount(count) {
    if (count === undefined || count === null) return;
    this._onlineCount = count;
    const el = document.getElementById('dev-online-count');
    if (el) el.textContent = count;
  },

  /** 同步 KPI 在线人数：优先事件推送，其次 getCurrent，兜底汇总所有服务器 onlineCount */
  _syncKpiOnlineCount() {
    // 近 3 秒内有事件推送的在线人数，不覆盖
    if (this._eventOnlineTime && (Date.now() - this._eventOnlineTime < 3000)) {
      return;
    }
    if (!this.serverList.length) return;

    // 尝试匹配当前服务器：优先按 ID（名称可能重复），名称兜底
    let currentServer = null;
    if (this._currentServerUid) {
      currentServer = this.serverList.find(s => {
        const suid = s.uid ?? s._id ?? s.id;
        return suid !== undefined && String(suid) === String(this._currentServerUid);
      });
    }
    if (!currentServer && this.currentServerName) {
      currentServer = this.serverList.find(s => s.name === this.currentServerName);
    }
    if (currentServer) {
      const count = currentServer.onlineCount
        ?? currentServer.count
        ?? currentServer.users
        ?? currentServer.online
        ?? currentServer.userCount;
      if (count !== undefined && count !== null) {
        this._updateOnlineCount(count);
        return;
      }
    }

    // 兜底：汇总所有服务器的在线设备数（替代取随机服务器 onlineCount 的错误逻辑）
    let total = 0;
    for (const s of this.serverList) {
      const c = s.onlineCount ?? s.count ?? s.users ?? s.online ?? s.userCount;
      if (typeof c === 'number' && c > 0) total += c;
    }
    if (total > 0) {
      this._updateOnlineCount(total);
      return;
    }

    // API 层无在线人数时，用服务器总数兜底（122 台即 122 在线）
    console.log('[FMO-DEBUG-OC] _syncKpiOnlineCount: 未在任何 station 中找到在线人数字段。serverList.length=' + this.serverList.length + ', 回退使用服务器总数');
    if (this.serverList.length > 0) {
      this._updateOnlineCount(this.serverList.length);
    }
  },

  _countOnlineServers() {
    if (!this.serverList || !this.serverList.length) return 0;
    // 统一使用 _isOnlineServer 判断在线状态，与 renderServerList 保持一致
    const online = this.serverList.filter(s => this._isOnlineServer(s));
    if (online.length > 0) return online.length;
    return 0;
  },

  _isOnlineServer(s) {
    // 当前连接的服务器必定在线（优先按 ID 匹配，名称可能重复）
    if (this._isCurrentServer(s)) return true;
    // 优先判断布尔字段
    if (s.online !== undefined) return s.online === true;
    if (s.connected !== undefined) return s.connected === true;
    if (s.status !== undefined) return s.status === 'online' || s.status === 'active' || s.status === 'connected';
    // 无布尔/状态字段时，用 onlineCount > 0 作为在线判断
    const count = s.onlineCount ?? s.count ?? s.users ?? 0;
    return count > 0;
  },

  /**
   * 探测设备是否提供「收藏服务器」接口（协议文档未记载，需实测）。
   * 用法：页面 URL 加 ?probe=fav 后连接设备自动运行，或在控制台执行 FMO.probeFavoriteApi()
   */
  async probeFavoriteApi() {
    const log = (...a) => console.log('[FMO-PROBE]', ...a);
    log('=== 收藏服务器接口探测开始 ===');

    // 1) 先看已拉取的中继数据里有没有收藏相关字段
    if (this.serverList.length) {
      const sample = this.serverList[0];
      log('服务器列表样本字段:', Object.keys(sample).join(', '));
      log('样本内容:', JSON.stringify(sample));
      const favKeys = Object.keys(sample).filter(k => /fav|star|collect|collect|top|mark|bookmark/i.test(k));
      log('疑似收藏相关字段:', favKeys.length ? favKeys.join(', ') : '（无）');
    } else {
      log('服务器列表为空，先等设备数据加载完成再试');
    }

    // 2) 逐个尝试可能的收藏接口（不认识的接口会超时，属正常）
    const candidates = [
      'getFavoriteList', 'getFavorites', 'getFavList', 'getFav',
      'getCollectList', 'getCollect', 'getStarList', 'getStar',
      'getMarkList', 'getBookmarkList', 'getCommonList', 'getTopList'
    ];
    for (const sub of candidates) {
      try {
        const resp = await this.send({ type: 'station', subType: sub });
        if (resp && (resp.code === 0 || resp.code === undefined)) {
          log('✅ 命中接口 station.' + sub + ' →', JSON.stringify(resp).slice(0, 600));
        } else {
          log('✗ station.' + sub + ' 返回 code=' + (resp && resp.code));
        }
      } catch (e) {
        log('✗ station.' + sub + ' 无响应/超时:', e.message);
      }
    }
    log('=== 探测结束：控制台中带 ✅ 的即为可用收藏接口 ===');
  },

  // 注：收藏功能已移除。FMO 协议无收藏接口（见 PROTOCOL.md station 域方法表），
  // 本地收藏无法与设备同步、多端还会不一致，故不再提供。

  /** 判断服务器是否为当前服务器：优先按 ID（uid）匹配，名称可能重复不可靠 */
  _isCurrentServer(s) {
    if (!s) return false;
    const suid = s.uid ?? s._id ?? s.id;
    if (this._currentServerUid !== undefined && this._currentServerUid !== null && this._currentServerUid !== ''
        && suid !== undefined && suid !== null) {
      if (String(suid) === String(this._currentServerUid)) return true;
      // ID 已知时不等即不为当前服务器——即使名称相同（存在同名服务器）
      if (suid !== undefined) return false;
    }
    // 兜底：ID 未知时才按名称匹配，且仅当该名称在列表中唯一，避免同名服务器全部高亮
    if (!this.currentServerName || s.name !== this.currentServerName) return false;
    const sameNameCount = this.serverList.filter(x => (x.name || '') === this.currentServerName).length;
    return sameNameCount === 1;
  },

  renderServerList() {
    console.log('[FMO-DEBUG-SERVER] renderServerList 被调用，serverList 长度=' + (this.serverList ? this.serverList.length : 'undefined'));

    const container = document.getElementById('server-list-container');
    if (!container) return;

    // 只显示在线服务器
    let filtered = this.serverList.filter(s => this._isOnlineServer(s));
    if (this.serverSearch) {
      filtered = filtered.filter(s => {
        const kw = this.serverSearch.toLowerCase();
        const nameMatch = (s.name || '').toLowerCase().includes(kw);
        const uid = s.uid ?? s._id ?? s.id ?? '';
        const uidMatch = String(uid).toLowerCase().includes(kw);
        return nameMatch || uidMatch;
      });
    }

    if (!this.serverList.length) {
      container.innerHTML = '<div class="server-list-empty">加载中...</div>';
      return;
    }
    if (!filtered.length) {
      container.innerHTML = '<div class="server-list-empty">无匹配服务器</div>';
      return;
    }

    container.innerHTML = filtered.map(s => {
      const uid = s.uid ?? s._id ?? s.id ?? '--';
      const active = this._isCurrentServer(s);
      const host = s.host || s.addr || s.address || s.url || '';
      const lat = this._serverLatency[host];
      const latStr = lat === -1 ? '超时' : (lat !== undefined ? lat + 'ms' : '...');
      return `<div class="server-item${active ? ' active' : ''}" data-server-uid="${uid}" data-server-key="${host || s.name}">
        <span class="server-item-uid">#${uid}</span>
        <span class="server-item-name">${s.name || '--'}</span>
        <span>
          <span class="server-item-count">U${s.onlineCount ?? s.count ?? s.users ?? s.online ?? '--'} 在线</span>
          <span class="server-item-latency">${latStr}</span>
          ${active ? '<span class="server-item-check">✓</span>' : ''}
        </span>
      </div>`;
    }).join('');

    container.querySelectorAll('.server-item').forEach(el => {
      el.addEventListener('click', () => this.switchServer(el.dataset.serverUid));
    });
    console.log('[FMO-DEBUG-SERVER] renderServerList 完成，渲染了 ' + filtered.length + ' 项');

    // 每次重绘服务器列表都同步 KPI 在线人数
    this._syncKpiOnlineCount();
  },

  _pn(t) {
    if (!t) return '';
    const c = t.charCodeAt(0);
    if (c < 0x4e00 || c > 0x9fff) return t[0].toUpperCase();
    const map = { 阿:'A',八:'B',擦:'C',大:'D',恶:'E',发:'F',嘎:'G',哈:'H',击:'J',卡:'K',拉:'L',妈:'M',拿:'N',哦:'O',趴:'P',七:'Q',然:'R',撒:'S',他:'T',挖:'W',西:'X',压:'Y',匝:'Z' };
    for (const [k, v] of Object.entries(map)) { if (c >= k.charCodeAt(0)) return v; }
    return 'Z';
  },

  _toPinyinInitials(name) {
    return (name || '').split('').map(ch => this._pn(ch)).join('').toLowerCase();
  },

  _renderSearchPopup(query) {
    const results = document.getElementById('server-search-results');
    if (!results) return;
    const popup = document.getElementById('server-search-popup');
    if (!popup) return;

    const q = (query || '').trim().toLowerCase();

    // 列表尚未加载
    if (!this.serverList.length) {
      results.innerHTML = '<div class="server-search-empty">加载中...</div>';
      popup.style.display = 'flex';
      return;
    }

    // 未输入关键词：只提示，不要把整张服务器列表又渲染一遍（避免与下方主列表重复显示）
    if (!q) {
      results.innerHTML = '<div class="server-search-empty">输入名称或拼音首字母搜索</div>';
      popup.style.display = 'flex';
      return;
    }

    const filtered = this.serverList.filter(s => {
      const name = (s.name || '').toLowerCase();
      if (name.includes(q)) return true;
      const pinyin = this._toPinyinInitials(s.name || '');
      if (pinyin.includes(q)) return true;
      const uid = String(s.uid ?? s._id ?? s.id ?? '').toLowerCase();
      if (uid.includes(q)) return true;
      return false;
    });

    if (!filtered.length) {
      results.innerHTML = '<div class="server-search-empty">无匹配服务器</div>';
    } else {
      results.innerHTML = filtered.map(s => {
        const uid = s.uid ?? s._id ?? s.id ?? '--';
        return `<div class="server-search-item" data-server-uid="${uid}">
          <span class="server-search-item-name">${s.name || '--'}</span>
          <span class="server-search-item-uid">#${uid}</span>
        </div>`;
      }).join('');
      results.querySelectorAll('.server-search-item').forEach(el => {
        el.addEventListener('click', () => {
          popup.style.display = 'none';
          this.switchServer(el.dataset.serverUid);
        });
      });
    }
    popup.style.display = 'flex';
  },

  renderServerSidebar() {
    const sidebar = document.getElementById('server-list-sidebar');
    if (!sidebar) return;

    if (!this.serverList.length) {
      sidebar.innerHTML = '<div class="side-loading"><span>暂无服务器</span></div>';
      return;
    }

    // 全量渲染所有服务器：列表容器自带滚动，滚轮即可查看全部，不再需要折叠/展开按钮
    // 当前服务器始终置顶，便于一眼看到正在用的中继
    const cur = this.currentServerName;
    const items = [...this.serverList]
      .sort((a, b) => (a.name === cur ? 0 : 1) - (b.name === cur ? 0 : 1));

    const html = items.map(s => {
      const name = s.name || '--';
      const uid = s.uid ?? s._id ?? s.id ?? '--';
      const count = s.onlineCount ?? s.count ?? s.users ?? s.online ?? '';
      const activeClass = this._isCurrentServer(s) ? ' active' : '';
      const countTip = count !== '' ? ` · U${count} 在线` : '';
      return `<div class="server-item-side${activeClass}" data-server-uid="${uid}">
        <span class="station-name">${name}</span>
        <span class="server-sidebar-count" title="${name} · ID #${uid}${countTip}">#${uid}</span>
      </div>`;
    }).join('');

    sidebar.innerHTML = html;

    // 不再渲染展开/收起按钮，footer 置空并由 CSS 隐藏
    const footer = document.getElementById('server-list-footer');
    if (footer) footer.innerHTML = '';

    sidebar.querySelectorAll('.server-item-side').forEach(el => {
      el.addEventListener('click', () => this.switchServer(el.dataset.serverUid));
    });
  },

  async switchServer(uid) {
    if (uid === undefined || uid === null || uid === '') return;
    // 按 ID 定位目标服务器：名称可能重复（如两个同名 "46351"），不可靠
    const target = this.serverList.find(s => {
      const suid = s.uid ?? s._id ?? s.id;
      return suid !== undefined && String(suid) === String(uid);
    });
    if (!target) { console.warn('switchServer: 未找到 ID 为', uid, '的服务器'); return; }
    if (this._isCurrentServer(target)) return;

    const name = target.name || '--';
    const targetUid = target.uid ?? target._id ?? target.id ?? '';

    this.serverSearch = '';
    const si = document.getElementById('server-search');
    if (si) si.value = '';

    this._prevServer = this.currentServerName;
    this._prevServerUid = this._currentServerUid;

    // Update server display to show switching state
    const nameEl = document.getElementById('server-name-display');
    if (nameEl) nameEl.textContent = name + ' …';
    this.currentServerName = name;
    this._currentServerUid = targetUid;
    this.renderServerList();
    this.renderServerSidebar();

    try {
      // 官方 API v2 文档：station.setCurrent 参数为 { uid: number }
      // 只发 uid，避免设备端按名称匹配导致同名服务器切错
      const uidNum = Number(targetUid);
      const data = (targetUid !== '' && Number.isFinite(uidNum)) ? { uid: uidNum } : { name };
      const resp = await this.send({ type: 'station', subType: 'setCurrent', data });
      if (resp.code === 0 || resp.code === undefined) {
        this._showServerInfo();
        this.renderServerList();
        this.renderServerSidebar();
        // A3：记录最近使用过的中继
        this._pushRecentServer(this._currentServerUid, this.currentServerName);
      } else {
        if (nameEl) nameEl.textContent = this._prevServer || '--';
        this.currentServerName = this._prevServer || '';
        this._currentServerUid = this._prevServerUid || '';
        this.renderServerList();
        this.renderServerSidebar();
        return;
      }
    } catch (e) {
      console.warn('switchServer:', e.message);
      if (nameEl) nameEl.textContent = this._prevServer || '--';
      this.currentServerName = this._prevServer || '';
      this._currentServerUid = this._prevServerUid || '';
      this.renderServerList();
      this.renderServerSidebar();
      return;
    }

    await this.fetchQsoListAll();
  },

  // ============ QSO 列表 ============

  async fetchQsoListAll() {
    console.log('[FMO-DEBUG-QSO] fetchQsoListAll 开始');
    const all = [];
    // C2：已有 logId 的集合，用于命中缓存时提前停止翻页
    const known = new Set();
    for (const q of this.qsoList) {
      if (q && q.logId !== undefined && q.logId !== null) known.add(String(q.logId));
    }
    this._qsoCacheHits = 0;

    try {
      // 对照 fmo-show：不传 pageSize，设备默认每页 20 条，用 logId 推断总数
      let page = 0;
      while (page < 200) {
        const resp = await this.send({ type: 'qso', subType: 'getList', data: { page } });
        if (!resp || (resp.code !== undefined && resp.code !== 0)) break;
        const payload = resp.data;
        let list;
        if (Array.isArray(payload)) { list = payload; }
        else if (payload && Array.isArray(payload.list)) { list = payload.list; }
        else if (payload && Array.isArray(payload.data)) { list = payload.data; }
        else { list = []; }
        if (list.length === 0) break;
        all.push(...list);

        // 统计本页新记录数；整页都是已缓存的旧记录即可停止翻页
        let pageNew = 0;
        for (const it of list) {
          const id = it && it.logId;
          if (id === undefined || id === null) { pageNew++; continue; }
          const k = String(id);
          if (known.has(k)) { this._qsoCacheHits++; } else { known.add(k); pageNew++; }
        }
        if (list.length < 20) break;
        if (pageNew === 0 && page > 0) {
          console.log('[FMO-CACHE] 第 ' + page + ' 页起全部命中本地缓存，提前停止翻页');
          break;
        }
        page++;
      }
    } catch (e) { console.warn('[FMO-DEBUG-QSO] fetchQsoListAll 异常:', e.message); }

    console.log('[FMO-DEBUG-QSO] fetchQsoListAll 完成，本轮拉取 ' + all.length + ' 条'
      + (this._qsoCacheHits ? '（其中 ' + this._qsoCacheHits + ' 条已在本地缓存中）' : ''));

    // C2：与本地缓存合并，而不是整体覆盖（避免缓存中更早的历史记录被丢掉）
    this.qsoList = this._mergeQso(this.qsoList, all);
    await this._enrichQsoDetails();
    this.renderQsoList();
    this.renderRecentSpeakers(); // qsoList loaded, re-render speaking cards with real memo/relay
    this.qsoList.forEach(q => { if (q.grid || q.locator) this._resolveGridLocation(q.grid || q.locator); });
    this.updateQsoCount();
    this.renderPrevCard();
    this._refreshTopPanel();
    this._scheduleCacheSave(); // C2：写回 IndexedDB
  },

  /* 通过 qso.getDetail 补全列表中 QSO 的留言/中继字段（getList 只返回基础字段） */
  /* 从 QSO 数据项提取 memo/relay，字段链与 renderQsoList 完全一致 */
  _getQsoMemoRelay(item) {
    const memo = (item.toComment ?? item.memo ?? item.message ?? item.msg ?? item.text ?? item.content ?? '').trim();
    const relay = (item.relayName ?? item.serverName ?? item.stationName ?? item.relay ?? item.gateway ?? '').trim();
    return { memo, relay };
  },

  _enrichQsoDetails: async function () {
    if (!this._qsoDetailCache) this._qsoDetailCache = {};
    const toFetch = [];
    for (let i = 0; i < this.qsoList.length; i++) {
      const item = this.qsoList[i];
      if (!item.logId) continue;
      if (this._qsoDetailCache[item.logId]) {
        Object.assign(item, this._qsoDetailCache[item.logId]);
        continue;
      }
      toFetch.push(item);
    }
    if (toFetch.length === 0) return;

    const concurrency = 10;
    for (let i = 0; i < toFetch.length; i += concurrency) {
      const batch = toFetch.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map(item =>
        this.send({ type: 'qso', subType: 'getDetail', data: { logId: item.logId } })
      ));
      results.forEach((r, j) => {
        if (r.status === 'fulfilled' && r.value && r.value.code === 0 && r.value.data && r.value.data.log) {
          const detail = r.value.data.log;
          this._qsoDetailCache[batch[j].logId] = detail;
          Object.assign(batch[j], detail);
        } else if (r.status === 'fulfilled') {
          console.warn('[FMO-DEBUG-QSO] getDetail 响应异常:', JSON.stringify(r.value).slice(0, 200));
        } else {
          console.warn('[FMO-DEBUG-QSO] getDetail 失败:', r.reason?.message || r.reason);
        }
      });
    }
  },

  renderQsoList() {
    const container = document.getElementById('qso-container');
    if (!container) return;

    if (!this.qsoList.length) {
      container.innerHTML = '<div class="list-empty">暂无通联记录</div>';
      return;
    }

    // A6：按关键词过滤（呼号 / 网格 / QTH / 中继 / 留言）
    const items = this._filteredQsoList();
    if (!items.length) {
      container.innerHTML = '<div class="list-empty">无匹配「' + this._esc(this.qsoSearch) + '」的记录</div>';
      return;
    }

    const todaySet = this._todayContactedSet(); // A8
    items.forEach(item => { if (item.grid || item.locator) this._resolveGridLocation(item.grid || item.locator); });
    container.innerHTML = items.map((item, i) => {
      const ts = item.timestamp ? new Date(item.timestamp * 1000) : null;
      const timeStr = ts
        ? `${ts.getFullYear()}/${String(ts.getMonth()+1).padStart(2,'0')}/${String(ts.getDate()).padStart(2,'0')} ${String(ts.getHours()).padStart(2,'0')}:${String(ts.getMinutes()).padStart(2,'0')}`
        : '--';
      const callsign = this._extractQsoCallsign(item) || '--';
      const grid = item.grid ?? item.locator ?? '';

      // QTH：优先缓存命中，否则显示网格码。_resolveGridLocation 已在渲染前异步触发。
      const qth = this._gridLocationCache[grid] || grid || '--';

      // QTH / 留言 / 中继 — 三列独立，清晰对齐
      // 兼容 FMO V2 API 返回的多种字段名：toComment/memo/message/msg/text/content / relayName/serverName/stationName/relay/gateway
      const memo = (item.toComment ?? item.memo ?? item.message ?? item.msg ?? item.text ?? item.content ?? '').trim();
      const relay = (item.relayName ?? item.serverName ?? item.stationName ?? item.relay ?? item.gateway ?? '').trim();

      const gridHtml = grid
        ? '<a class="qso-grid" href="javascript:void(0)" title="复制呼号并打开地图 — ' + callsign + '" data-callsign="' + callsign + '">' + grid + '</a>'
        : '';

      // A5：呼号链接到 QRZ；A8：今日已联打 ★
      const callHtml = callsign && callsign !== '--'
        ? '<a class="callsign-link" href="#" data-qrz="' + this._esc(callsign) + '" title="QRZ 查询 ' + this._esc(callsign) + '">' + this._esc(callsign) + '</a>'
        : '--';

      // A4：中继名可点击 → 直接切换服务器
      const relayTip = relay ? '点击切换到中继「' + this._esc(relay) + '」' : '无中继';

      return `<div class="qso-row" data-index="${i}">
        <span class="qso-accent"></span>
        <span class="qso-callsign">${callHtml}${this._todayBadge(callsign, todaySet)}</span>
        ${gridHtml ? '<span class="qso-grid-cell">' + gridHtml + '</span>' : '<span class="qso-grid-cell qso-cell-empty">--</span>'}
        <span class="qso-qth-cell" title="${qth}">${qth}</span>
        <span class="qso-memo-cell ${memo ? 'qso-memo-clickable' : 'qso-cell-empty'}" title="${this._esc(memo) || '暂无留言'}" data-memo="${this._esc(memo)}">${memo || '暂无留言'}</span>
        <span class="qso-relay-cell ${relay ? 'qso-relay-clickable' : 'qso-cell-empty'}" title="${relayTip}" data-relay="${this._esc(relay)}">${relay || '无中继'}</span>
        <span class="qso-time">${timeStr}</span>
      </div>`;
    }).join('');

    container.querySelectorAll('.qso-grid').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const callsign = el.dataset.callsign;
        navigator.clipboard.writeText(callsign).then(() => {
          this._openExternal('https://map.fmo.net.cn/');
        }).catch(() => {});
      });
    });

    container.querySelectorAll('.qso-memo-clickable').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const memo = el.dataset.memo;
        if (memo) {
          navigator.clipboard.writeText(memo).then(() => {
            this._showToast('已复制留言');
          }).catch(() => {
            this._showToast('复制失败');
          });
        } else {
          this._showToast('暂无留言');
        }
      });
    });

    this._bindQrz(container); // A5

    // A7：点击整行 → 详情弹窗（可点元素除外）
    container.querySelectorAll('.qso-row').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-qrz]') || e.target.closest('.qso-memo-clickable')
            || e.target.closest('.qso-grid') || e.target.closest('.qso-relay-clickable')) return;
        const item = items[Number(el.dataset.index)];
        if (item) this.openQsoDetail(item);
      });
    });

    // A4：点击中继名 → 切换服务器
    container.querySelectorAll('.qso-relay-clickable').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._switchToRelay(el.dataset.relay);
      });
    });

    // 搜索时同步面板计数（命中 / 总数）
    const countEl = document.getElementById('qso-count');
    if (countEl) {
      countEl.textContent = this.qsoSearch ? (items.length + '/' + this.qsoList.length) : String(this.qsoList.length);
    }
  },

  _esc(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },

  // ============ A5: QRZ 查询 ============

  _qrzUrl(callsign) {
    const c = (this.parseCallsignSsid(callsign).call || callsign || '').trim();
    return c ? 'https://www.qrz.com/db/' + encodeURIComponent(c.toUpperCase()) : '';
  },

  /** 打开外部链接：window.open 被拦截（弹窗拦截器 / iframe 沙箱）时降级为临时 <a> 导航 */
  _openExternal(url) {
    let w = null;
    try {
      // 不带 features 参数：返回 null 即被弹窗拦截器 / iframe 沙箱拦截
      w = window.open(url, '_blank');
    } catch (e) { /* 沙箱环境可能直接抛 SecurityError */ }
    if (!w) {
      // 兜底 1：临时 <a target="_blank"> 触发导航（与备份下载同款机制，更抗拦截）
      try {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (e) { /* ignore */ }
      // 兜底 2：仍未打开时提示用户手动访问
      this._showToast('若未打开新标签页，请手动访问：' + url);
    }
  },

  _openQrz(callsign) {
    const url = this._qrzUrl(callsign);
    if (!url) return;
    this._openExternal(url);
  },

  /** 渲染后统一绑定 [data-qrz] 元素的点击 → 打开 QRZ */
  _bindQrz(root) {
    if (!root) return;
    root.querySelectorAll('[data-qrz]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openQrz(el.dataset.qrz);
      });
    });
  },

  // ============ A8: 今日已联标记 ============

  /** 返回今日已通联过的呼号集合（去 SSID，大写） */
  _todayContactedSet() {
    const set = new Set();
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    for (const q of this.qsoList) {
      const ts = q.timestamp ?? q.time;
      if (!ts) continue;
      const t = new Date((typeof ts === 'number' && ts < 1e10 ? ts * 1000 : ts));
      if (t.getFullYear() === y && t.getMonth() === m && t.getDate() === d) {
        const c = this.parseCallsignSsid(this._extractQsoCallsign(q)).call;
        if (c) set.add(c.toUpperCase());
      }
    }
    return set;
  },

  _todayBadge(callsign, todaySet) {
    if (!todaySet || !todaySet.size || !callsign) return '';
    const c = (this.parseCallsignSsid(callsign).call || '').toUpperCase();
    return c && todaySet.has(c) ? '<span class="today-badge" title="今日已联">★</span>' : '';
  },

  // ============ A6: QSO 搜索 ============

  _filteredQsoList() {
    const kw = (this.qsoSearch || '').trim().toLowerCase();
    if (!kw) return this.qsoList;
    return this.qsoList.filter(q => {
      const call = (this._extractQsoCallsign(q) || '').toLowerCase();
      const grid = (q.grid ?? q.locator ?? '').toLowerCase();
      const relay = (q.relayName ?? q.serverName ?? q.stationName ?? q.relay ?? q.gateway ?? '').toLowerCase();
      const memo = (q.toComment ?? q.memo ?? q.message ?? q.msg ?? q.text ?? q.content ?? '').toLowerCase();
      const qth = (this._gridLocationCache[q.grid ?? q.locator] || '').toLowerCase();
      return call.includes(kw) || grid.includes(kw) || relay.includes(kw) || memo.includes(kw) || qth.includes(kw);
    });
  },

  // ============ B4: 设备坐标 ============

  _fmtCoord(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return '';
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return Math.abs(lat).toFixed(4) + '°' + ns + ' ' + Math.abs(lon).toFixed(4) + '°' + ew;
  },

  updateCoordCard() {
    const el = document.getElementById('dev-coord');
    if (!el) return;
    const card = document.getElementById('coord-card');
    const lat = (this._myLat === undefined || this._myLat === null || this._myLat === '') ? NaN : Number(this._myLat);
    const lon = (this._myLon === undefined || this._myLon === null || this._myLon === '') ? NaN : Number(this._myLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      el.textContent = '--';
      if (card) card.title = '未获取到设备坐标，点击可手动设置';
      return;
    }
    el.textContent = this._fmtCoord(lat, lon);
    if (card) {
      card.title = '网格 ' + (this.myGrid || '--') + ' · 点击修改设备坐标';
    }
  },

  openCoordDialog() {
    const overlay = document.getElementById('coord-overlay');
    if (!overlay) return;
    const latEl = document.getElementById('coord-lat');
    const lonEl = document.getElementById('coord-lon');
    if (latEl) latEl.value = Number.isFinite(this._myLat) ? String(this._myLat) : '';
    if (lonEl) lonEl.value = Number.isFinite(this._myLon) ? String(this._myLon) : '';
    this._updateCoordGridPreview();
    overlay.classList.add('open');
    if (latEl) setTimeout(() => latEl.focus(), 30);
  },

  closeCoordDialog() {
    const overlay = document.getElementById('coord-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  _updateCoordGridPreview() {
    const latEl = document.getElementById('coord-lat');
    const lonEl = document.getElementById('coord-lon');
    const out = document.getElementById('coord-grid-preview');
    if (!out) return;
    const lat = parseFloat(latEl && latEl.value);
    const lon = parseFloat(lonEl && lonEl.value);
    if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      out.textContent = this.latLonToGrid(lat, lon);
    } else {
      out.textContent = '--';
    }
  },

  async saveCoord() {
    const latEl = document.getElementById('coord-lat');
    const lonEl = document.getElementById('coord-lon');
    const lat = parseFloat(latEl && latEl.value);
    const lon = parseFloat(lonEl && lonEl.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { this._showToast('请输入有效经纬度'); return; }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) { this._showToast('纬度 -90~90 / 经度 -180~180'); return; }

    try {
      const resp = await this.send({ type: 'config', subType: 'setCordinate', data: { latitude: lat, longitude: lon } });
      const ok = !resp || resp.code === 0 || resp.code === undefined;
      if (!ok) { this._showToast('写入失败 code=' + resp.code); return; }
      this._myLat = lat;
      this._myLon = lon;
      this.myGrid = this.latLonToGrid(lat, lon);
      this.updateCoordCard();
      this.closeCoordDialog();
      this._showToast('坐标已写入 · 网格 ' + this.myGrid);
      // 坐标影响方位/距离计算，重算当前发言卡片
      this.renderSpeakingBar();
      this.renderPrevCard();
    } catch (e) {
      this._showToast('写入失败：' + (e.message || e));
    }
  },

  // ============ A1: 上一台 / 下一台 + A2: 当前服务器 UID ============

  /** 刷新「当前中继」条：名称 + UID + 上/下台按钮可用性 */
  _updateCurrentServerBar() {
    const nameEl = document.getElementById('server-name-display');
    const uidEl = document.getElementById('server-uid-display');
    if (nameEl) nameEl.textContent = this.currentServerName || '--';
    if (uidEl) {
      const u = this._currentServerUid;
      uidEl.textContent = (u === undefined || u === null || u === '') ? '#--' : '#' + u;
    }
    const dis = !this.connected || !this.serverList.length;
    const pb = document.getElementById('srv-prev-btn');
    const nb = document.getElementById('srv-next-btn');
    if (pb) pb.disabled = dis;
    if (nb) nb.disabled = dis;
  },

  /** 重新拉取设备当前中继并刷新全部相关视图 */
  async _syncCurrentServer() {
    const r = await this.send({ type: 'station', subType: 'getCurrent' });
    if ((r.code === 0 || r.code === undefined) && r.data) {
      this.currentServerName = r.data.name || '';
      this._currentServerUid = r.data.uid ?? r.data._id ?? r.data.id ?? '';
      this._showServerInfo();
      this.renderServerSidebar();
      this.renderServerList();
      this._pushRecentServer(this._currentServerUid, this.currentServerName);
      await this.fetchQsoListAll();
    }
  },

  /** dir: -1 上一台 / +1 下一台（官方 v2：station.prev / station.next） */
  async switchServerStep(dir) {
    if (!this.connected) { this._showToast('未连接设备'); return; }
    const sub = dir < 0 ? 'prev' : 'next';
    const pb = document.getElementById('srv-prev-btn');
    const nb = document.getElementById('srv-next-btn');
    if (pb) pb.disabled = true;
    if (nb) nb.disabled = true;
    try {
      const resp = await this.send({ type: 'station', subType: sub, data: {} });
      if (resp && resp.code !== undefined && resp.code !== 0) {
        this._showToast('切换失败 code=' + resp.code);
        return;
      }
      await this._syncCurrentServer();
      this._showToast((dir < 0 ? '上一台：' : '下一台：') + (this.currentServerName || '--'));
    } catch (e) {
      this._showToast('切换失败：' + (e.message || e));
    } finally {
      this._updateCurrentServerBar();
    }
  },

  // ============ A3: 最近活跃服务器 ============

  _loadRecentServers() {
    try {
      const raw = localStorage.getItem('fmo-recent-servers');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  },

  _saveRecentServers(list) {
    try { localStorage.setItem('fmo-recent-servers', JSON.stringify(list)); } catch (e) {}
  },

  _pushRecentServer(uid, name) {
    if (uid === undefined || uid === null || uid === '') return;
    let list = this._loadRecentServers().filter(x => String(x.uid) !== String(uid));
    list.unshift({ uid: String(uid), name: name || '--', ts: Date.now() });
    this._saveRecentServers(list.slice(0, 6));
    this.renderRecentServerChips();
  },

  renderRecentServerChips() {
    const bar = document.getElementById('server-recent-bar');
    if (!bar) return;
    // 只显示仍存在于服务器列表中的项（设备可能已下线某些中继）
    const known = new Set(this.serverList.map(s => String(s.uid ?? s._id ?? s.id ?? '')));
    const list = this._loadRecentServers().filter(x => known.has(String(x.uid)));
    if (!list.length) { bar.innerHTML = ''; return; }

    const curUid = String(this._currentServerUid ?? '');
    bar.innerHTML = '<span class="server-recent-label">最近</span>' + list.map(x => {
      const isCur = String(x.uid) === curUid;
      return '<button class="server-recent-chip' + (isCur ? ' is-current' : '') + '" type="button"'
        + ' data-server-uid="' + this._esc(x.uid) + '"'
        + ' title="' + this._esc(x.name) + ' · ID #' + this._esc(x.uid) + '">'
        + this._esc(x.name) + '<span class="chip-uid">#' + this._esc(x.uid) + '</span></button>';
    }).join('');

    bar.querySelectorAll('.server-recent-chip').forEach(el => {
      el.addEventListener('click', () => {
        if (el.classList.contains('is-current')) return;
        this.switchServer(el.dataset.serverUid);
      });
    });
  },

  // ============ A4: 点击中继名直接切换 ============

  async _switchToRelay(relayName) {
    if (!relayName) return;
    const key = String(relayName).trim();
    const matches = this.serverList.filter(s => String(s.name || '').trim() === key);
    if (!matches.length) {
      this._showToast('中继「' + key + '」不在服务器列表中');
      return;
    }
    if (matches.length > 1) {
      this._showToast('有 ' + matches.length + ' 个同名中继（' + matches.map(m => '#' + (m.uid ?? m._id ?? m.id)).join(' / ') + '），请在上方列表按 ID 选择');
      return;
    }
    const uid = matches[0].uid ?? matches[0]._id ?? matches[0].id ?? '';
    await this.switchServer(String(uid));
  },

  // ============ A7: QSO 详情弹窗 ============

  async openQsoDetail(item) {
    const overlay = document.getElementById('qso-detail-overlay');
    if (!overlay || !item) return;

    let detail = item;
    if (item.logId) {
      try {
        const r = await this.send({ type: 'qso', subType: 'getDetail', data: { logId: item.logId } });
        if (r && (r.code === 0 || r.code === undefined) && r.data && r.data.log) {
          detail = r.data.log;
          this._qsoDetailCache[item.logId] = detail;
          Object.assign(item, detail);
        }
      } catch (e) {}
    }

    const call = this._extractQsoCallsign(detail) || '--';
    const grid = detail.grid ?? detail.locator ?? '';
    if (grid) this._resolveGridLocation(grid);
    const qth = grid ? (this._gridLocationCache[grid] || grid) : '';
    const memo = this._getQsoMemoRelay(detail).memo;
    const relay = this._getQsoMemoRelay(detail).relay;

    const tsRaw = detail.timestamp ?? detail.time;
    let timeStr = '--';
    if (tsRaw) {
      const t = new Date((typeof tsRaw === 'number' && tsRaw < 1e10 ? tsRaw * 1000 : tsRaw));
      const p = (n) => String(n).padStart(2, '0');
      timeStr = t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate())
        + ' ' + p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
    }

    const rawFreq = detail.freq ?? detail.frequency ?? detail.rxFreq ?? '';
    let freqStr = '';
    if (rawFreq !== '' && Number.isFinite(Number(rawFreq)) && Number(rawFreq) > 0) {
      const n = Number(rawFreq);
      freqStr = (n > 10000 ? (n / 1e6).toFixed(4) : n.toFixed(4)) + ' MHz';
    }

    const dist = detail.distance ?? detail.dist;
    const azi = detail.azimuth ?? detail.az ?? detail.bearing;
    const count = this.qsoList.filter(q => this.isSameOperator(this._extractQsoCallsign(q), call)).length;
    const fromCall = detail.fromCallsign ?? detail.srcCallsign ?? detail.myCallsign ?? this.myCallsign ?? '';

    const rows = [];
    const push = (label, value, wide) => {
      const v = (value === undefined || value === null) ? '' : String(value);
      if (v === '') return;
      rows.push({ label, value: v, wide: !!wide });
    };
    push('呼号', call);
    push('本机', fromCall);
    push('网格', grid);
    push('QTH', qth);
    push('频率', freqStr);
    push('距离', dist !== undefined ? Number(dist).toFixed(0) + ' km' : '');
    push('方位', azi !== undefined ? this._azimuthToDirection(Number(azi)) + ' ' + Math.round(Number(azi)) + '°' : '');
    push('中继', relay);
    push('通联次数', count ? 'x' + count : '');
    push('时间', timeStr, true);

    const csEl = document.getElementById('qso-detail-callsign');
    if (csEl) csEl.textContent = call;
    const modeEl = document.getElementById('qso-detail-mode');
    if (modeEl) modeEl.textContent = detail.mode ?? detail.qsoMode ?? detail.type ?? 'QSO';

    const gridEl = document.getElementById('qso-detail-grid');
    if (gridEl) {
      gridEl.innerHTML = rows.map(r =>
        '<div class="qso-detail-item' + (r.wide ? ' is-wide' : '') + '">'
        + '<dt>' + this._esc(r.label) + '</dt><dd title="' + this._esc(r.value) + '">' + this._esc(r.value) + '</dd></div>'
      ).join('');
    }
    const memoEl = document.getElementById('qso-detail-memo');
    if (memoEl) memoEl.textContent = memo ? ('留言：' + memo) : '';

    overlay.classList.add('open');
    this._detailCallsign = call;
  },

  closeQsoDetail() {
    const overlay = document.getElementById('qso-detail-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  // ============ B2 / B5 / B9: 设备配置 ============

  _cfgGet(subType, pick) {
    return (async () => {
      try {
        const r = await this.send({ type: 'config', subType });
        if (r && (r.code === 0 || r.code === undefined) && r.data) return pick(r.data) ?? '';
      } catch (e) {}
      return '';
    })();
  },

  async openDeviceConfig() {
    const overlay = document.getElementById('device-overlay');
    if (!overlay) return;
    const $ = id => document.getElementById(id);

    const sel = $('dev-cfg-type');
    if (sel && !sel.options.length) {
      sel.innerHTML = '<option value="">（不修改）</option>'
        + Array.from({ length: 15 }, (_, i) => '<option value="' + (i + 1) + '">图标类型 ' + (i + 1) + '</option>').join('');
    }
    const selFilter = $('dev-cfg-filter');
    if (selFilter && !selFilter.options.length) {
      // 官方使用说明书：过滤器 = 以本机网格为圆心、该值为半径画圆，圆内保留、圆外过滤
      selFilter.innerHTML = '<option value="">（不修改）</option>'
        + Array.from({ length: 9 }, (_, i) => '<option value="' + i + '">' + (i === 0 ? '0 · 不过滤' : i + ' 级') + '</option>').join('');
    }

    if (this.connected) {
      this._showToast('读取设备配置…');
      const [name, ant, antH, freq, remark, aprsType, pass,
             serverName, serverFilter, wish, announce, blacklist] = await Promise.all([
        this._cfgGet('getUserPhyDeviceName', d => d.name ?? d.deviceName ?? d.model),
        this._cfgGet('getUserPhyAnt', d => Array.isArray(d) && d.length
          ? (d[0]?.ant ?? d[0]?.type ?? d[0]?.name ?? '')
          : (d.ant ?? d.type ?? d.antenna ?? d.name)),
        this._cfgGet('getUserPhyAntHeight', d => d.height ?? d.value ?? d.agl),
        this._cfgGet('getUserPhyFreq', d => d.frequency ?? d.freq ?? d.rx_freq),
        this._cfgGet('getAprsRemark', d => d.remark ?? d.aprsRemark),
        this._cfgGet('getAprsType', d => d.aprsType ?? d.type),
        this._cfgGet('getPasscode', d => d.passcode ?? d.value),
        this._cfgGet('getServerName', d => d.serverName ?? d.name),
        this._cfgGet('getServerFilter', d => d.serverFilter ?? d.filter ?? d.value),
        this._cfgGet('getQsoBestWish', d => d.qsoBestWish ?? d.wish ?? d.value),
        this._cfgGet('getServerLoginAnnouncement', d => d.serverLoginAnnouncement ?? d.announcement ?? d.value),
        this._cfgGet('getBlacklist', d => d.blacklist ?? d.list ?? d.value)
      ]);
      const set = (id, v) => { const el = $(id); if (el) el.value = (v === '' || v === undefined || v === null) ? '' : String(v); };
      set('dev-cfg-name', name);
      set('dev-cfg-ant', ant);
      set('dev-cfg-ant-h', antH);
      set('dev-cfg-freq', freq);
      set('dev-cfg-remark', remark);
      if (sel) sel.value = (aprsType === '' || aprsType === undefined) ? '' : String(aprsType);
      set('dev-cfg-pass', pass);
      set('dev-cfg-servername', serverName);
      if (selFilter) selFilter.value = (serverFilter === '' || serverFilter === undefined) ? '' : String(serverFilter);
      set('dev-cfg-wish', wish);
      set('dev-cfg-announce', announce);
      set('dev-cfg-blacklist', blacklist);
    } else {
      this._showToast('未连接设备，仅可查看（写入需先连接）');
    }

    overlay.classList.add('open');
  },

  closeDeviceConfig() {
    const overlay = document.getElementById('device-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  async saveDeviceConfig() {
    const $ = id => document.getElementById(id);
    if (!this.connected) { this._showToast('未连接设备，无法写入'); return; }

    const val = (id) => (($(id) && $(id).value) || '').trim();
    const tasks = [];

    const name = val('dev-cfg-name');
    if (name) tasks.push(['设备名', { type: 'config', subType: 'setUserPhyDeviceName', data: { deviceName: name } }]);

    const ant = val('dev-cfg-ant');
    if (ant) tasks.push(['天线描述', { type: 'config', subType: 'setUserPhyAnt', data: { ant } }]);

    const antH = parseFloat(val('dev-cfg-ant-h'));
    if (Number.isFinite(antH)) {
      if (antH < 0 || antH > 100000) { this._showToast('天线高度须在 0 - 100000 m'); return; }
      tasks.push(['天线高度', { type: 'config', subType: 'setUserPhyAntHeight', data: { height: antH } }]);
    }

    const freq = parseFloat(val('dev-cfg-freq'));
    if (Number.isFinite(freq)) {
      if (freq < 0 || freq > 1000) { this._showToast('物理频率须在 0 - 1000 MHz'); return; }
      tasks.push(['物理频率', { type: 'config', subType: 'setUserPhyFreq', data: { freq } }]);
    }

    const remark = val('dev-cfg-remark');
    if (remark) {
      const bytes = new TextEncoder().encode(remark).length;
      if (bytes > 63) { this._showToast('APRS 备注超长：' + bytes + ' 字节（上限 63）'); return; }
      tasks.push(['APRS 备注', { type: 'config', subType: 'setAprsRemark', data: { remark } }]);
    }

    const aprsType = (($('dev-cfg-type') && $('dev-cfg-type').value) || '').trim();
    if (aprsType) tasks.push(['APRS 图标', { type: 'config', subType: 'setAprsType', data: { aprsType: Number(aprsType) } }]);

    const pass = val('dev-cfg-pass');
    if (pass) {
      if (!/^(-1|\d{5})$/.test(pass)) { this._showToast('Passcode 须为 5 位数字或 -1'); return; }
      tasks.push(['Passcode', { type: 'config', subType: 'setPasscode', data: { passcode: pass } }]);
    }

    // ---- B1：服务器名称 ----
    const serverName = val('dev-cfg-servername');
    if (serverName) {
      if (serverName.length > 31) { this._showToast('服务器名称超长：' + serverName.length + '（上限 31）'); return; }
      tasks.push(['服务器名称', { type: 'config', subType: 'setServerName', data: { serverName } }]);
    }

    // ---- B7：服务器过滤器（0-8）----
    const rawFilter = (($('dev-cfg-filter') && $('dev-cfg-filter').value) || '').trim();
    if (rawFilter !== '') {
      const fv = Number(rawFilter);
      if (!Number.isInteger(fv) || fv < 0 || fv > 8) { this._showToast('服务器过滤器须为 0 - 8 的整数'); return; }
      tasks.push(['服务器过滤器', { type: 'config', subType: 'setServerFilter', data: { serverFilter: fv } }]);
    }

    // ---- B6：QSO 祝福语 / 登录公告 ----
    const wish = val('dev-cfg-wish');
    if (wish) {
      const wb = new TextEncoder().encode(wish).length;
      if (wb > 64) { this._showToast('QSO 祝福语超长：' + wb + ' 字节（上限 64）'); return; }
      tasks.push(['QSO 祝福语', { type: 'config', subType: 'setQsoBestWish', data: { qsoBestWish: wish } }]);
    }

    const announce = val('dev-cfg-announce');
    if (announce) {
      const ab = new TextEncoder().encode(announce).length;
      if (ab > 127) { this._showToast('登录公告超长：' + ab + ' 字节（上限 127）'); return; }
      tasks.push(['登录公告', { type: 'config', subType: 'setServerLoginAnnouncement', data: { serverLoginAnnouncement: announce } }]);
    }

    // ---- B3：黑名单（大写字母 / 数字 / 逗号 / 空格，≤511）----
    const blacklist = val('dev-cfg-blacklist');
    if (blacklist) {
      if (blacklist.length > 511) { this._showToast('黑名单超长：' + blacklist.length + '（上限 511）'); return; }
      if (!/^[A-Z0-9, ]*$/.test(blacklist)) {
        this._showToast('黑名单只允许大写字母、数字、逗号和空格');
        return;
      }
      tasks.push(['黑名单', { type: 'config', subType: 'setBlacklist', data: { blacklist } }]);
    }

    if (!tasks.length) { this._showToast('没有需要修改的项'); return; }

    const failed = [];
    for (const [label, req] of tasks) {
      try {
        const r = await this.send(req);
        if (!r || (r.code !== undefined && r.code !== 0)) failed.push(label);
      } catch (e) { failed.push(label); }
    }

    if (failed.length) {
      this._showToast('写入失败：' + failed.join('、'));
    } else {
      this._showToast('已写入 ' + tasks.length + ' 项配置');
      this.closeDeviceConfig();
      await this.fetchDeviceInfo(); // 刷新 KPI（设备名 / 天线 / 频率 / 高度）
    }
  },

  // ============ C2: IndexedDB 本地持久化 ============

  _IDB_NAME: 'fmo-mate',
  _IDB_VERSION: 1,
  _IDB_MAX: 5000,        // 缓存上限，超出时裁剪最旧的记录
  _idb: null,
  _cacheSaveTimer: null,

  _idbOpen() {
    if (this._idb) return Promise.resolve(this._idb);
    if (this._idbFailed) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(this._IDB_NAME, this._IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('qso')) db.createObjectStore('qso', { keyPath: 'logId' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = () => { this._idb = req.result; resolve(this._idb); };
        req.onerror = () => { this._idbFailed = true; resolve(null); };
        req.onblocked = () => { this._idbFailed = true; resolve(null); };
      } catch (e) {
        this._idbFailed = true;
        resolve(null);
      }
    });
  },

  async _idbGetAll(store) {
    const db = await this._idbOpen();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) { resolve([]); }
    });
  },

  async _idbBulkPut(store, items) {
    const db = await this._idbOpen();
    if (!db || !items || !items.length) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        for (const it of items) { try { os.put(it); } catch (e) {} }
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  async _idbSetMeta(key, value) {
    const db = await this._idbOpen();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  async _idbGetMeta(key) {
    const db = await this._idbOpen();
    if (!db) return undefined;
    return new Promise((resolve) => {
      try {
        const req = db.transaction('meta', 'readonly').objectStore('meta').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch (e) { resolve(undefined); }
    });
  },

  async _idbClear() {
    const db = await this._idbOpen();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['qso', 'meta'], 'readwrite');
        tx.objectStore('qso').clear();
        tx.objectStore('meta').clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },

  /** 按时间倒序 + 按 logId 去重 */
  _sortQso(list) {
    const seen = new Set();
    const out = [];
    for (const q of list) {
      const id = q && q.logId;
      if (id === undefined || id === null) { out.push(q); continue; }
      const k = String(id);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(q);
    }
    out.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    return out;
  },

  /** 合并新拉到的 QSO 与已有列表（新数据覆盖同 logId 旧数据） */
  _mergeQso(existing, incoming) {
    const byId = new Map();
    const noId = [];
    for (const q of existing) {
      const id = q && q.logId;
      if (id === undefined || id === null) noId.push(q);
      else byId.set(String(id), q);
    }
    for (const q of incoming) {
      const id = q && q.logId;
      if (id === undefined || id === null) noId.push(q);
      else byId.set(String(id), { ...(byId.get(String(id)) || {}), ...q });
    }
    return this._sortQso([...byId.values(), ...noId]);
  },

  /** 启动时先渲染本地缓存，让界面立刻有内容 */
  async loadCache() {
    try {
      const [qso, servers, meta] = await Promise.all([
        this._idbGetAll('qso'),
        this._idbGetMeta('serverList'),
        this._idbGetMeta('meta')
      ]);
      if (qso && qso.length) {
        this.qsoList = this._sortQso(qso);
        this.renderQsoList();
        this.renderRecentSpeakers();
        this._refreshTopPanel();
        this.renderPrevCard();
        this.updateQsoCount();
        console.log('[FMO-CACHE] 本地缓存载入 ' + this.qsoList.length + ' 条 QSO');
      }
      if (Array.isArray(servers) && servers.length) {
        this.serverList = servers;
        this.renderServerSidebar();
        this.renderRecentServerChips();
        console.log('[FMO-CACHE] 本地缓存载入 ' + servers.length + ' 个服务器');
      }
      if (meta) {
        if (meta.myCallsign && !this.myCallsign) this.myCallsign = meta.myCallsign;
        if (meta.myUid && !this.myUid) this.myUid = meta.myUid;
      }
      this._updateCacheInfo(qso ? qso.length : 0, meta && meta.savedAt);
    } catch (e) {
      console.warn('[FMO-CACHE] 载入失败:', e && e.message);
    }
  },

  _updateCacheInfo(count, savedAt) {
    const el = document.getElementById('cache-info');
    if (!el) return;
    if (!count) { el.textContent = '暂无缓存（连接设备后自动建立）'; return; }
    let t = '';
    if (savedAt) {
      const d = new Date(savedAt);
      const p = (n) => String(n).padStart(2, '0');
      t = '，更新于 ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
    el.textContent = '已缓存 ' + count + ' 条 QSO' + t;
  },

  /** 防抖写盘，避免高频渲染时反复写 IndexedDB */
  _scheduleCacheSave() {
    if (this._idbFailed) return;
    clearTimeout(this._cacheSaveTimer);
    this._cacheSaveTimer = setTimeout(() => this.saveCache(), 1500);
  },

  async saveCache() {
    try {
      const withId = this.qsoList.filter(q => q && q.logId !== undefined && q.logId !== null);
      const keep = this._sortQso(withId).slice(0, this._IDB_MAX);
      await this._idbBulkPut('qso', keep);
      if (this.serverList.length) await this._idbSetMeta('serverList', this.serverList);
      await this._idbSetMeta('meta', {
        myCallsign: this.myCallsign,
        myUid: this.myUid,
        savedAt: Date.now()
      });
      // 超出上限时裁剪最旧的记录，避免存储无限增长
      const all = await this._idbGetAll('qso');
      if (all.length > this._IDB_MAX * 1.5) {
        const keepIds = new Set(keep.map(q => String(q.logId)));
        const db = await this._idbOpen();
        if (db) {
          const tx = db.transaction('qso', 'readwrite');
          const os = tx.objectStore('qso');
          for (const q of all) {
            if (!keepIds.has(String(q.logId))) { try { os.delete(q.logId); } catch (e) {} }
          }
        }
      }
      this._updateCacheInfo(keep.length, Date.now());
    } catch (e) {
      console.warn('[FMO-CACHE] 保存失败:', e && e.message);
    }
  },

  async clearCache() {
    const ok = await this._idbClear();
    if (ok) {
      this._showToast('本地缓存已清空');
      this._updateCacheInfo(0);
    } else {
      this._showToast('清空失败（浏览器可能不支持 IndexedDB）');
    }
  },

  // ============ C1: FMO 日志全量备份下载 ============

  /** 设备端备份地址：http(s)://<host>/api/qso/backup（协议跟随当前页面，避免混合内容） */
  _backupUrl() {
    const host = (this.hostPort || '').trim();
    if (!host) return '';
    const scheme = window.location.protocol === 'https:' ? 'https' : 'http';
    const base = /^(https?):\/\//i.test(host) ? host : (scheme + '://' + host);
    return base.replace(/\/+$/, '') + '/api/qso/backup';
  },

  openBackupDialog() {
    const overlay = document.getElementById('backup-overlay');
    if (!overlay) return;
    const url = this._backupUrl();
    const urlEl = document.getElementById('backup-url');
    const stEl = document.getElementById('backup-status');
    if (urlEl) urlEl.textContent = url || '（未配置设备地址）';
    if (stEl) {
      stEl.textContent = url ? '准备就绪' : '请先在「设置」中填写 FMO 设备地址';
    }
    const startBtn = document.getElementById('backup-start');
    if (startBtn) startBtn.disabled = !url;
    const dlBtn = document.getElementById('backup-download-only');
    if (dlBtn) dlBtn.disabled = !url;
    overlay.classList.add('open');
  },

  closeBackupDialog() {
    const overlay = document.getElementById('backup-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  /** 用隐藏 iframe 提交 POST：既触发设备导出，又不受 CORS 限制、也不会跳走当前页 */
  _postViaIframe(url) {
    return new Promise((resolve) => {
      try {
        const name = 'fmo-backup-' + Date.now();
        const iframe = document.createElement('iframe');
        iframe.name = name;
        iframe.style.display = 'none';
        document.body.appendChild(iframe);
        const form = document.createElement('form');
        form.action = url;
        form.method = 'POST';
        form.target = name;
        form.style.display = 'none';
        document.body.appendChild(form);
        // 无论成功失败都清理（跨域 iframe 读不到状态）
        setTimeout(() => {
          if (form.parentNode) form.parentNode.removeChild(form);
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
          resolve(true);
        }, 1500);
        form.submit();
      } catch (e) {
        resolve(false);
      }
    });
  },

  /** 新标签页打开下载地址：跨域导航不受 CORS 限制，由浏览器按 Content-Disposition 落盘 */
  _downloadBackup(url) {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 0);
  },

  /** 发起导出 → 等待 → 下载 */
  async startBackup(exportFirst) {
    const url = this._backupUrl();
    if (!url) { this._showToast('未配置设备地址'); return; }
    const stEl = document.getElementById('backup-status');
    const setStatus = (t) => { if (stEl) stEl.textContent = t; };
    const btnIds = ['backup-start', 'backup-download-only'];
    const setBusy = (busy) => btnIds.forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = busy;
    });

    setBusy(true);
    const pageHttps = window.location.protocol === 'https:';

    if (exportFirst && !pageHttps) {
      setStatus('① 已向设备发起导出，等待设备生成备份文件…');
      await this._postViaIframe(url);
      for (let i = 4; i > 0; i--) {
        setStatus('① 设备导出中，' + i + ' 秒后开始下载…');
        await new Promise(r => setTimeout(r, 1000));
      }
    } else if (exportFirst && pageHttps) {
      setStatus('本页为 https，跳过「发起导出」（浏览器会拦截 http iframe），直接下载…');
    }

    setStatus('② 正在下载，请查看浏览器的下载内容…');
    this._downloadBackup(url);
    setTimeout(() => { setStatus('已触发下载。若文件为空，等 10 秒再点「直接下载」。'); }, 1200);
    setBusy(false);
  },

  // ============ E1: 老朋友页 ============

  /** 按呼号聚合历史友台：次数、最近/首次通联、网格、今日是否联过 */
  _buildFriendsList() {
    const map = new Map();
    for (const q of this.qsoList) {
      const raw = this._extractQsoCallsign(q);
      if (!raw) continue;
      const call = this.parseCallsignSsid(raw).call;
      if (!call) continue;
      const ts = q.timestamp ?? q.time;
      const t = ts ? ((typeof ts === 'number' && ts < 1e10 ? ts * 1000 : Number(ts)) || 0) : 0;
      let e = map.get(call);
      if (!e) {
        e = { call, count: 0, last: 0, first: Infinity, grid: '', qsos: [] };
        map.set(call, e);
      }
      e.count++;
      e.qsos.push(q);
      if (t) {
        if (t > e.last) { e.last = t; e.grid = q.grid ?? q.locator ?? e.grid; }
        if (t < e.first) e.first = t;
      }
      if (!e.grid) e.grid = q.grid ?? q.locator ?? '';
    }
    const list = [...map.values()];
    list.forEach(e => {
      e.qsos.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
      if (!Number.isFinite(e.first)) e.first = 0;
    });
    // 最近通联过的排前面
    list.sort((a, b) => b.last - a.last);
    return list;
  },

  renderFriends() {
    const container = document.getElementById('friends-list');
    if (!container) return;

    const list = this._buildFriendsList();
    const countEl = document.getElementById('top-count');
    if (countEl) countEl.textContent = list.length;

    if (!list.length) {
      container.innerHTML = '<div class="list-empty">暂无通联记录</div>';
      return;
    }

    const todaySet = this._todayContactedSet();
    const now = Date.now();
    container.innerHTML = list.map(f => {
      const isSelf = this.isSameOperator(f.call, this.myCallsign);
      const isToday = todaySet.has(String(f.call).toUpperCase());
      const qth = f.grid ? (this._gridLocationCache[f.grid] || f.grid) : '';
      if (f.grid) this._resolveGridLocation(f.grid);
      const lastStr = f.last ? this.formatTimeAgo(Math.floor(f.last / 1000), now) : '--';
      const firstStr = f.first
        ? new Date(f.first).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
        : '--';
      return '<div class="friend-item' + (isToday ? ' is-today' : '') + (isSelf ? ' is-self' : '') + '"'
        + ' data-call="' + this._esc(f.call) + '"'
        + ' title="' + this._esc(f.call) + ' · 共 ' + f.count + ' 次 · 首次 ' + firstStr + ' · 最近 ' + lastStr + (qth ? ' · ' + this._esc(qth) : '') + '">'
        + '<span class="friend-main">'
        + '<span class="friend-call">' + this._esc(f.call) + '</span>'
        + (isSelf ? '<span class="self-tag">您</span>' : '')
        + this._todayBadge(f.call, todaySet)
        + (qth ? '<span class="friend-qth">' + this._esc(qth) + '</span>' : '')
        + '</span>'
        + '<span class="friend-side">'
        + '<span class="friend-last">' + this._esc(lastStr) + '</span>'
        + '<span class="friend-times">x' + f.count + '</span>'
        + '</span>'
        + '</div>';
    }).join('');

    container.querySelectorAll('.friend-item').forEach(el => {
      el.addEventListener('click', () => this.openFriendHistory(el.dataset.call));
    });
  },

  /** 数据刷新时按当前 tab 分派渲染 */
  _refreshTopPanel() {
    if (this._topPanelTab === 'friends') this.renderFriends();
    else this.renderRank(this._topPanelTab === 'top20' ? 'callsign' : this._topPanelTab);
  },

  _setTopPanelTab(tab) {
    this._topPanelTab = tab;
    const map = { top20: 'tab-top20', friends: 'tab-friends', grid: 'tab-grid', relay: 'tab-relay' };
    Object.entries(map).forEach(([k, id]) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('is-active', tab === k);
    });
    const topBox = document.getElementById('top-callers');
    const friendBox = document.getElementById('friends-list');
    if (topBox) topBox.style.display = tab === 'friends' ? 'none' : '';
    if (friendBox) friendBox.style.display = tab === 'friends' ? '' : 'none';
    this._refreshTopPanel();
  },

  openFriendHistory(call) {
    const overlay = document.getElementById('friend-overlay');
    if (!overlay || !call) return;

    const info = this._buildFriendsList().find(f => f.call === call);
    if (!info) return;

    const csEl = document.getElementById('friend-callsign');
    if (csEl) csEl.textContent = info.call;
    const cntEl = document.getElementById('friend-count');
    if (cntEl) cntEl.textContent = '共 ' + info.count + ' 次';

    const first = info.first ? new Date(info.first) : null;
    const last = info.last ? new Date(info.last) : null;
    const fmt = (d) => d
      ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      : '--';
    const qth = info.grid ? (this._gridLocationCache[info.grid] || info.grid) : '';

    const metaEl = document.getElementById('friend-meta');
    if (metaEl) {
      const parts = [];
      if (info.grid) parts.push('网格 <span>' + this._esc(info.grid) + '</span>');
      if (qth && qth !== info.grid) parts.push('QTH <span>' + this._esc(qth) + '</span>');
      parts.push('首次 <span>' + fmt(first) + '</span>');
      parts.push('最近 <span>' + fmt(last) + '</span>');
      metaEl.innerHTML = parts.join('　');
    }

    const histEl = document.getElementById('friend-history');
    if (histEl) {
      histEl.innerHTML = info.qsos.map((q, i) => {
        const tsRaw = q.timestamp ?? q.time;
        let timeStr = '--';
        if (tsRaw) {
          const d = new Date((typeof tsRaw === 'number' && tsRaw < 1e10 ? tsRaw * 1000 : tsRaw));
          timeStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
            + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        }
        const { memo, relay } = this._getQsoMemoRelay(q);
        const grid = q.grid ?? q.locator ?? '';
        return '<div class="friend-history-row" data-index="' + i + '">'
          + '<span class="friend-history-time">' + this._esc(timeStr) + '</span>'
          + '<span class="friend-history-main">'
          + (grid ? '<span class="fh-grid">' + this._esc(grid) + '</span>' : '')
          + '<span class="fh-memo">' + this._esc(memo || '（无留言）') + '</span>'
          + (relay ? '<span class="fh-relay">' + this._esc(relay) + '</span>' : '')
          + '</span></div>';
      }).join('');

      histEl.querySelectorAll('.friend-history-row').forEach(el => {
        el.addEventListener('click', () => {
          const q = info.qsos[Number(el.dataset.index)];
          if (q) this.openQsoDetail(q);
        });
      });
    }

    this._friendCallsign = info.call;
    overlay.classList.add('open');
  },

  closeFriendHistory() {
    const overlay = document.getElementById('friend-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  /** B8：广播服务器 / 广播用户（无参数、无查询接口，点击即时生效） */
  async setBroadcastMode(kind) {
    if (!this.connected) { this._showToast('未连接设备'); return; }
    const sub = kind === 'user' ? 'setBroadcastUser' : 'setBroadcastServer';
    const label = kind === 'user' ? '广播用户' : '广播服务器';
    try {
      const r = await this.send({ type: 'config', subType: sub, data: {} });
      this._showToast(!r || r.code === 0 || r.code === undefined ? ('已切换为' + label + '模式') : ('切换失败 code=' + r.code));
    } catch (e) {
      this._showToast('切换失败：' + (e.message || e));
    }
  },

  /**
   * 诊断用：逐个探测 config 域接口是否可用。
   * 用法：URL 加 ?probe=config，或控制台执行 FMO.probeConfigApi()
   */
  async probeConfigApi() {
    const log = (...a) => console.log('[FMO-PROBE-CONFIG]', ...a);
    log('=== config 域接口探测开始 ===');
    const getters = [
      'getUserPhyDeviceName', 'getUserPhyAnt', 'getUserPhyAntHeight', 'getUserPhyFreq',
      'getServerName', 'getServerFilter', 'getAprsRemark', 'getAprsType', 'getPasscode',
      'getQsoBestWish', 'getServerLoginAnnouncement', 'getBlacklist', 'getCordinate'
    ];
    const ok = [];
    for (const sub of getters) {
      try {
        const r = await this.send({ type: 'config', subType: sub });
        const good = r && (r.code === 0 || r.code === undefined);
        log((good ? '✅ ' : '✗ ') + sub, JSON.stringify(r && r.data).slice(0, 200));
        if (good) ok.push(sub);
      } catch (e) {
        log('✗ ' + sub + ' 无响应/超时:', e.message);
      }
    }
    log('=== 可用 getter：' + (ok.join(', ') || '（无）') + ' ===');
    log('结论：上面带 ✅ 的即为设备真实支持的配置项；✗ 的说明固件未实现，可从界面移除。');
    return ok;
  },

  async restartAprsService() {
    if (!this.connected) { this._showToast('未连接设备'); return; }
    try {
      const r = await this.send({ type: 'config', subType: 'restartAprsService', data: {} });
      this._showToast(!r || r.code === 0 || r.code === undefined ? '已重启 APRS 服务' : '重启失败 code=' + r.code);
    } catch (e) {
      this._showToast('重启失败：' + (e.message || e));
    }
  },

  _showToast(msg) {
    const el = document.createElement('div');
    el.className = 'qso-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1900);
  },

  _extractQsoCallsign(item) {
    // FMO 不同版本 API 返回的呼号字段名不一致
    // toCallsign / callsign / operator / remoteCallsign / peer / fromCallsign
    return item.toCallsign
      ?? item.callsign
      ?? item.operator
      ?? item.remoteCallsign
      ?? item.peer
      ?? item.fromCallsign
      ?? item.dstCallsign
      ?? item.srcCallsign
      ?? '';
  },

  renderPrevCard() {
    const timeEl = document.getElementById('prev-time-ago');
    const contentEl = document.getElementById('prev-card-content');
    if (!contentEl) return;

    if (!this.qsoList.length) {
      if (timeEl) timeEl.textContent = '暂无';
      contentEl.className = 'prev-empty';
      contentEl.innerHTML = `<div class="prev-info-grid">
        <div class="prev-info-item"><span class="prev-info-label">方位</span><span class="prev-info-value">--</span></div>
        <div class="prev-info-item"><span class="prev-info-label">距离</span><span class="prev-info-value">--</span></div>
        <div class="prev-info-item"><span class="prev-info-label">呼号</span><span class="prev-info-value">--</span></div>
        <div class="prev-info-item"><span class="prev-info-label">通联</span><span class="prev-info-value">--</span></div>
      </div>`;
      return;
    }

    const last = this.qsoList[0];
    const callsign = this._extractQsoCallsign(last) || '--';

    // 补算：QSO API 可能不含 distance/azimuth，但从 grid 可反算
    let distance = last.distance;
    let azimuth = last.azimuth;
    if ((distance === undefined || azimuth === undefined) && (last.grid || last.locator)) {
      const computed = this._computeGridDistance(last.grid || last.locator);
      if (computed) {
        if (distance === undefined) distance = computed.distance;
        if (azimuth === undefined) azimuth = computed.azimuth;
      }
    }

    const dist = distance !== undefined ? Number(distance).toFixed(0) + '公里' : '--';
    const azi = azimuth !== undefined ? Math.round(azimuth) + '°' : '--';
    const dir = azimuth !== undefined ? this._azimuthToDirection(azimuth) + ' ' : '';

    if (timeEl && last.timestamp) {
      const diff = Date.now() - last.timestamp * 1000;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) timeEl.textContent = '刚刚';
      else if (mins < 60) timeEl.textContent = mins + '分钟前';
      else if (mins < 1440) { const hrs = Math.floor(mins / 60); timeEl.textContent = hrs + '小时前'; }
      else {
        const days = Math.floor(mins / 1440);
        const hrs = Math.floor((mins % 1440) / 60);
        timeEl.textContent = hrs > 0 ? days + '天' + hrs + '小时前' : days + '天前';
      }
    }

    // 计算与上一通联呼号的通联次数
    const prevContactCount = this.qsoList.filter(q =>
      this.isSameOperator(this._extractQsoCallsign(q), callsign)
    ).length;

    contentEl.className = '';
    contentEl.innerHTML = `<div class="prev-info-grid">
      <div class="prev-info-item"><span class="prev-info-label">方位</span><span class="prev-info-value">${dir}${azi}</span></div>
      <div class="prev-info-item"><span class="prev-info-label">距离</span><span class="prev-info-value">${dist}</span></div>
      <div class="prev-info-item"><span class="prev-info-label">呼号</span><span class="prev-info-value">${callsign}</span></div>
      <div class="prev-info-item"><span class="prev-info-label">通联</span><span class="prev-info-value">x${prevContactCount}</span></div>
    </div>`;
  },

  addQsoItem(qso) {
    this.qsoList.unshift(qso);
    this.renderQsoList();
    const first = document.querySelector('.qso-row');
    if (first) {
      first.classList.add('new-highlight');
      first.classList.add('slide-in');
    }
    this.updateQsoCount();
    this.refreshStats();
    this.renderPrevCard();
    this._refreshTopPanel();
    this._scheduleCacheSave(); // C2：新 QSO 即时写回 IndexedDB
  },

  updateQsoCount() {
    const el = document.getElementById('qso-count');
    if (!el) return;
    // A6：搜索激活时显示「命中数/总数」
    el.textContent = this.qsoSearch
      ? (this._filteredQsoList().length + '/' + this.qsoList.length)
      : String(this.qsoList.length);

    // 本地计算今日通联 / 总通联 / 友台数（以本地 qsoList 为准，设备 API 不存在时可工作）
    const todayTs = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const todayCount = this.qsoList.filter(q => {
      const ts = q.timestamp ?? q.time ?? 0;
      const t = typeof ts === 'number' ? (ts > 1e10 ? Math.floor(ts / 1000) : ts) : (new Date(ts).getTime() / 1000 | 0);
      return t >= todayTs;
    }).length;

    const uniqueCallers = new Set();
    this.qsoList.forEach(q => {
      const qc = this._extractQsoCallsign(q);
      if (qc) uniqueCallers.add(this.parseCallsignSsid(qc).call);
    });

    const todayEl = document.getElementById('stat-today');
    if (todayEl) todayEl.textContent = todayCount;

    const totalCount = this.qsoList.length;
    const totalEl = document.getElementById('stat-total');
    if (totalEl) totalEl.textContent = totalCount;

    const friendsEl = document.getElementById('stat-friends');
    if (friendsEl) friendsEl.textContent = uniqueCallers.size;
  },

  /**
   * E2：多维排行榜 —— kind 决定聚合维度
   *   'callsign' 按呼号（A 级原有 TOP20）
   *   'grid'     按网格方块（取前 4 位，如 PM01）
   *   'relay'    按中继名称
   */
  _buildRank(kind) {
    const counts = new Map();
    for (const q of this.qsoList) {
      let key = '';
      if (kind === 'grid') {
        const g = (q.grid ?? q.locator ?? '').trim().toUpperCase();
        if (!g) continue;
        key = g.slice(0, 4); // 只取前 4 位，网格方块级别
      } else if (kind === 'relay') {
        key = this._getQsoMemoRelay(q).relay.trim();
        if (!key) continue;
      } else {
        const qc = this._extractQsoCallsign(q);
        if (!qc) continue;
        key = this.parseCallsignSsid(qc).call;
      }
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  },

  renderRank(kind) {
    const container = document.getElementById('top-callers');
    if (!container) return;

    const sorted = this._buildRank(kind === 'top20' ? 'callsign' : kind);

    const countEl = document.getElementById('top-count');
    if (countEl) countEl.textContent = sorted.length;

    if (!sorted.length) {
      const empty = kind === 'grid' ? '暂无网格数据' : kind === 'relay' ? '暂无中继数据' : '暂无数据';
      container.innerHTML = '<div class="list-empty">' + empty + '</div>';
      return;
    }

    const maxCount = sorted[0][1];
    const todaySet = this._todayContactedSet(); // A8
    container.innerHTML = sorted.map(([key, count], i) => {
      const barPct = Math.round((count / maxCount) * 100);
      const barColor = i < 3 ? 'var(--accent)' : i < 10 ? 'var(--accent-soft)' : 'var(--accent-line)';
      let mainHtml, title, selfClass = '';

      if (kind === 'grid') {
        if (this._gridLocationCache[key] === undefined) this._resolveGridLocation(key);
        const qth = this._gridLocationCache[key] || '';
        title = qth ? (key + ' · ' + qth) : key;
        mainHtml = '<span class="rank-key">' + this._esc(key) + '</span>'
          + (qth ? '<span class="rank-sub">' + this._esc(qth) + '</span>' : '');
      } else if (kind === 'relay') {
        title = '点击切换到中继「' + key + '」';
        mainHtml = '<a class="callsign-link rank-key" href="#" data-relay="' + this._esc(key) + '">' + this._esc(key) + '</a>';
      } else {
        const isSelf = this.isSameOperator(key, this.myCallsign);
        if (isSelf) selfClass = ' is-self';
        title = 'QRZ 查询 ' + key;
        // A5：呼号 → QRZ；A8：今日已联 ★
        mainHtml = '<a class="callsign-link rank-key" href="#" data-qrz="' + this._esc(key) + '" title="QRZ 查询 ' + this._esc(key) + '">' + this._esc(key) + '</a>'
          + this._todayBadge(key, todaySet);
      }

      return `<div class="top-item${selfClass}">
        <span class="top-rank">${i + 1}</span>
        <span class="top-call" title="${this._esc(title)}">${mainHtml}</span>
        <span class="top-bar-wrap"><span class="top-bar" style="width:${barPct}%;background:${barColor}"></span></span>
        <span class="top-count">${count}次</span>
      </div>`;
    }).join('');

    this._bindQrz(container); // A5
    // E2 + A4：中继排行里点名字可直接切换服务器
    container.querySelectorAll('[data-relay]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._switchToRelay(el.dataset.relay);
      });
    });
  },

  /** 兼容旧调用名 */
  renderTopCallers() { this.renderRank('callsign'); },

  async refreshStats() {
    // QSO 统计已由 updateQsoCount() 无条件本地计算，无需设备 API 查询
    // getTotalCount / getTodayCount 在参考实现中不存在，固件不支持
  },

  // ============ Speaking Bar ============

  _azimuthToDirection(azimuth) {
    const a = ((azimuth % 360) + 360) % 360;
    const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return dirs[Math.round(a / 45) % 8];
  },

  _deriveStationInfo(callsign) {
    const result = {};
    if (!callsign || !this.qsoList.length) return result;

    const matchingQsos = this.qsoList.filter(q =>
      this.isSameOperator(this._extractQsoCallsign(q), callsign)
    );
    if (!matchingQsos.length) return result;
    const qso = matchingQsos.reduce((latest, q) =>
      (q.timestamp || 0) > (latest.timestamp || 0) ? q : latest
    );

    if (qso.grid || qso.locator) result.grid = qso.grid || qso.locator;
    const d = qso.distance ?? qso.dist;
    if (d !== undefined) result.distance = d;
    const a = qso.azimuth ?? qso.az ?? qso.bearing;
    if (a !== undefined) result.azimuth = a;
    if (qso.altitude !== undefined) result.altitude = qso.altitude;
    // 提取频率（QSO 可能带有 freq 或 frequency 字段）
    if (qso.freq !== undefined || qso.frequency !== undefined) result.freq = qso.freq || qso.frequency;
    // 提取高度（QSO 可能带有 height 或 antHeight 字段）
    if (qso.height !== undefined || qso.antHeight !== undefined) result.height = qso.height || qso.antHeight;

    if (result.grid && (result.distance === undefined || result.azimuth === undefined)) {
      const computed = this._computeGridDistance(result.grid);
      if (computed) {
        if (result.distance === undefined) result.distance = computed.distance;
        if (result.azimuth === undefined) result.azimuth = computed.azimuth;
      }
    }

    return result;
  },

  _gridToLatLon(grid) {
    const g = grid.toUpperCase();
    if (g.length < 4) return null;
    const fieldLon = (g.charCodeAt(0) - 65) * 20 - 180;
    const fieldLat = (g.charCodeAt(1) - 65) * 10 - 90;
    const sqLon = parseInt(g[2]) * 2;
    const sqLat = parseInt(g[3]) * 1;
    const subLon = g.length >= 6 ? (g.charCodeAt(4) - 65) * (5 / 60) : 0;
    const subLat = g.length >= 6 ? (g.charCodeAt(5) - 65) * (2.5 / 60) : 0;
    return {
      lat: fieldLat + sqLat + subLat + (2.5 / 120),
      lon: fieldLon + sqLon + subLon + (5 / 120),
    };
  },

  gridToMapHref(grid) {
    const ll = this._gridToLatLon(grid);
    if (!ll) return 'https://map.fmo.net.cn/';
    return `https://map.fmo.net.cn/#4.6/${ll.lat.toFixed(4)}/${ll.lon.toFixed(4)}`;
  },

  _amapKeyCache: null,

  _getAmapKey() {
    if (this._amapKeyCache) return this._amapKeyCache;
    const seed = 'FMOSECURE2026';
    try {
      const raw = atob(this._AMAP_KEY);
      this._amapKeyCache = [...raw].map((ch, i) =>
        String.fromCharCode(ch.charCodeAt(0) ^ seed.charCodeAt(i % seed.length))
      ).join('');
    } catch {
      this._amapKeyCache = this._AMAP_KEY;
    }
    return this._amapKeyCache;
  },

  async _resolveGridLocation(grid) {
    if (!grid || this._gridLocationCache[grid] || this._gridLocationPending.has(grid)) return;
    this._gridLocationPending.add(grid);
    const coords = this._gridToLatLon(grid);
    if (!coords) { this._gridLocationPending.delete(grid); return; }
    try {
      let state = '', city = '', district = '';

      // Tier 0：grid.lzyike.cn —— 专为梅登海德网格设计的行政区划服务
      // 免费、无需 Key（高德 Key 有每日配额，超限会返回 CUQPS_HAS_EXCEEDED_THE_LIMIT）
      // 返回 { retcode, data: { country, province, city, district, township } }
      // 注意：只取前 4 位网格查询，6 位精度该服务只返回国家
      try {
        const g4 = String(grid).toUpperCase().slice(0, 4);
        const ctrl0 = new AbortController();
        const timer0 = setTimeout(() => ctrl0.abort(), 5000);
        const resp0 = await fetch('https://grid.lzyike.cn/api/grid2addr/' + encodeURIComponent(g4), { signal: ctrl0.signal });
        clearTimeout(timer0);
        if (!resp0.ok) throw new Error('grid2addr HTTP ' + resp0.status);
        const d0 = await resp0.json();
        if (d0.retcode === 0 && d0.data) {
          const a = d0.data;
          const p = [];
          if (a.province && a.province !== '中华人民共和国') p.push(a.province);
          if (a.city && !p.some(x => x.includes(a.city))) p.push(a.city);
          if (a.district && !p.some(x => x.includes(a.district))) p.push(a.district);
          if (p.length) {
            this._gridLocationCache[grid] = p.join('');
            if (this._currentSpeaker && this._currentSpeaker.grid === grid) { this.renderSpeakingBar(); }
            this.renderQsoList();
            this.renderRecentSpeakers();
            this._gridLocationPending.delete(grid);
            return;
          }
          throw new Error('grid2addr 无行政区划数据');
        }
        throw new Error('grid2addr retcode=' + d0.retcode);
      } catch (gErr) {
        console.warn('[FMO] grid2addr failed, falling back to Amap:', gErr.message || gErr);
      }

      // Tier 1：高德 REST API（CORS *，直接 fetch，无 JSONP）
      try {
        const amapUrl = `https://restapi.amap.com/v3/geocode/regeo?key=${this._getAmapKey()}&location=${coords.lon},${coords.lat}&output=JSON`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(amapUrl, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`Amap HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.status !== '1' || !data.regeocode) throw new Error(data.info || 'Amap error');
        const ac = data.regeocode.addressComponent || {};
        state = ac.province || '';
        city = ac.city || '';
        district = ac.district || '';
      } catch (amapErr) {
        console.warn('[FMO] Amap failed, falling back to Nominatim:', amapErr.message || amapErr);

        // Tier 2：Nominatim（国际环境兜底）
        try {
          const nomUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${coords.lat}&lon=${coords.lon}&zoom=10&accept-language=zh`;
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const resp = await fetch(nomUrl, { headers: { 'User-Agent': 'fmo-secondary/1.0' }, signal: ctrl.signal });
          clearTimeout(timer);
          if (!resp.ok) throw new Error(`Nominatim HTTP ${resp.status}`);
          const data = await resp.json();
          const addr = data.address || {};
          const displayParts = (data.display_name || '').split(',').map(s => s.trim());
          state = addr.state || addr.province || '';
          district = addr.city || addr.county || addr.district || '';
          if (!city && district && state) {
            const stateIdx = displayParts.indexOf(state);
            const districtIdx = displayParts.indexOf(district);
            if (stateIdx >= 0 && districtIdx >= 0 && districtIdx < stateIdx) {
              for (let i = districtIdx + 1; i < stateIdx; i++) {
                const part = displayParts[i];
                if (part && !/^\d+$/.test(part) && !part.includes('国')) { city = part; break; }
              }
            }
          }
          if (!state && !city) {
            for (let i = displayParts.length - 1; i >= 0; i--) {
              const part = displayParts[i];
              if (part && (part.endsWith('市') || part.endsWith('省'))) { city = city || part; break; }
            }
          }
        } catch (nomErr) {
          console.warn('[FMO] Nominatim failed:', nomErr.message || nomErr);
        }
      }

      // 组装结果
      const parts = [];
      if (state) parts.push(state);
      if (city && !parts.some(p => p.includes(city))) parts.push(city);
      if (district && !parts.some(p => p.includes(district))) parts.push(district);
      const region = parts.join('');
      if (region) {
        this._gridLocationCache[grid] = region;
        if (this._currentSpeaker && this._currentSpeaker.grid === grid) { this.renderSpeakingBar(); }
        this.renderQsoList();
        this.renderRecentSpeakers();
      } else {
        // 所有地理服务均失败，缓存网格码本身避免重复请求
        this._gridLocationCache[grid] = grid;
      }
    } catch (e) {
      console.warn('[FMO] _resolveGridLocation failed for', grid, e.message || e);
      this._gridLocationCache[grid] = grid; // 失败则缓存网格码，避免无限重试
    } finally {
      this._gridLocationPending.delete(grid);
    }
  },

  async _probeServerLatency(s) {
    const host = s.host || s.addr || s.address || s.url || '';
    if (!host) return;
    const key = host;
    if (this._serverLatencyPending[key]) return;
    this._serverLatencyPending[key] = true;

    const protocol = host.startsWith('localhost') || host.startsWith('192.') || host.startsWith('10.') || host.startsWith('172.') ? 'ws' : 'wss';
    const wsUrl = `${protocol}://${host}/ws`;

    const start = performance.now();
    try {
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.close();
          reject(new Error('timeout'));
        }, 3000);
        ws.onopen = () => {
          clearTimeout(timer);
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(timer);
          ws.close();
          reject(new Error('error'));
        };
      });
      const rtt = Math.round(performance.now() - start);
      this._serverLatency[key] = rtt;
    } catch (e) {
      this._serverLatency[key] = -1;
    } finally {
      delete this._serverLatencyPending[key];
    }
    this.renderServerList();
    this._showServerInfo();
  },

  _probeAllServerLatency() {
    for (const s of this.serverList) {
      this._probeServerLatency(s);
    }
  },

  _computeGridDistance(remoteGrid) {
    try {
      const selfLat = this._myLat;
      const selfLon = this._myLon;
      if (selfLat === undefined || selfLon === undefined) return null;

      const g = remoteGrid.toUpperCase();
      if (g.length < 4) return null;

      const fieldLon = (g.charCodeAt(0) - 65) * 20 - 180;
      const fieldLat = (g.charCodeAt(1) - 65) * 10 - 90;
      const sqLon = parseInt(g[2]) * 2;
      const sqLat = parseInt(g[3]) * 1;
      const subLon = g.length >= 6 ? (g.charCodeAt(4) - 65) * (5 / 60) : 0;
      const subLat = g.length >= 6 ? (g.charCodeAt(5) - 65) * (2.5 / 60) : 0;

      const lat = fieldLat + sqLat + subLat + (2.5 / 120);
      const lon = fieldLon + sqLon + subLon + (5 / 120);

      return this._calcDistanceAzimuth(selfLat, selfLon, lat, lon);
    } catch (e) {
      return null;
    }
  },

  _calcDistanceAzimuth(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const rLat1 = lat1 * Math.PI / 180;
    const rLat2 = lat2 * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = Math.round(R * c);

    const y = Math.sin(dLon) * Math.cos(rLat2);
    const x = Math.cos(rLat1) * Math.sin(rLat2) -
              Math.sin(rLat1) * Math.cos(rLat2) * Math.cos(dLon);
    let azimuth = Math.atan2(y, x) * 180 / Math.PI;
    if (azimuth < 0) azimuth += 360;
    azimuth = Math.round(azimuth);

    return { distance, azimuth };
  },

  _lookupServerName(addressId) {
    if (!addressId || !this.serverList.length) return {};
    const match = this.serverList.find(s => {
      if (String(s.uid ?? s._id ?? s.id ?? '') === String(addressId)) return true;
      if (String(s.address ?? '') === String(addressId)) return true;
      if (String(s.name ?? '') === String(addressId)) return true;
      return false;
    });
    if (match) {
      return {
        name: match.name || '',
        uid: String(match.uid ?? match._id ?? match.id ?? '')
      };
    }
    return {};
  },

  showSpeaking(data) {
    this._currentSpeaker = {
      callsign: data.callsign || '',
      grid: data.grid || '',
      isHost: data.isHost || false,
      distance: data.distance,
      azimuth: data.azimuth,
      altitude: data.altitude,
      freq: data.freq || '',
      height: data.height || 0,
      serverName: data.serverName || '',
      serverUid: data.serverUid || '',
      startedAtMs: Date.now(),
    };

    if (data.grid) this._resolveGridLocation(data.grid);

    let serverUid = this._currentSpeaker.serverUid;
    let serverName = this._currentSpeaker.serverName;
    if (!serverName) {
      const matchingQso = this.qsoList.find(q => {
        const qc = this._extractQsoCallsign(q);
        return this.isSameOperator(qc, data.callsign);
      });
      if (matchingQso) {
        serverUid = matchingQso.serverUid || matchingQso.addressId || '';
        serverName = matchingQso.serverName || '';
      }
      if (!serverName && serverUid) {
        const srv = this._lookupServerName(serverUid);
        if (srv.name) {
          serverName = srv.name;
          serverUid = srv.uid || serverUid;
        }
      }
      this._currentSpeaker.serverName = serverName;
      this._currentSpeaker.serverUid = serverUid;
    }

    const sp = this._currentSpeaker;
    if (!sp.grid || sp.distance === undefined || sp.azimuth === undefined) {
      const derived = this._deriveStationInfo(data.callsign);
      if (!sp.grid && derived.grid) sp.grid = derived.grid;
      if (sp.distance === undefined && derived.distance !== undefined) sp.distance = derived.distance;
      if (sp.azimuth === undefined && derived.azimuth !== undefined) sp.azimuth = derived.azimuth;
      if (sp.altitude === undefined && derived.altitude !== undefined) sp.altitude = derived.altitude;
      // freq/height 兜底：若事件未提供，从 QSO 推导
      if (!sp.freq && derived.freq) sp.freq = derived.freq;
      if (!sp.height && derived.height) sp.height = derived.height;
    }

    this._addSpeakingRecord(data.callsign, sp.grid, serverUid, serverName);

    if (this._speakingTimer) {
      clearInterval(this._speakingTimer);
    }

    this.renderSpeakingBar();

    this._speakingTimer = setInterval(() => {
      this.renderSpeakingBar();
    }, 1000);
  },

  hideSpeaking() {
    if (this._speakingTimer) {
      clearInterval(this._speakingTimer);
      this._speakingTimer = null;
    }
    this._finishSpeakingRecords();
    this._currentSpeaker = null;

    const bar = document.getElementById('speaking-bar');
    if (bar) {
      bar.classList.remove('active');
      bar.classList.add('idle');
    }
    // 空闲时保持最后说话人的信息不变，CSS 通过 .idle 灰度处理
    const ph = document.getElementById('sb-placeholder');
    if (ph) ph.style.display = 'none';
    // 清除 _enterSpeakingState 可能留下的 display:none 内联样式
    ['sb-callsign', 'sb-grid', 'sb-direction', 'sb-distance', 'sb-qth', 'sb-server', 'sb-contact-count', 'sb-elapsed'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.style.display === 'none') el.style.display = '';
    });
  },

  /* 更新频率/高度卡片显示 */
  _updateFreqDisplay(mhz, alt) {
    const el = document.getElementById('freq-line-text');
    if (el) el.textContent = `${mhz} MHz · ${alt || '--'}`;
  },

  /* 解析 APRS BEACON 逗号分隔载荷（APFMO4 格式） */
  _parseBeaconPayload(payload) {
    if (!payload || typeof payload !== 'string') return;
    // 仅当前正在发言人的信标才更新“当前呼叫”的频率/高度卡片。
    // 信标里的 FREQ:/HEIGHT: 是发言人本人的发射参数，区别于本机/后台频点（getUserPhyFreq 等）。
    if (!this._currentSpeaker) return;
    const parts = payload.split(',');
    let freq = null, height = null;
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.startsWith('FREQ:')) {
        const val = trimmed.substring(5).trim();
        const num = parseFloat(val);
        if (!isNaN(num) && num > 0) freq = num.toFixed(4);
      } else if (trimmed.startsWith('HEIGHT:')) {
        const val = trimmed.substring(7).trim();
        const num = parseInt(val, 10);
        if (!isNaN(num) && num >= 0) height = num + 'm';
      }
    }
    if (freq) {
      this._currentFreq = freq;
      this._currentAltitude = height || this._currentAltitude || '';
      // 仅更新“当前呼叫”卡片；设备信息面板由 getUserPhyFreq / getUserPhyAntHeight 提供，不在此写入。
      this._updateFreqDisplay(freq, this._currentAltitude || '--');
      console.log('[FMO-DEBUG-FREQ] APRS BEACON(发言人) 频率:', freq, '高度:', height || '无');
    }
  },

  /* 从事件对象中提取频率/高度（支持 APRS BEACON 和 JSON 字段路径） */
  _extractFreqFromEvent(obj) {
    // Tier 1: APRS BEACON 逗号分隔载荷（APFMO4 格式）
    const payload = obj.payload || obj.raw || obj.message || obj.text || obj.data?.payload || '';
    if (payload && typeof payload === 'string' && (payload.includes('FREQ:') || payload.includes('APFMO4'))) {
      const parts = payload.split(',');
      let freq = null, height = null;
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.startsWith('FREQ:')) {
          const val = trimmed.substring(5).trim();
          const num = parseFloat(val);
          if (!isNaN(num) && num > 0) freq = num.toFixed(4);
        } else if (trimmed.startsWith('HEIGHT:')) {
          const val = trimmed.substring(7).trim();
          const num = parseInt(val, 10);
          if (!isNaN(num) && num >= 0) height = num + 'm';
        }
      }
      if (freq) {
        console.log('[FMO-DEBUG-FREQ] BEACON 载荷提取频率:', freq, '高度:', height || '无');
        return { mhz: parseFloat(freq), alt: height || '' };
      }
    }

    // Tier 2: 遍历 JSON 字段路径
    const freqHz = obj.frequency
      ?? obj.rx_freq
      ?? obj.freq
      ?? obj.tx_freq
      ?? obj.data?.frequency
      ?? obj.data?.rx_freq
      ?? obj.data?.freq
      ?? obj.data?.tx_freq
      ?? obj.payload?.frequency
      ?? obj.payload?.rx_freq
      ?? obj.payload?.freq;
    if (freqHz == null || freqHz <= 0) {
      console.log('[FMO-DEBUG-FREQ] 事件中未找到频率字段, keys:', Object.keys(obj), 'data keys:', obj.data ? Object.keys(obj.data) : 'null');
      return null;
    }
    const mhz = parseFloat((freqHz > 10000 ? freqHz / 1e6 : freqHz).toFixed(4));
    // 提取高度（米），多个可能字段
    const alt = obj.altitude
      ?? obj.alt
      ?? obj.height
      ?? obj.data?.altitude
      ?? obj.data?.alt
      ?? obj.data?.height
      ?? obj.payload?.altitude
      ?? obj.payload?.alt;
    const altStr = alt != null && alt !== '' ? alt + 'm' : '';
    console.log('[FMO-DEBUG-FREQ] 提取到频率:', mhz, 'MHz, 高度:', altStr || '无');
    return { mhz: mhz, alt: altStr };
  },

  _addSpeakingRecord(callsign, grid, serverUid, serverName) {
    if (!callsign) return;
    // memo/relay 在 renderRecentSpeakers 中从 this.qsoList 实时查找
    // speaking_start 事件不携带这些字段，且此时 qsoList 通常尚未加载
    const now = Date.now();
    this._speakingHistory.forEach(h => { if (!h.endTime) h.endTime = now; });
    const existing = this._speakingHistory.find(h => h.callsign === callsign);
    if (existing) {
      const idx = this._speakingHistory.indexOf(existing);
      this._speakingHistory.splice(idx, 1);
      existing.startTime = now;
      existing.endTime = null;
      existing.grid = grid || existing.grid;
      if (serverUid) existing.serverUid = serverUid;
      if (serverName) existing.serverName = serverName;
      this._speakingHistory.unshift(existing);
    } else {
      this._speakingHistory.unshift({
        callsign,
        grid: grid || '',
        startTime: now,
        endTime: null,
        serverUid: serverUid || '',
        serverName: serverName || ''
      });
    }
    this._cleanupOldHistory();
    this.renderRecentSpeakers();
  },

  _finishSpeakingRecords() {
    const now = Date.now();
    this._speakingHistory.forEach(h => { if (!h.endTime) h.endTime = now; });
    this.renderRecentSpeakers();
  },

  _cleanupOldHistory() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this._speakingHistory = this._speakingHistory.filter(h => (h.endTime || h.startTime) > oneHourAgo);
    const oneHourAgoSec = Math.floor(oneHourAgo / 1000);
    this._historyEvents = this._historyEvents.filter(e => e.utcTime > oneHourAgoSec);
  },

  renderRecentSpeakers() {
    const container = document.getElementById('recent-speakers');
    if (!container) return;

    // Update count
    const countEl = document.getElementById('recent-count');
    if (countEl) countEl.textContent = Math.min(this._speakingHistory.length + this._historyEvents.length, 10);

    const contactCounts = new Map();
    this.qsoList.forEach(q => {
      const qc = this._extractQsoCallsign(q);
      if (qc) {
        const call = this.parseCallsignSsid(qc).call;
        contactCounts.set(call, (contactCounts.get(call) || 0) + 1);
      }
    });

    const activeCallsigns = new Set();
    this._speakingHistory.forEach(h => { if (!h.endTime) activeCallsigns.add(h.callsign); });
    if (this._currentSpeaker?.callsign) {
      activeCallsigns.add(this._currentSpeaker.callsign);
    }

    const seen = new Set();
    const items = [];

    for (const h of this._speakingHistory) {
      const call = this.parseCallsignSsid(h.callsign).call;
      if (!seen.has(call)) {
        seen.add(call);
        // 从 qsoList 实时查找 memo/relay
        let memo = h.memo || '';
        let relay = h.relay || '';
        const qsoMatch = this.qsoList.find(q => {
          const qc = this._extractQsoCallsign(q);
          return this.isSameOperator(qc, h.callsign);
        });
        if (qsoMatch) {
          const mr = this._getQsoMemoRelay(qsoMatch);
          if (!memo && mr.memo) memo = mr.memo;
          if (!relay && mr.relay) relay = mr.relay;
        }
        items.push({
          callsign: h.callsign,
          utcTime: Math.floor((h.endTime || h.startTime) / 1000),
          grid: h.grid || '',
          memo: memo || '',
          relay: relay || ''
        });
        if (items.length >= 10) break;
      }
    }

    if (items.length < 10 && this._historyEvents.length > 0) {
      for (const evt of this._historyEvents) {
        const call = this.parseCallsignSsid(evt.callsign).call;
        if (!seen.has(call)) {
          seen.add(call);
          let eMemo = evt.memo || '';
          let eRelay = evt.relay || '';
          const qsoMatch = this.qsoList.find(q => {
            const qc = this._extractQsoCallsign(q);
            return this.isSameOperator(qc, evt.callsign);
          });
          if (qsoMatch) {
            const mr = this._getQsoMemoRelay(qsoMatch);
            if (!eMemo && mr.memo) eMemo = mr.memo;
            if (!eRelay && mr.relay) eRelay = mr.relay;
          }
          items.push({
            callsign: evt.callsign,
            utcTime: evt.utcTime,
            grid: evt.grid || '',
            memo: eMemo || '',
            relay: eRelay || ''
          });
          if (items.length >= 10) break;
        }
      }
    }

    if (!items.length) {
      container.innerHTML = '<div class="list-empty">暂无最近发言</div>';
      return;
    }

    const now = Date.now();
    const todaySet = this._todayContactedSet(); // A8
    container.innerHTML = items.map((item, index) => {
      const call = this.parseCallsignSsid(item.callsign).call;
      const count = contactCounts.get(call) || 0;
      const timeStr = this.formatTimeAgo(item.utcTime, now);
      const isActive = activeCallsigns.has(item.callsign);
      const isSelf = this.isSameOperator(item.callsign, this.myCallsign);

      // 查找匹配 QSO，提取 memo（留言）
      let memo = '';
      const matchingQso = this.qsoList.find(q => {
        const qc = this._extractQsoCallsign(q);
        return this.isSameOperator(qc, item.callsign);
      });
      if (matchingQso) {
        memo = matchingQso.toComment || matchingQso.memo || matchingQso.message || matchingQso.msg || '';
      }

      // 从 _speakingHistory 获取 serverName
      let serverName = '';
      const sh = this._speakingHistory.find(h => h.callsign === item.callsign);
      if (sh?.serverName) {
        serverName = sh.serverName;
      } else if (matchingQso?.serverName) {
        serverName = matchingQso.serverName;
      }

      // 网格(QTH)：优先用发言自带网格；历史呼号回退到 QSO 记录的网格/定位码
      const grid = (item.grid || (matchingQso && (matchingQso.grid || matchingQso.locator)) || '').trim();
      if (grid) this._resolveGridLocation(grid);
      const qth = grid ? (this._gridLocationCache[grid] || grid) : '';
      let midLine = '';
      if (memo) midLine += '<span class="recent-memo">' + this._esc(memo) + '</span>';
      // A4：中继名可点击 → 直接切换服务器
      if (serverName) midLine += (midLine ? '<span class="recent-dot">·</span>' : '')
        + '<span class="recent-server recent-relay-clickable" title="点击切换到中继「' + this._esc(serverName) + '」" data-relay="' + this._esc(serverName) + '">' + this._esc(serverName) + '</span>';

      return '<div class="recent-item' + (isActive ? ' is-speaking' : '') + (isSelf ? ' is-self' : '') + '" data-callsign="' + item.callsign + '">'
        + '<span class="recent-index-bg">' + (index + 1) + '</span>'
        + '<div class="recent-body">'
        + '<span class="recent-callsign"><a class="callsign-link" href="#" data-qrz="' + this._esc(item.callsign) + '" title="QRZ 查询 ' + this._esc(item.callsign) + '">' + this._esc(item.callsign) + '</a></span>'
        + (isSelf ? '<span class="self-tag">您</span>' : '')
        + this._todayBadge(item.callsign, todaySet)
        + (qth ? '<span class="recent-grid" title="' + this._esc(grid || '') + '">' + this._esc(qth) + '</span>' : '')
        + (midLine ? '<span class="recent-extra">' + midLine + '</span>' : '')
        + '<span class="recent-spacer"></span>'
        + '<span class="recent-time">' + timeStr + '</span>'
        + '<span class="recent-count">x' + count + '</span>'
        + '</div>'
        + '</div>';
    }).join('');

    this._bindQrz(container); // A5

    // A4：最近发言里的中继名 → 切换服务器
    container.querySelectorAll('.recent-relay-clickable').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._switchToRelay(el.dataset.relay);
      });
    });

    container.querySelectorAll('.recent-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-qrz]')) return; // 点 QRZ 按钮时不复制
        if (e.target.closest('.recent-relay-clickable')) return;
        const callsign = el.dataset.callsign;
        if (callsign) {
          navigator.clipboard.writeText(callsign).catch(() => {});
        }
      });
    });
  },

  renderSpeakingBar() {
    const bar = document.getElementById('speaking-bar');
    if (!bar) return;

    const sp = this._currentSpeaker;
    if (!sp) {
      const q = document.getElementById('ac-qrz-btn');
      if (q) { q.disabled = true; q.title = '暂无呼号'; }
      return;
    }

    bar.classList.remove('idle');
    bar.classList.add('active');

    // Hide placeholder
    const ph = document.getElementById('sb-placeholder');
    if (ph) ph.style.display = 'none';

    const elapsed = Date.now() - sp.startedAtMs;
    const elapsedStr = this.formatElapsed(elapsed);

    // 补全缺失数据
    if (sp.distance === undefined || sp.azimuth === undefined || sp.altitude === undefined) {
      const derived = this._deriveStationInfo(sp.callsign);
      if (sp.distance === undefined && derived.distance !== undefined) sp.distance = derived.distance;
      if (sp.azimuth === undefined && derived.azimuth !== undefined) sp.azimuth = derived.azimuth;
      if (sp.altitude === undefined && derived.altitude !== undefined) sp.altitude = derived.altitude;
      if (!sp.grid && derived.grid) sp.grid = derived.grid;

      if (sp.grid && (sp.distance === undefined || sp.azimuth === undefined)) {
        const computed = this._computeGridDistance(sp.grid);
        if (computed) {
          if (sp.distance === undefined) sp.distance = computed.distance;
          if (sp.azimuth === undefined) sp.azimuth = computed.azimuth;
        }
      }
    }

    // Callsign
    const csEl = document.getElementById('sb-callsign');
    if (csEl) { csEl.textContent = sp.callsign || '--'; csEl.style.display = ''; }

    // A5：当前呼叫的 QRZ 查询按钮（无呼号时禁用）
    const qrzBtn = document.getElementById('ac-qrz-btn');
    if (qrzBtn) {
      const has = !!(sp.callsign && sp.callsign !== '--');
      qrzBtn.disabled = !has;
      qrzBtn.title = has ? ('在 QRZ.com 查询 ' + sp.callsign) : '暂无呼号';
    }

    // Grid tag：优先显示网格转换后的 QTH 地名，保留网格码作为 title 提示
    const gridEl = document.getElementById('sb-grid');
    if (gridEl) {
      const raw = sp.grid || '';
      const loc = raw ? (this._gridLocationCache[raw] || raw) : '';
      gridEl.textContent = loc;
      gridEl.title = raw ? ('网格：' + raw) : '';
      gridEl.style.display = loc ? '' : 'none';
    }

    // Direction + azimuth
    const dirEl = document.getElementById('sb-direction');
    if (dirEl) {
      if (sp.azimuth !== undefined && sp.azimuth !== null) {
        const dir = this._azimuthToDirection(sp.azimuth);
        dirEl.textContent = dir + ' ' + sp.azimuth + '°';
        dirEl.style.display = '';
      } else {
        dirEl.style.display = 'none';
      }
    }

    const arrowEl = document.getElementById('compass-arrow');
    if (arrowEl) { arrowEl.style.transform = 'rotate(' + sp.azimuth + 'deg)'; }

    // Distance
    const distEl = document.getElementById('sb-distance');
    if (distEl) {
      if (sp.distance !== undefined && sp.distance !== null) {
        distEl.textContent = Number(sp.distance).toFixed(0) + 'km';
        distEl.style.display = '';
      } else {
        distEl.style.display = 'none';
      }
    }

    // QTH (grid location name)
    const qthEl = document.getElementById('sb-qth');
    if (qthEl) {
      const loc = sp.grid ? (this._gridLocationCache[sp.grid] || sp.grid) : '';
      qthEl.textContent = loc;
      qthEl.style.display = loc ? '' : 'none';
    }

    // QTH 卡片 (freq-qth) — 含方位+距离
    const qthCardEl = document.getElementById('freq-qth');
    if (qthCardEl) {
      const loc = this._gridLocationCache[sp?.grid] || sp?.grid || '';
      const parts = [];
      if (loc) parts.push(loc);
      if (sp.azimuth !== undefined && sp.azimuth !== null) {
        const dir = this._azimuthToDirection(sp.azimuth);
        let bearingStr = dir + ' ' + sp.azimuth + '°';
        if (sp.distance !== undefined && sp.distance !== null) {
          bearingStr += ' · ' + Number(sp.distance).toFixed(0) + 'km';
        }
        parts.push(bearingStr);
      }
      qthCardEl.textContent = parts.join('  ') || '--';
    }

    // Server name (small subtext)
    const srvEl = document.getElementById('sb-server');
    if (srvEl) {
      srvEl.textContent = sp.serverName || '';
      srvEl.style.display = sp.serverName ? '' : 'none';
    }

    // 中继/服务器卡片主标题（server-name-display）
    const relayNameEl = document.getElementById('server-name-display');
    if (relayNameEl) {
      relayNameEl.textContent = sp.serverName || this.currentServerName || '--';
    }

    // Freq & Height from speaker（仅发言人本人数据：QSO 推导 / APRS 信标）
    const freqAltEl = document.getElementById('freq-line-text');
    if (freqAltEl) {
      const parts = [];
      if (sp.freq) parts.push(sp.freq + ' MHz');
      if (sp.height) parts.push(sp.height + 'm');
      freqAltEl.textContent = parts.length > 0 ? parts.join(' · ') : '--';
    }

    // Contact count
    const cntEl = document.getElementById('sb-contact-count');
    let contactCount = 0;
    if (cntEl) {
      const qsos = this.qsoList.filter(q =>
        this.isSameOperator(this._extractQsoCallsign(q), sp.callsign)
      );
      contactCount = qsos.length;
      if (contactCount > 1) {
        cntEl.textContent = 'x' + contactCount;
        cntEl.style.display = '';
      } else {
        cntEl.style.display = 'none';
      }
    }

    // 新呼号标记：从未通联过
    const newBadgeEl = document.getElementById('ac-new-badge');
    if (newBadgeEl) {
      // 需要 qsoList 已加载才准确
      if (this.qsoList.length > 0 && contactCount === 0) {
        newBadgeEl.style.display = '';
      } else {
        newBadgeEl.style.display = 'none';
      }
    }

    // 已通联标记
    const contactedTag = document.querySelector('.tag-contacted');
    if (contactedTag) {
      contactedTag.style.display = contactCount > 0 ? '' : 'none';
    }

    // Elapsed
    const elEl = document.getElementById('sb-elapsed');
    if (elEl) { elEl.textContent = elapsedStr; elEl.style.display = ''; }
  },

  // ============ 音频 ============

  initAudioCtx() {
    this._audioInitDone = false;
    const init = () => {
      if (this._audioInitDone) return;
      try {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 8000 });
        this.gainNode = this.audioCtx.createGain();
        this.gainNode.gain.value = this.volume / 100;
        // 限幅器：增益 >100% 时压制峰值，避免爆音刺耳
        this.compNode = this.audioCtx.createDynamicsCompressor();
        this.compNode.threshold.value = -6;
        this.compNode.knee.value = 6;
        this.compNode.ratio.value = 12;
        this.compNode.attack.value = 0.003;
        this.compNode.release.value = 0.25;
        this.gainNode.connect(this.compNode);
        this.compNode.connect(this.audioCtx.destination);
        this._audioInitDone = true;
      } catch (e) { console.warn('[FMO] AudioContext init failed:', e.message); }
    };
    const resume = () => {
      init();
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    };
    this._audioResume = resume; // 供静音 / 音量按钮直接调用（它们的点击被 stopPropagation 拦住了冒泡）
    document.addEventListener('click', resume, { once: false });
    document.addEventListener('keydown', resume, { once: false });
    document.addEventListener('touchstart', resume, { once: false });
  },

  /** 确保 AudioContext 已创建并恢复（浏览器要求用户手势后才能出声） */
  _ensureAudio() {
    if (this._audioResume) this._audioResume();
  },

  handleAudioFrame(buf) {
    if (!buf || !this.audioCtx || this.isMuted) {
      if (buf) this.computeVU(buf);
      return;
    }
    this.computeVU(buf);
    const raw = new Int16Array(buf);
    const buffer = this.audioCtx.createBuffer(1, raw.length, 8000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < raw.length; i++) channel[i] = raw[i] / 32768;
    const source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode);
    source.start();
  },

  computeVU(buf) {
    const raw = new Int16Array(buf);
    let sum = 0;
    for (let i = 0; i < raw.length; i++) sum += (raw[i] / 32768) ** 2;
    const rms = Math.sqrt(sum / raw.length);
    const db = 20 * Math.log10(rms + 0.0001);
    this.vuLevel = Math.max(0, Math.min(100, (db + 60) * (100 / 60)));
    this.updateVU();
  },

  updateVU() {
    const icon = document.getElementById('sb-audio-icon');
    if (!icon) return;
    const muted = this.isMuted;
    // 图标保持高亮，颜色变化即可；静音时满亮、放音时随电平提亮（0.85 → 1.05）
    icon.style.opacity = muted ? 1 : 0.85 + (this.vuLevel / 100) * 0.2;
    const unmutedGroup = icon.querySelector('.audio-icon-unmuted');
    const mutedGroup = icon.querySelector('.audio-icon-muted');
    if (unmutedGroup) unmutedGroup.style.display = muted ? 'none' : '';
    if (mutedGroup) mutedGroup.style.display = muted ? '' : 'none';

    const btn = document.getElementById('audio-mute-btn');
    if (btn) {
      btn.classList.toggle('muted', muted);
      btn.title = muted ? '已静音，点击放音' : '静音';
      btn.setAttribute('aria-label', btn.title);
    }
  },

  toggleMute() {
    this._ensureAudio();
    this.isMuted = !this.isMuted;
    this._applyGain();
    this.updateVU();
  },

  // ============ 音量调节 ============

  /** 把 volume / isMuted 同步到 gainNode */
  _applyGain() {
    if (!this.gainNode) return;
    this.gainNode.gain.value = this.isMuted ? 0 : this.volume / 100;
  },

  /** 读取上次音量（localStorage），无记录则保持默认 80 */
  loadVolume() {
    const raw = localStorage.getItem('fmo-volume');
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (!isNaN(n)) this.volume = Math.min(this.VOL_MAX, Math.max(this.VOL_MIN, n));
    }
    this._applyGain();
    this.updateVolumeUI();
  },

  /** 设置绝对音量；>100 为增益放大，最高 300 */
  setVolume(v) {
    this._ensureAudio();
    const n = Math.round(Number(v) || 0);
    this.volume = Math.min(this.VOL_MAX, Math.max(this.VOL_MIN, n));
    try { localStorage.setItem('fmo-volume', String(this.volume)); } catch (e) { /* ignore */ }
    this._applyGain();
    this.updateVolumeUI();
  },

  /** 步进调节（±VOL_STEP） */
  changeVolume(delta) {
    this.setVolume(this.volume + delta);
  },

  updateVolumeUI() {
    const valEl = document.getElementById('vol-value');
    if (valEl) {
      valEl.textContent = this.volume + '%';
      valEl.classList.toggle('is-boost', this.volume > 100);
      valEl.title = this.volume > 100
        ? ('增益 ' + this.volume + '%（已启用限幅，点击恢复 100%）')
        : '点击恢复 100%';
    }
    const down = document.getElementById('vol-down-btn');
    if (down) down.disabled = this.volume <= this.VOL_MIN;
    const up = document.getElementById('vol-up-btn');
    if (up) up.disabled = this.volume >= this.VOL_MAX;
  },

  // ============ 轮询 ============

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.connected) {
        this.fetchServerList();
        this.fetchRadioInfo();
      }
    }, 30000);
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  // ============ 设置 ============

  openSettings(firstTime = false) {
    const overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    const heading = document.getElementById('settings-heading');
    if (heading) {
      heading.textContent = firstTime ? '首次使用 · 请设置 FMO 设备地址' : '设置';
    }
    const raw = localStorage.getItem('fmo-settings');
    if (raw) {
      try {
        const { ip, port, protocol } = JSON.parse(raw);
        document.getElementById('fmo-ip').value = ip || '';
        document.getElementById('fmo-port').value = port || '80';
        document.getElementById('fmo-protocol').value = protocol || 'ws';
      } catch (e) {}
    }
    // C2：打开设置时刷新本地缓存信息
    this._idbGetAll('qso').then(list => {
      this._idbGetMeta('meta').then(meta => this._updateCacheInfo(list.length, meta && meta.savedAt));
    });
  },

  closeSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  saveSettings() {
    const ip = document.getElementById('fmo-ip').value.trim();
    const port = document.getElementById('fmo-port').value.trim() || '80';
    const protocol = document.getElementById('fmo-protocol').value;
    if (!ip) return;
    this.protocol = protocol;
    localStorage.setItem('fmo-settings', JSON.stringify({ ip, port, protocol }));
    this.closeSettings();
    this.connect(ip, port);
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());

// 暴露到 window，便于控制台调用（如 FMO.probeFavoriteApi()）
window.FMO = App;
