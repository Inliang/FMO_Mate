# 架构设计文档

> 对应运行版本：`?v=1014q`。本文描述的是**当前代码的实际架构**，早期设计稿中未落地的内容（如 FFT 频谱、AudioWorklet）不在其列。

## 1. 系统架构

```
┌─────────────────────────────────────────────────────┐
│                  副屏设备 (Browser)                    │
│  ┌───────────────────────────────────────────────┐  │
│  │              index.html (Shell)                │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │              App (app.js)                │  │  │
│  │  │  ┌─────────┐ ┌──────────┐ ┌─────────┐  │  │  │
│  │  │  │WS 管理器│ │数据/缓存 │ │渲染器   │  │  │  │
│  │  │  │(3 路)   │ │(内存+IDB)│ │(DOM更新)│  │  │  │
│  │  │  └────┬─────┘ └──────────┘ └────┬────┘  │  │  │
│  │  │  ┌────┴─────────────────────────┴────┐  │  │  │
│  │  │  │       Audio Engine (Web Audio)     │  │  │  │
│  │  │  │  BufferSource + Gain + 限幅 + AGC   │  │  │  │
│  │  │  └───────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────┐  │  │
│  │  │  FMOCore (core.js, UMD)                 │  │  │
│  │  │  调试开关 / 响应匹配 / 网格换算纯函数    │  │  │
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
│  │ JSON-RPC │ │ WS 事件  │ │ 16-bit LE mono 流    │ │
│  └──────────┘ └──────────┘ └──────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

设备内部的 MQTT / APRS-IS 等服务由 FMO 固件自行维护，副屏不直接感知，仅通过 `/events` 收到派生的通联与信标事件。

## 2. 核心模块

### 2.1 WS 管理器（`app.js`）

三条独立 WebSocket，均连接 `ws(s)://<host>:<port>`：

| 连接 | 端点 | 用途 | 传输格式 |
|------|------|------|---------|
| Main | `/ws` | JSON-RPC 请求 / 响应 | 文本 JSON |
| Events | `/events` | 服务端事件推送 | 文本 JSON（可能粘连多帧） |
| Audio | `/audio` | 对讲音频流 | 二进制 8kHz / 16-bit LE / mono |

**串行队列**：Main WS 上的请求逐个发送、等待响应后再发下一个；单请求 **5s** 超时（超时即 reject 并继续下一个）。响应匹配（含 `getListResponse → getListRange` 别名与 `event:ok` 兜底）已抽到 `core.js` 的 `FMOCore.matchResponse`。

### 2.2 FMOCore 共享核心（`core.js`）

UMD 经典脚本，浏览器挂 `window.FMOCore`，Node 可 `require`。承载三块可独立测试的纯逻辑：

- **调试开关**：`setDebug` / `isDebug` / `dbg`，默认关闭。
- **响应匹配**：`matchResponse(msg, req)`。
- **梅登海德网格**：`latLonToGrid` / `gridToLatLon`（子网格字母表 a–x，24 个）。

`test.js` 用 Node 内置断言对以上做零依赖回归（`node test.js`，当前 18 项全绿）。

### 2.3 数据层

内存态集中在 `App` 对象上（设备信息、服务器列表、QSO 列表、当前发言、统计、音频状态、连接状态等），持久化分两类：

| 存储介质 | 键 | 内容 |
|---------|----|------|
| IndexedDB | 库 `fmo-mate` v1 / 仓 `qso`、`meta` | QSO 日志（1.5s 防抖写盘，上限 5000 条自动裁剪） |
| localStorage | `fmo-settings` / `fmo-volume` / `fmo-agc` / `fmo-theme` / `fmo-debug` / `fmo-weather-cache` | 连接设置、音量、AGC、主题、调试开关、天气缓存 |

启动时先渲染 IndexedDB 缓存，连上设备后再增量合并；不支持 IndexedDB 时静默降级。

