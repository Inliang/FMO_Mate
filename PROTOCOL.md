# WebSocket 协议映射

基于 [fmo-show](https://github.com/EthanYan6/fmo-show) 逆向工程 + [BG5ESN Docs](https://bg5esn.com/categories/docs/) 官方文档。

> 本文只记录**本项目实际使用**的端点与方法。参考实现中存在但当前固件不支持的接口（如 `getFirmwareVersion`、`getContactCount`、`getTodayCount`、`getTotalCount`）已在代码里移除，不再列出。

## 1. 连接端点

| 端点 | 协议 | 说明 |
|------|------|------|
| `ws(s)://{host}:{port}/ws` | JSON-RPC | 主数据通道，请求/响应模式，串行队列单请求 5s 超时 |
| `ws(s)://{host}:{port}/events` | JSON 事件流 | 服务端推送，单向接收 |
| `ws(s)://{host}:{port}/audio` | Binary | 8kHz / 16-bit LE / mono PCM 音频流，`binaryType = 'arraybuffer'` |

## 2. 请求/响应协议 (Main WS)

### 通用格式

```json
// 请求
{ "type": "<domain>", "subType": "<action>", "data": { ... } }

// 响应
{ "type": "<domain>", "subType": "<action>Response", "code": 0, "data": { ... } }
```

响应匹配由 `core.js` 的 `FMOCore.matchResponse` 完成（含别名与 `event:ok` 兜底，见第 5 节）。

### 2.1 用户信息

```
→ { type: "user", subType: "getInfo" }
← { type: "user", subType: "getInfoResponse", code: 0,
    data: { callsign, uid, ... } }
```

### 2.2 设备配置

以下方法均来自 FmoLogs 参考实现，为设备固件支持的接口（并行发起，超时保护）：

```
→ { type: "config", subType: "getCordinate" }
← { data: { latitude, longitude } }

→ { type: "config", subType: "getUserPhyDeviceName" }
← { data: { deviceName } }

→ { type: "config", subType: "getUserPhyAnt" }
← { data: { ant } }
```

> `getFirmwareVersion` / `getContactCount` / `getRxFrequency` / `getStatus` 不在 FmoLogs 列表中，实测固件不支持，已从代码中移除。设备版本等信息改从 `user.getInfo` 的返回字段读取。

坐标写入：`config.setCordinate`（设备配置弹窗 / 坐标设置）。

### 2.3 服务器/中继

```
→ { type: "station", subType: "getCurrent" }
← { data: { uid, name, announcement, onlineCount } }

→ { type: "station", subType: "getListRange", data: { start, count } }
← { data: { list: [{ uid, name, onlineCount }] } }
```

> **station 域完整方法表**（以 [fmo-mobile-controller API v2 文档](https://github.com/niufox/fmo-mobile-controller/blob/main/API_DOCUMENTATION_v2.md) 为准）

| subType | 请求参数 | 响应 | 说明 |
|---------|---------|------|------|
| `getListRange` | `{ start, count }` | `getListResponse` | 服务器列表；本项目以 `pageSize=20`、`maxPages=50` 分页拉取 |
| `getCurrent` | `{}` | `getCurrentResponse` | 当前服务器 `{ uid, name }` |
| `setCurrent` | **`{ uid: number }`** | `setCurrentResponse` | 切换服务器，**按 uid 定位**（勿发 name，同名服务器会切错） |
| `next` | `{}` | `nextResponse` | 切换到下一个服务器 |
| `prev` | `{}` | `prevResponse` | 切换到上一个服务器 |

**收藏相关结论（已核实）**：FMO 协议中**不存在收藏/常用/星标服务器接口**。
- `station` 域仅上述 5 个方法；
- 服务器列表条目实际字段只有 `uid` 与 `name`（无收藏标记字段）；
- 实测 `getFavoriteList` / `getFavorites` / `getFavList` / `getCollectList` 等候选接口均无响应；
- fmo-show（协议逆向源头）源码中亦无收藏实现。

因此本项目**未实现收藏功能**（本地收藏亦因无法与设备同步、多端不一致而移除）。

### 2.4 QSO 查询与统计

设备仅提供 QSO 列表与详情查询；**统计类接口（`getTodayCount` / `getTotalCount` / `getContactCount`）实测固件不支持，已移除**。

```
→ { type: "qso", subType: "getList", data: { page } }
← { data: { list: [{ logId, toCallsign, grid, timestamp, ... }] } }
   注：设备默认每页 20 条；getList 只返回基础字段，留言/中继由 getDetail 补全

→ { type: "qso", subType: "getDetail", data: { logId } }
← { data: { ...memo, relay 等详细字段 } }
```

**统计本地计算**（`updateQsoCount()`，以本地 `qsoList` 为准）：
- 总通联 = `qsoList.length`
- 今日通联 = 本地时区当日 00:00 之后的时间戳过滤（兼容秒/毫秒时间戳）
- 友台数 = 按呼号（去 SSID）去重
- 搜索激活时显示「命中数 / 总数」

## 3. 事件推送 (Events WS)

| 事件类型 | 数据 | 处理动作 |
|---------|------|---------|
| `speaking_start` | `{ callsign, ... }` | 显示 SpeakingBar，更新呼号 / 方位 / 距离 / 网格 / 服务器；通联计时每秒刷新 |
| `speaking_stop` | `{ callsign }` | **立即**结束通联并隐藏 SpeakingBar；随后延迟 5s 触发 QSO 列表增量刷新（设备写日志有延迟） |
| `type: "qso", subType: "callsign"` | `{ callsign, isSpeaking, grid, ... }` | 依据 `isSpeaking` 驱动发言；频率/高度取本人 QSO 派生或 APRS 信标，不使用事件里的后台频点 |
| `type: "qso", subType: "history"` | `{ ... }` | 更新发言历史 |
| `new_qso` | `{ logId, toCallsign, grid, timestamp }` | 增量合并 QSO 列表 + 刷新统计 |
| `station_update` / `online_change` | `{ ... }` / `{ count }` | 刷新服务器面板 / 在线人数 |
| `beacon` | `{ ... }` | 从 APRS 信标解析发言人频率与高度 |

## 4. 音频流 (Audio WS)

- 格式：8kHz sample rate, 16-bit signed integer PCM, mono
- 接收：`binaryType = 'arraybuffer'`，每帧数据交 `handleAudioFrame` 处理
- 处理管线：`ArrayBuffer → Int16Array → AudioBuffer(Float32, ÷32768) → createBufferSource → Gain → DynamicsCompressor → destination`
- 增益链：AGC（目标 −18 dBFS，补偿上限 +18 dB / 衰减上限 −6 dB，−50 dBFS 噪声门）+ 限幅器（阈值 −1 dBFS，压缩比 20:1）
- VU 计算：RMS of frame → dB → 映射到 0–100% 电平
- 注：早期设计中的 AudioWorklet / FFT 频谱未落地，当前为逐帧 `createBufferSource` 播放

## 5. 响应别名映射

```javascript
const RESPONSE_ALIASES = {
  station: { getListRange: 'getListResponse' }
};
```

`station.getListRange` 的响应 subType 为 `getListResponse` 而非 `getListRangeResponse`；该别名及 `event:ok` + `data` 兜底匹配均实现于 `core.js` 的 `FMOCore.matchResponse`，由 `test.js` 回归覆盖。
