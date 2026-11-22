# 架构设计文档

## 1. 系统架构

```
┌─────────────────────────────────────────────────────┐
│                  副屏设备 (Browser)                    │
│  ┌───────────────────────────────────────────────┐  │
│  │              index.html (Shell)                │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │           App Core (app.js)              │  │  │
│  │  │  ┌─────────┐ ┌──────────┐ ┌─────────┐  │  │  │
│  │  │  │WS Manager│ │Data Store│ │Renderer │  │  │  │
│  │  │  │(3路连接) │ │(内存缓存)│ │(DOM更新)│  │  │  │
│  │  │  └────┬─────┘ └──────────┘ └────┬────┘  │  │  │
│  │  │       │                         │       │  │  │
│  │  │  ┌────┴─────────────────────────┴────┐  │  │  │
│  │  │  │         Audio Engine              │  │  │  │
│  │  │  │   (Web Audio API / 静默监测)       │  │  │  │
│  │  │  └───────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────┘
                     │  LAN (WiFi)
          ┌──────────┼──────────┐
          │ ws       │ events   │ audio
          ▼          ▼          ▼
┌─────────────────────────────────────────────────────┐
│                  FMO 硬件设备                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │ :80/ws   │ │:80/events│ │ :80/audio (8kHz PCM) │ │
│  │ JSON-RPC │ │ SSE推送  │ │ Raw PCM Stream       │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
│  ┌──────────────────────────────────────────────────┐│
│  │  MQTT Broker (EMQX) → APRS-IS Service Discovery ││
│  └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

## 2. 核心模块

### 2.1 WebSocket Manager

管理三条独立 WebSocket 连接：

| 连接 | 端点 | 用途 | 重连策略 |
|------|------|------|---------|
| Main | `ws://host/ws` | JSON-RPC 请求/响应 | 指数退避，最多 10 次 |
| Events | `ws://host/events` | 服务端推送事件 | 跟随 Main 重连 |
| Audio | `ws://host/audio` | 8kHz PCM 音频流 | 跟随 Main 重连 |

请求队列：Main WS 串行化请求，逐个发送等待响应，10s 超时。

### 2.2 Data Store

内存缓存结构：

```javascript
Store = {
  device: { callsign, ip, grid, deviceName, antenna, firmwareVersion },
  server: { current: { uid, name, announcement }, list: [] },
  stats:  { todayQso, totalQso, onlineCount, topContacts },
  audio:  { connected, muted, volume, vuLevel, isSpeaking },
  status: { wsConnected, eventsConnected, lastUpdate }
}
```

### 2.3 Renderer

面板渲染引擎，面向三个显示模式：

- **默认模式**：暗色 HUD 风格（冷蓝 `#00D9FF` / 琥珀 `#FFB000`）
- **亮色模式**：白色背景，深色文字
- **墨水屏模式**：黑白二值 + 减少动画刷新

### 2.4 Audio Engine

- 直接消费 `/audio` WebSocket 的 8kHz 单声道 PCM 数据
- Web Audio API `AudioContext` + `AudioWorklet` 实时播放
- 静音切换（不影响数据接收）
- VU 电平计算 → 驱动 SpeakingBar 音量图标随电平提亮

## 3. 数据流

```
[连接建立]
  Main WS open
    ├── fetchDeviceInfo()    → user.getInfo / config.getCordinate
    ├── fetchServerInfo()    → station.getCurrent / station.getListRange
    ├── fetchStats()         → qso.getTodayCount / qso.getTotalCount
    └── startPolling(15s)    → 定期刷新 server info + stats

[Events WS 推送]
  speaking_start  → 更新 SpeakingBar
  speaking_stop   → 清空 SpeakingBar
  new_qso         → 追加 QSO 列表 + 更新统计
  station_update  → 刷新服务器信息

[Audio WS 数据]
  ArrayBuffer(160B) → AudioWorklet → 播放 + VU 计算
    每 20ms 一帧 (8kHz × 16bit mono × 20ms = 320B raw)
```

## 4. 错误处理

| 场景 | 策略 |
|------|------|
| WS 断开 | 指数退避重连 (1s/2s/4s/.../512s)，UI 显示离线状态 |
| 请求超时 | 10s 超时丢弃，继续下一个请求 |
| 音频解码失败 | 静默丢弃该帧，不中断播放流 |
| FMO 设备重启 | 服务端断开 WS → 客户端自动重连 → 全量刷新数据 |