### 2.4 渲染器

纵向信息流布局（详见 `UI_DESIGN.md`），面向三主题：

- **暗**（默认）：CyberGuard，深色底 + 荧光绿强调
- **亮**：Steel，浅色工业风 + 绿色强调
- **墨**：高对比黑白，全局关闭动画

主题选择存 `localStorage['fmo-theme']`，缺省为 `dark`。

### 2.5 音频引擎

- 直接消费 `/audio` 的二进制帧：`Int16Array` → `AudioBuffer` → `createBufferSource` 逐帧播放（`AudioContext` 采样率 8kHz）。
- 信号链：`BufferSource → GainNode → DynamicsCompressor → destination`。限幅器阈值 −1 dBFS、压缩比 20:1，仅在接近满刻度时防削波。
- **AGC**：低声自动补增益（目标 −18 dBFS，最多 +18 dB），高声下压（最多 −6 dB），带噪声门（−50 dBFS 以下冻结增益），约 400ms 平滑。
- **VU 电平**：每帧算 RMS → 映射为电平值，驱动喇叭图标提亮；无独立频谱柱组件。
- 浏览器自动播放策略：需首次用户手势（click / keydown / touchstart）后 `resume()` AudioContext。

## 3. 数据流

```
[连接建立]
  Main WS open
    ├── fetchDeviceInfo()       → user.getInfo / config.getCordinate / ...
    ├── fetchServerListAll()    → station.getCurrent + station.getListRange（分页 20/页，最多 50 页）
    ├── fetchQsoListAll()       → qso.getList（分页，逐页拉全量）
    └── startPolling()          → 每 30s：fetchServerList + fetchRadioInfo + refreshQsoPage0

[Events WS 推送]
  speaking_start / speaking_stop → 显示/隐藏 SpeakingBar
  new_qso                        → 增量合并 QSO 列表 + 更新统计
  station_update / online_change → 刷新服务器信息与在线人数
  beacon                         → 从 APRS 信标解析频率/高度

[Audio WS 数据]
  ArrayBuffer → Int16Array → VU 计算 + AGC → BufferSource → 播放

[外部服务（与设备连接解耦）]
  天气：设备坐标反查城市 → gmya /Api/Weather → 缓存 → 每 60 分钟刷新
  地址/网格：高德 regeo + Nominatim（城市/邮编），grid.lzyike.cn 最后兜底
```

> 天气刷新周期为 **60 分钟**（`_weatherRefreshMs = 60 * 60 * 1000`），与 30s 的设备轮询相互独立。

## 4. 韧性与错误处理

| 场景 | 策略 |
|------|------|
| WS 断开 | 指数退避重连：`min(30s, 1s × 2^(n-1))`，**无次数上限**，无限重试；UI 显示「重连中」 |
| 连接假死 | 看门狗每 60s 检查：已连接但 >180s 无任何 WS 流量 → 强制断开重连 |
| 请求超时 | 单请求 5s 超时，reject 后继续处理队列下一个 |
| 未捕获错误 | `window.error` / `unhandledrejection` → 弹错误条 + 限频自动重载（≤1 次 / 90s，防刷新循环） |
| 音频解码失败 | 静默丢弃异常帧，不中断播放流 |
| 天气请求失败 | 5s 超时中止，静态占位提示 + 下个周期自动重试；不弹错、不影响值守 |
| FMO 设备重启 | 服务端断开 WS → 客户端自动重连 → 重连成功后全量刷新数据 |

## 5. 调试与验证

- 开启诊断日志：URL 加 `?debug`，或 `localStorage.setItem('fmo-debug', '1')`；默认关闭。
- 所有诊断经 `FMOCore.dbg` 输出，前缀如 `[FMO-DEBUG-*]` / `[FMO-PROBE*]` / `[FMO-WATCHDOG]`。
- 纯函数回归：`node test.js`（零依赖、零构建）。
