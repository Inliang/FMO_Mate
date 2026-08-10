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
   - 保留所有核心功能（Speaking Bar / 设备 / 服务器 / 最近发言 / QSO / 服务器切换 / 设置 / ADIF 导出）
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
  serverList: [],
  currentServerName: '',
  _prevServer: '',
  serverSearch: '',

  // --- 音频 ---
  audioCtx: null,
  audioConnected: false,
  isMuted: false,
  vuLevel: 0,
  volume: 80,
  gainNode: null,

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
    this._startClock();
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

    // 导出 ADIF（通过通联记录面板按钮触发）
    const panelExportBtn = $('panel-export-btn');
    if (panelExportBtn) {
      panelExportBtn.addEventListener('click', () => this.exportQso());
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
      // 断连时恢复自身呼号显示
      const cmdDescEl = document.getElementById('command-desc');
      if (cmdDescEl) cmdDescEl.textContent = (this.myCallsign || 'N0CALL') + ' 正在守听';
      const devCallsignEl = document.getElementById('dev-callsign');
      if (devCallsignEl) devCallsignEl.textContent = this.myCallsign || 'N0CALL';
    }
    this._updateNetworkType();
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
    if (!el) return;
    const tick = () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      el.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
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
        freq: evt.freq || derived.freq || '',
        height: evt.height || derived.height || 0,
        serverName: srv.name || evt.serverName || '',
        serverUid: srv.uid || evt.serverUid || '',
      });
      // 从事件中提取呼叫人的频率/高度
      const freqFields = this._extractFreqFromEvent(evt);
      if (freqFields) {
        this._currentFreq = freqFields.mhz;
        this._currentAltitude = freqFields.alt;
        this._updateFreqDisplay(freqFields.mhz, freqFields.alt);
        // AGL 兜底：若 API 未返回，从事件流 HEIGHT 填充
        if (freqFields.alt) {
          const aglEl = document.getElementById('dev-version');
          if (aglEl && (aglEl.textContent === '--' || aglEl.textContent === '')) {
            aglEl.textContent = freqFields.alt;
          }
        }
      }
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
          freq: d.freq || derived.freq || '',
          height: d.height || derived.height || 0,
          serverName: srv.name || d.serverName || '',
          serverUid: srv.uid || d.serverUid || '',
        });
        // 从 data 字段提取频率/高度
        const freqFields = this._extractFreqFromEvent(d);
        if (freqFields) {
          this._currentFreq = freqFields.mhz;
          this._currentAltitude = freqFields.alt;
          this._updateFreqDisplay(freqFields.mhz, freqFields.alt);
          // AGL 兜底：若 API 未返回，从事件流 HEIGHT 填充
          if (freqFields.alt) {
            const aglEl = document.getElementById('dev-version');
            if (aglEl && (aglEl.textContent === '--' || aglEl.textContent === '')) {
              aglEl.textContent = freqFields.alt;
            }
          }
        }
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
          this._myLat = r.data.latitude;
          this._myLon = r.data.longitude;
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
            if (devFreqEl && !this._currentFreq) devFreqEl.textContent = mhz + ' MHz';
            if (!this._currentFreq) { this._currentFreq = mhz; }
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
    const cmdDescEl = document.getElementById('command-desc');
    const cs = this.myCallsign || 'N0CALL';
    if (devCallsignEl) devCallsignEl.textContent = cs;
    if (devUidEl) devUidEl.textContent = this.myUid || '--';
    if (cmdDescEl) cmdDescEl.textContent = cs + ' 正在守听';
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
        this._currentServerUid = r.data.uid || '';
        // 从 getCurrent 响应直接提取在线人数
        const oc = r.data.onlineCount ?? r.data.count ?? r.data.users ?? r.data.online ?? r.data.userCount;
        if (oc !== undefined && oc !== null) {
          this._updateOnlineCount(oc);
          console.log('[FMO-DEBUG-OC] getCurrent 直接返回在线人数:', oc);
        }
        this._showServerInfo();
      }
    } catch (e) {}

    this.renderServerList();
    this.renderServerSidebar();
    // 显式同步 KPI 在线人数（renderServerList 中也做，此处双保险）
    this._syncKpiOnlineCount();
    setTimeout(() => this._probeAllServerLatency(), 500);
  },

  async fetchServerList() {
    await this.fetchServerListAll();
  },

  _showServerInfo() {
    const nameEl = document.getElementById('server-name-display');
    if (nameEl) nameEl.textContent = this.currentServerName || '--';

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

    // 尝试按名称匹配当前服务器
    let currentServer = null;
    if (this.currentServerName) {
      currentServer = this.serverList.find(s => s.name === this.currentServerName);
    }
    if (!currentServer && this._currentServerUid) {
      currentServer = this.serverList.find(s => s.uid === this._currentServerUid);
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
    // 当前连接的服务器必定在线
    if (s.name === this.currentServerName) return true;
    // 优先判断布尔字段
    if (s.online !== undefined) return s.online === true;
    if (s.connected !== undefined) return s.connected === true;
    if (s.status !== undefined) return s.status === 'online' || s.status === 'active' || s.status === 'connected';
    // 无布尔/状态字段时，用 onlineCount > 0 作为在线判断
    const count = s.onlineCount ?? s.count ?? s.users ?? 0;
    return count > 0;
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
      const active = s.name === this.currentServerName;
      const host = s.host || s.addr || s.address || s.url || '';
      const lat = this._serverLatency[host];
      const latStr = lat === -1 ? '超时' : (lat !== undefined ? lat + 'ms' : '...');
      return `<div class="server-item${active ? ' active' : ''}" data-server-name="${s.name}" data-server-key="${host || s.name}">
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
      el.addEventListener('click', () => this.switchServer(el.dataset.serverName));
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
    if (!this.serverList.length) {
      results.innerHTML = '<div class="server-search-empty">加载中...</div>';
      popup.style.display = 'flex';
      return;
    }

    let filtered = this.serverList;
    if (q) {
      filtered = this.serverList.filter(s => {
        const name = (s.name || '').toLowerCase();
        if (name.includes(q)) return true;
        const pinyin = this._toPinyinInitials(s.name || '');
        if (pinyin.includes(q)) return true;
        const uid = String(s.uid ?? s._id ?? s.id ?? '').toLowerCase();
        if (uid.includes(q)) return true;
        return false;
      });
    }

    if (!filtered.length) {
      results.innerHTML = '<div class="server-search-empty">无匹配服务器</div>';
    } else {
      results.innerHTML = filtered.map(s => {
        const uid = s.uid ?? s._id ?? s.id ?? '--';
        return `<div class="server-search-item" data-server-name="${s.name}">
          <span class="server-search-item-name">${s.name || '--'}</span>
          <span class="server-search-item-uid">#${uid}</span>
        </div>`;
      }).join('');
      results.querySelectorAll('.server-search-item').forEach(el => {
        el.addEventListener('click', () => {
          popup.style.display = 'none';
          this.switchServer(el.dataset.serverName);
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

    const items = this.serverList;
    sidebar.innerHTML = items.map(s => {
      const uid = s.uid || s.id || '';
      const name = s.name || '--';
      const count = s.onlineCount ?? s.count ?? s.users ?? s.online ?? s.onlineCount ?? '--';
      const activeClass = name === this.currentServerName ? ' active' : '';
      return `<div class="server-item-side${activeClass}" data-server-name="${name}">
        <span class="station-name">${name}</span>
        <span class="server-sidebar-count">U${count} 在线</span>
      </div>`;
    }).join('');

    sidebar.querySelectorAll('.server-item-side').forEach(el => {
      el.addEventListener('click', () => this.switchServer(el.dataset.serverName));
    });
  },

  async switchServer(name) {
    if (name === this.currentServerName) return;

    this.serverSearch = '';
    const si = document.getElementById('server-search');
    if (si) si.value = '';

    this._prevServer = this.currentServerName;

    // Update server display to show switching state
    const nameEl = document.getElementById('server-name-display');
    if (nameEl) nameEl.textContent = name + ' …';
    this.currentServerName = name;
    this.renderServerList();
    this.renderServerSidebar();

    try {
      const target = this.serverList.find(s => s.name === name);
      const uid = target ? (target.uid ?? target._id ?? target.id) : undefined;
      const data = { name };
      if (uid !== undefined) data.uid = uid;

      const resp = await this.send({ type: 'station', subType: 'setCurrent', data });
      if (resp.code === 0 || resp.code === undefined) {
        this._showServerInfo();
        this.renderServerList();
        this.renderServerSidebar();
      } else {
        if (nameEl) nameEl.textContent = this._prevServer || '--';
        this.currentServerName = this._prevServer || '';
        this.renderServerList();
        this.renderServerSidebar();
        return;
      }
    } catch (e) {
      console.warn('switchServer:', e.message);
      if (nameEl) nameEl.textContent = this._prevServer || '--';
      this.currentServerName = this._prevServer || '';
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
        if (list.length < 20) break;
        page++;
      }
    } catch (e) { console.warn('[FMO-DEBUG-QSO] fetchQsoListAll 异常:', e.message); }

    console.log('[FMO-DEBUG-QSO] fetchQsoListAll 完成，共 ' + all.length + ' 条 QSO');
    this.qsoList = all;
    await this._enrichQsoDetails();
    this.renderQsoList();
    this.renderRecentSpeakers(); // qsoList loaded, re-render speaking cards with real memo/relay
    all.forEach(q => { if (q.grid || q.locator) this._resolveGridLocation(q.grid || q.locator); });
    this.updateQsoCount();
    this.renderPrevCard();
    this.renderTopCallers();
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

    // 最新的 15 条
    const items = [...this.qsoList];
    items.forEach(item => { if (item.grid || item.locator) this._resolveGridLocation(item.grid || item.locator); });
    container.innerHTML = items.map(item => {
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

      return `<div class="qso-row">
        <span class="qso-accent"></span>
        <span class="qso-callsign">${callsign}</span>
        ${gridHtml ? '<span class="qso-grid-cell">' + gridHtml + '</span>' : '<span class="qso-grid-cell qso-cell-empty">--</span>'}
        <span class="qso-qth-cell" title="${qth}">${qth}</span>
        <span class="qso-memo-cell ${memo ? 'qso-memo-clickable' : 'qso-cell-empty'}" title="${memo ? '点击复制留言' : '暂无留言'}" data-memo="${this._esc(memo)}">${memo || '暂无留言'}</span>
        <span class="qso-relay-cell ${relay ? '' : 'qso-cell-empty'}" title="${this._esc(relay) || '无中继'}">${relay || '无中继'}</span>
        <span class="qso-time">${timeStr}</span>
      </div>`;
    }).join('');

    container.querySelectorAll('.qso-grid').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const callsign = el.dataset.callsign;
        navigator.clipboard.writeText(callsign).then(() => {
          window.open('https://map.fmo.net.cn/', '_blank');
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
  },

  _esc(str) { return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },

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
      else { const hrs = Math.floor(mins / 60); timeEl.textContent = hrs + '小时前'; }
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
    this.renderTopCallers();
  },

  updateQsoCount() {
    const el = document.getElementById('qso-count');
    if (!el) return;
    el.textContent = this.qsoList.length;

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

  renderTopCallers() {
    const container = document.getElementById('top-callers');
    if (!container) return;

    const counts = new Map();
    this.qsoList.forEach(q => {
      const qc = this._extractQsoCallsign(q);
      if (qc) {
        const call = this.parseCallsignSsid(qc).call;
        counts.set(call, (counts.get(call) || 0) + 1);
      }
    });

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

    const countEl = document.getElementById('top-count');
    if (countEl) countEl.textContent = sorted.length;

    if (!sorted.length) {
      container.innerHTML = '<div class="list-empty">暂无数据</div>';
      return;
    }

    const maxCount = sorted[0][1];
    container.innerHTML = sorted.map(([call, count], i) => {
      const barPct = Math.round((count / maxCount) * 100);
      const isSelf = this.isSameOperator(call, this.myCallsign);
      const barColor = i < 3 ? '#F59E0B' : i < 10 ? '#FFB74D' : 'rgba(255,152,0,0.22)';
      return `<div class="top-item${isSelf ? ' is-self' : ''}">
        <span class="top-rank">${i + 1}</span>
        <span class="top-call">${call}</span>
        <span class="top-bar-wrap"><span class="top-bar" style="width:${barPct}%;background:${barColor}"></span></span>
        <span class="top-count">${count}次</span>
      </div>`;
    }).join('');
  },

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
      this._updateFreqDisplay(freq, this._currentAltitude || '--');
      const devFreqEl = document.getElementById('dev-user-freq');
      if (devFreqEl) devFreqEl.textContent = freq + ' MHz';
      // AGL（高度）兜底：若 API 未返回，从 BEACON HEIGHT 填充
      if (height) {
        const aglEl = document.getElementById('dev-version');
        if (aglEl) {
          const current = aglEl.textContent;
          if (current === '--' || current === '') aglEl.textContent = height;
        }
      }
      console.log('[FMO-DEBUG-FREQ] APRS BEACON 频率:', freq, '高度:', height || '无');
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

    // 异步触发 QTH 解析
    items.forEach(item => { if (item.grid) this._resolveGridLocation(item.grid); });

    const now = Date.now();
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

      // 构建额外信息行（memo / serverName / QTH）
      let extraLine = '';
      const qth = item.grid ? (this._gridLocationCache[item.grid] || item.grid) : '';
      if (qth) extraLine += '<span class="recent-qth">' + this._esc(qth) + '</span>';
      if (memo) extraLine += '<span class="recent-dot">·</span><span class="recent-memo">' + this._esc(memo) + '</span>';
      if (serverName) extraLine += '<span class="recent-dot">·</span><span class="recent-server">' + this._esc(serverName) + '</span>';

      return '<div class="recent-item' + (isActive ? ' is-speaking' : '') + (isSelf ? ' is-self' : '') + '" data-callsign="' + item.callsign + '">'
        + '<span class="recent-index-bg">' + (index + 1) + '</span>'
        + '<div class="recent-body">'
        + '<div class="recent-top">'
        + '<span class="recent-callsign">' + item.callsign + '</span>'
        + (isSelf ? '<span class="self-tag">您</span>' : '')
        + '<span class="recent-spacer"></span>'
        + '<span class="recent-time">' + timeStr + '</span>'
        + '<span class="recent-count">x' + count + '</span>'
        + '</div>'
        + (extraLine ? '<div class="recent-bottom">' + extraLine + '</div>' : '')
        + '</div>'
        + '</div>';
    }).join('');

    container.querySelectorAll('.recent-item').forEach(el => {
      el.addEventListener('click', (e) => {
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
    if (!sp) return;

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

    // Grid tag
    const gridEl = document.getElementById('sb-grid');
    if (gridEl) {
      gridEl.textContent = sp.grid || '';
      gridEl.style.display = sp.grid ? '' : 'none';
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

    // Freq & Height from speaker
    const freqAltEl = document.getElementById('freq-line-text');
    if (freqAltEl) {
      const parts = [];
      if (sp.freq) parts.push(sp.freq + ' MHz');
      if (sp.height) parts.push(sp.height + 'm');
      if (parts.length > 0) freqAltEl.textContent = parts.join(' · ');
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
        this.gainNode.connect(this.audioCtx.destination);
        this._audioInitDone = true;
      } catch (e) { console.warn('[FMO] AudioContext init failed:', e.message); }
    };
    const resume = () => {
      init();
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    };
    document.addEventListener('click', resume, { once: false });
    document.addEventListener('keydown', resume, { once: false });
    document.addEventListener('touchstart', resume, { once: false });
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
    icon.style.opacity = 0.35 + (this.vuLevel / 100) * 0.65;
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

  // ============ ADIF 导出 ============

  _parseTimestamp(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
      const d = new Date(raw);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw === 'number') {
      if (raw < 10000000000) {
        const d = new Date(raw * 1000);
        if (!isNaN(d.getTime())) return d;
      }
      const d = new Date(raw);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  },

  _freqToBand(mhz) {
    if (typeof mhz !== 'number' || isNaN(mhz) || mhz <= 0) return '2m';
    if (mhz >= 0.1357 && mhz <= 0.1378) return '2190m';
    if (mhz >= 0.472 && mhz <= 0.479) return '630m';
    if (mhz >= 1.8 && mhz <= 2.0) return '160m';
    if (mhz >= 3.5 && mhz <= 4.0) return '80m';
    if (mhz >= 7.0 && mhz <= 7.3) return '40m';
    if (mhz >= 10.1 && mhz <= 10.15) return '30m';
    if (mhz >= 14.0 && mhz <= 14.35) return '20m';
    if (mhz >= 18.068 && mhz <= 18.168) return '17m';
    if (mhz >= 21.0 && mhz <= 21.45) return '15m';
    if (mhz >= 24.89 && mhz <= 24.99) return '12m';
    if (mhz >= 28.0 && mhz <= 29.7) return '10m';
    if (mhz >= 50 && mhz <= 54) return '6m';
    if (mhz >= 144 && mhz <= 148) return '2m';
    if (mhz >= 219 && mhz <= 225) return '1.25m';
    if (mhz >= 420 && mhz <= 450) return '70cm';
    if (mhz >= 902 && mhz <= 928) return '33cm';
    if (mhz >= 1240 && mhz <= 1300) return '23cm';
    if (mhz >= 2300 && mhz <= 2450) return '13cm';
    return '2m';
  },

  _buildAdifString() {
    if (!this.qsoList.length) return '';
    const pad = (n, len) => String(n).padStart(len, '0');
    const byteLen = (s) => new TextEncoder().encode(s).length;
    const lines = [
      '<ADIF_VER:5>3.1.4',
      '<PROGRAMID:14>fmo-secondary',
      '<EOH>'
    ];
    for (const item of this.qsoList) {
      const toCallsign = this._extractQsoCallsign(item).trim();
      const grid = (item.grid ?? item.locator ?? '').trim();
      const ts = this._parseTimestamp(item.timestamp);
      const freqRaw = (item.frequency ?? item.freq ?? '').toString().trim();
      const mode = (item.mode ?? 'FM').toString().trim().toUpperCase() || 'FM';
      const memo = (item.greeting ?? item.blessing ?? item.memo ?? item.message ?? '').trim();
      const relay = (item.relayName ?? item.serverName ?? item.stationName ?? item.relay ?? item.gateway ?? '').trim();
      const logId = (item.logId ?? '').toString().trim();

      if (!toCallsign || !ts) continue;

      const date = `${ts.getUTCFullYear()}${pad(ts.getUTCMonth()+1,2)}${pad(ts.getUTCDate(),2)}`;
      const time = `${pad(ts.getUTCHours(),2)}${pad(ts.getUTCMinutes(),2)}${pad(ts.getUTCSeconds(),2)}`;
      lines.push(`<CALL:${byteLen(toCallsign)}>${toCallsign}`);
      lines.push(`<QSO_DATE:8>${date}`);
      lines.push(`<TIME_ON:6>${time}`);

      const f = parseFloat(freqRaw);
      let band;
      if (freqRaw && !isNaN(f) && f > 0) {
        const mhz = f > 1000 ? f / 1e6 : f;
        band = this._freqToBand(mhz);
        lines.push(`<FREQ:${freqRaw.length}>${freqRaw}`);
      } else {
        band = '2m';
      }
      lines.push(`<BAND:${band.length}>${band}`);

      if (grid) {
        lines.push(`<GRIDSQUARE:${byteLen(grid)}>${grid}`);
      }
      lines.push(`<MODE:${byteLen(mode)}>${mode}`);
      lines.push('<RST_SENT:2>59');
      lines.push('<RST_RCVD:2>59');
      if (this.myCallsign) {
        lines.push(`<OPERATOR:${byteLen(this.myCallsign)}>${this.myCallsign}`);
        lines.push(`<STATION_CALLSIGN:${byteLen(this.myCallsign)}>${this.myCallsign}`);
      }
      if (logId) {
        const comment = `Server:${this.currentServerName || ''} LogID:${logId}` + (memo ? ` Memo:${memo}` : '') + (relay ? ` Relay:${relay}` : '');
        lines.push(`<COMMENT:${byteLen(comment)}>${comment}`);
      } else if (this.currentServerName || memo || relay) {
        const comment = [this.currentServerName ? `Server:${this.currentServerName}` : '', memo ? `Memo:${memo}` : '', relay ? `Relay:${relay}` : ''].filter(Boolean).join(' ');
        lines.push(`<COMMENT:${byteLen(comment)}>${comment}`);
      }
      lines.push('<EOR>');
    }
    return lines.join('\n');
  },

  exportQso() {
    const adi = this._buildAdifString();
    if (!adi) {
      alert('暂无通联记录可导出');
      return;
    }
    const pad = (n, len) => String(n).padStart(len, '0');
    const blob = new Blob([adi], { type: 'text/plain;charset=UTF-8' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const filename = `fmo_qso_${now.getFullYear()}${pad(now.getMonth()+1,2)}${pad(now.getDate(),2)}_${pad(now.getHours(),2)}${pad(now.getMinutes(),2)}${pad(now.getSeconds(),2)}.adi`;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
