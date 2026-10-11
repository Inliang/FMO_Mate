# FMO Mate · 功能缺口清单

> 对照对象：
> - [54dashayu/FMO-Dashboard](https://github.com/54dashayu/FMO-Dashboard)（★17，Vue3 + Tauri，实时仪表盘 + 日志 + 语音播报）
> - [dingle1122/FmoLogs](https://github.com/dingle1122/FmoLogs)（★13，BH5HSJ 后视镜，日志管理 + APRS 远控）
> - [wh0am1i/FmoDeck](https://github.com/wh0am1i/FmoDeck)（★7，战术 HUD + 地图值守屏 + SSTV 解码）
> - [EthanYan6/fmo-show](https://github.com/EthanYan6/fmo-show)（★6，墨水屏网页端，协议逆向来源）
> - [niufox/fmo-mobile-controller](https://github.com/niufox/fmo-mobile-controller)（★13，**官方 API v2 文档**，`API_DOCUMENTATION_v2.md`）
>
> 最近更新：2026-10-11

---

## 一、我们已经有的（不再重复造）

| 能力 | 说明 |
|------|------|
| 三路 WebSocket | `/ws`（JSON-RPC 串行队列）、`/events`（推送）、`/audio`（8kHz PCM） |
| 当前发言卡 | 呼号、方位角、距离、梅登海德网格→QTH、通联计时、通联次数、"新"标记 |
| 上个通联卡 | 相对时间（超过 24h 显示"X天X小时前"） |
| 服务器卡 | 全量滚轮列表、按 **uid** 精确切换、拼音/名称/UID 搜索弹窗 |
| 底部三面板 | 最近发言、QSO 通联记录（含 `qso.getDetail` 补全留言/中继）、TOP20 |
| ADIF 导出 | 通联记录面板导出按钮 |
| 设备 KPI | 呼号 / UID / 固件 / MAC / 硬件 / 天线 / 频率 / 在线数 / 地址 |
| 音频 | 播放 + 静音按钮 + 音量滑块 + VU 电平 + 24 柱真实 FFT 迷你频谱 |
| 三主题 | 亮 / 暗 / 水墨 + 横竖屏切换 |
| 设置 | IP / 端口 / 协议（ws、wss） |
| 统计 | 累计 / 今日 / 友台数 |

---

## 二、缺失功能清单（按「价值 ÷ 成本」排序）

### A 级：协议已支持，纯前端加 UI 即可，成本低、收益明显

| # | 缺失功能 | 接口 / 依据 | 状态 |
|---|---------|-----------|------|
| A1 | **上一台 / 下一台快速切换** | `station.next` / `station.prev`（官方 v2 §2.3） | ✅ **已实现**（2026-10-11）：服务器卡片顶部 ‹ › 两个按钮，切换后自动 `getCurrent` 同步并重载 QSO |
| A2 | **显示当前服务器 UID** | `station.getCurrent` 返回 `{uid, name}` | ✅ **已实现**（2026-10-11）：服务器卡片顶部「名称 + `#uid`」条（原 `#server-name-display` 元素缺失已一并修复） |
| A3 | **最近活跃服务器切换入口** | 本地记录最近使用过的 uid（localStorage） | ✅ **已实现**（2026-10-11）：`localStorage['fmo-recent-servers']` 存最近 6 个，卡片顶部横向 chip 一键回切 |
| A4 | **点击 QSO 记录里的中继名直接切换** | `station.getListRange` + `setCurrent` | ✅ **已实现**（2026-10-11）：通联记录 / 最近发言中的中继名可点击；同名中继会提示各 uid 让用户手动选 |
| A5 | **呼号点击跳转 QRZ** | `https://www.qrz.com/db/<CALL>` | ✅ **已实现**（2026-10-11）：通联记录 / 最近发言 / TOP20 呼号可点，当前呼叫卡片新增 QRZ 图标按钮 |
| A6 | **QSO 按呼号搜索/筛选** | 前端过滤已有数据 | ✅ **已实现**（2026-10-11）：通联记录面板搜索框，匹配呼号 / 网格 / QTH / 中继 / 留言，Esc 清空 |
| A7 | **QSO 详情弹窗** | `qso.getDetail`（已在用） | ✅ **已实现**（2026-10-11）：点击通联记录整行弹窗，字段含呼号 / 本机 / 网格 / QTH / 频率 / 距离 / 方位 / 中继 / 通联次数 / 时间 / 留言，可一键按该呼号筛选 |
| A8 | **今日已联 ⭐ 标记** | 前端比对今日日期 | ✅ **已实现**（2026-10-11）：通联记录 / 最近发言 / TOP20 的今日已联呼号带 ★ 徽标 |

### B 级：设备配置读写（`config` 命名空间，官方 v2 完整列出 30 个方法，我们只用了 5 个 get）

我们当前只读：`getCordinate`、`getUserPhyDeviceName`、`getUserPhyAnt`、`getUserPhyAntHeight`、`getUserPhyFreq`。
可写但没做 UI 的：

| # | 缺失功能 | 写接口 | 约束 |
|---|---------|--------|------|
| B1 | **修改设备/服务器名称** | `config.setServerName` | ≤31 字符 |
| B2 | **APRS 备注 / 图标 / Passcode** | `setAprsRemark`(≤63字节) / `setAprsType`(1-15) / `setPasscode`(5位或-1) | ✅ **已实现**（2026-10-11）：设备配置弹窗 APRS 分组，另有「重启 APRS」按钮 |
| B3 | **黑名单管理** | `setBlacklist` | 大写字母+数字+逗号+空格，≤511 字符 |
| B4 | **设备坐标设置** | `setCordinate {latitude, longitude}` | ✅ **已实现**（2026-10-11）：KPI 行新增独立「坐标 / GRID」卡片，点击弹窗写入设备并实时预览网格 |
| B5 | **天线描述 / 高度 / 物理频率** | `setUserPhyAnt`(≤15) / `setUserPhyAntHeight`(0-100000m) / `setUserPhyFreq`(0-1000MHz) | ✅ **已实现**（2026-10-11）：设备配置弹窗「物理设备」分组 |
| B6 | **QSO 祝福语 / 登录公告** | `setQsoBestWish`(≤64字节) / `setServerLoginAnnouncement`(≤127字节) | 待做 |
| B7 | **服务器过滤器** | `setServerFilter` (0-8) | 待做。控制台可见列表范围 |
| B8 | **广播服务器 / 广播用户模式** | `setBroadcastServer` / `setBroadcastUser` | 待做。无参数 |
| B9 | **物理设备名** | `setUserPhyDeviceName`(≤15) | ✅ **已实现**（2026-10-11）：设备配置弹窗「物理设备」分组 |

> 注意：`config.setUrl` / `setPort` 会改设备连的上游地址，**不建议做**（改错就掉线）。

### C 级：日志持久化与导入导出

| # | 缺失功能 | 依据 | 说明 |
|---|---------|------|------|
| C1 | **日志全量备份下载** | HTTP `POST http://<host>/api/qso/backup`，再 GET 同一地址拿 `.db`/`.zip`（FmoLogs `fmoBackupService.ts` 中 `BACKUP_PATH = '/api/qso/backup'`） | 我们目前只能按页拉。这是唯一已知的设备端 HTTP 接口 |
| C2 | **本地持久化（IndexedDB）** | FmoLogs / FMO-Dashboard / FmoDeck 都用 IndexedDB + sql.js | 我们刷新即丢历史，重连要重拉 |
| C3 | **导入 `.db` 日志** | FmoLogs 支持 | 需 sql.js（引入即破坏零依赖，可做成可选模块） |
| C4 | **.db / ADIF 双向导出** | 我们只有 ADIF | FmoLogs 可导出 .db |

### D 级：语音播报（零依赖可做，`speechSynthesis`）

| # | 缺失功能 | 说明 |
|---|---------|------|
| D1 | **新呼号语音提示** | FMO-Dashboard 有。首次出现的呼号播报一次 |
| D2 | **通联播报** | 每次新 QSO 播报呼号 + 网格 |
| D3 | **NATO 字母读法** | Alpha/Bravo/Charlie…，业余电台惯例 |
| D4 | **离线语音兜底** | 无网络 TTS 时降级到预合成音 |

### E 级：页面 / 视图增强

| # | 缺失功能 | 对照 |
|---|---------|------|
| E1 | **「老朋友」页** | FmoLogs 有：卡片展示历史友台，今日通联绿色高亮，点击看与该友台全部历史 |
| E2 | **排行榜多维度** | FmoLogs：接收方呼号 / 网格 / 中继三组 TOP20；我们只有呼号 TOP20 |
| E3 | **多 FMO 地址管理** | FMO-Dashboard / FmoLogs 都支持多个地址切换（含 `fmo.local` mDNS） |
| E4 | **地图视图**（外链版） | FmoDeck 有全屏地图 + 我↔对方连线 + 距离标签。真地图要引库，折中方案：网格点击跳 `https://maidenmap.wh0am1i.com/` 或 aprs.fi |
| E5 | **UTC / 本地双时钟** | ✅ **已实现**（2026-10-11）：状态栏并排显示本地时间与 UTC，点击 UTC 可复制 |
| E6 | **移动端长列表回到顶部** | FmoLogs 有 |

### F 级：平台化（与我们「单文件零依赖」定位冲突，优先级最低）

| # | 缺失功能 | 对照 |
|---|---------|------|
| F1 | PWA「添加到主屏幕」 | FmoDeck v0.2.2 有（需 HTTPS + Service Worker） |
| F2 | 桌面打包（Tauri Win/macOS） | FMO-Dashboard、FmoDeck 都发安装包 |
| F3 | Android / iOS 打包 | FMO-Dashboard + Capacitor |

### G 级：明确做不到 / 不建议做

| # | 功能 | 原因 |
|---|------|------|
| G1 | **收藏服务器同步** | **已核实：设备协议无收藏接口**，`station` 域只有 `getListRange / getCurrent / setCurrent / next / prev`，列表项只有 `uid` 和 `name`。我们已于 2026-10-11 移除本地收藏（多端不一致）。详见 `PROTOCOL.md` |
| G2 | **APRS 远程控制** | 需 APRS-IS **TCP** 长连接 + HMAC-SHA1 签名，浏览器无法开裸 TCP，必须自建后端 |
| G3 | **WiFi 配置** | 接口有（`wifi.scanWifi / setWifi / forgetWifi`），但改错就断网，且设备就在手边，网页改 WiFi 收益低风险高。最多做**只读**展示当前 SSID |
| G4 | **SSTV 解码** | FmoDeck 有（Robot36/72、Martin M1/M2、PD120、Scottie S1/S2）。纯前端可实现，但工作量大且需 FM 解调 + slant 校正，属独立子项目 |
| G5 | **在线人数** | 服务器列表无 `onlineCount` 字段，之前显示 `U-- 在线` 已改为显示 `#uid` |

---

## 三、建议实施顺序

**已完成（2026-10-11）**：A1、A2、A3、A4、A5、A6、A7、A8、B2、B4、B5、B9、E5 —— 共 13 项

1. **下一步可做（A 级已清空）**：E1 老朋友页、E2 多维排行榜、B1 设备名、B3 黑名单、B6 祝福语/公告、B7 服务器过滤器、B8 广播模式
2. **第三批**：C1 日志备份下载（`/api/qso/backup`）、C2 IndexedDB 持久化、C3 导入 .db、C4 导出 .db
3. **第四批**：D1-D4 语音播报（NATO）、E3 多地址、E4 地图外链、E6 回到顶部
4. **暂缓**：F 平台化、G 不做项

---

## 四、协议备忘：官方 API v2 完整命名空间

```
config.*   setUrl/getUrl setPort/getPort setPasscode/getPasscode
           setAprsRemark/getAprsRemark setServerName/getServerName
           setBlacklist/getBlacklist setBroadcastServer setBroadcastUser
           setAprsType/getAprsType restartAprsService
           setUserPhyDeviceName/getUserPhyDeviceName setUserPhyFreq/getUserPhyFreq
           setUserPhyAnt/getUserPhyAnt setUserPhyAntHeight/getUserPhyAntHeight
           setServerFilter/getServerFilter
           setServerLoginAnnouncement/getServerLoginAnnouncement
           setQsoBestWish/getQsoBestWish setCordinate/getCordinate

station.*  getListRange{start,count} getCurrent setCurrent{uid} next prev
qso.*      getList{page,pageSize} getDetail{logId}
wifi.*     scanWifi scanWifiResult getWifi saveWifi setWifi setWifiResult
           forgetWifi disconnectWifi

HTTP       POST/GET  http://<host>/api/qso/backup      # 日志备份（FmoLogs 逆向）
WS         /ws（JSON-RPC）  /events（推送）  /audio（16bit PCM LE 单声道 8kHz）
```
