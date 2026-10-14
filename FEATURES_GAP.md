# FMO Mate · 功能缺口清单

> 对照对象：
> - [54dashayu/FMO-Dashboard](https://github.com/54dashayu/FMO-Dashboard)（★17，Vue3 + Tauri，实时仪表盘 + 日志 + 语音播报）
> - [dingle1122/FmoLogs](https://github.com/dingle1122/FmoLogs)（★13，BH5HSJ 后视镜，日志管理 + APRS 远控）
> - [wh0am1i/FmoDeck](https://github.com/wh0am1i/FmoDeck)（★7，战术 HUD + 地图值守屏 + SSTV 解码）
> - [EthanYan6/fmo-show](https://github.com/EthanYan6/fmo-show)（★6，墨水屏网页端，协议逆向来源）
> - [niufox/fmo-mobile-controller](https://github.com/niufox/fmo-mobile-controller)（★13，**官方 API v2 文档**，`API_DOCUMENTATION_v2.md`）
>
> 追加对照（2026-10-14）：
> - [fmo.feel101.com](https://fmo.feel101.com/product.html)「FMO 魔方」（PC 仪表盘 / 大字版 / 手机版 / 值守屏 / APRS 地图 / 小爱版）
> - [bg5esn.com/docs](https://bg5esn.com/docs/) 官方文档站（使用说明书 · 更新说明 · 开源资源清单 · 实践分享）
> - [BG5ESN](https://github.com/BG5ESN) 官方开源工具集
>
> 最近更新：2026-10-14

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

### B 级：设备配置读写 —— ✅ 已全部实现（仅 `setUrl` / `setPort` 主动放弃）

> **2026-10-14 收尾**：B1 / B3 / B6 / B7 / B8 全部并入「设备配置」弹窗，B 级只剩主动放弃的两项。
> **可用性别确认**：设备固件可能并未实现全部 `config` 方法。打开弹窗时会自动读取，读不回来的字段保持空白；
> 也可在 URL 加 `?probe=config`（或控制台 `FMO.probeConfigApi()`）逐个探测，控制台会打印 ✅/✗ 清单——
> 带 ✗ 的即为固件未实现，可据此从界面移除。

| # | 功能 | 写接口 | 约束 / 状态 |
|---|------|--------|------------|
| B1 | **服务器名称** | `config.setServerName` | ≤31 字符 · ✅ 已实现（2026-10-14） |
| B2 | **APRS 备注 / 图标 / Passcode** | `setAprsRemark` / `setAprsType` / `setPasscode` | ≤63字节 / 1-15 / 5位或-1 · ✅ 已实现（2026-10-11） |
| B3 | **黑名单** | `setBlacklist` | `^[A-Z0-9, ]*$`，≤511 字符 · ✅ 已实现（2026-10-14） |
| B4 | **设备坐标** | `setCordinate {latitude, longitude}` | ✅ 已实现（2026-10-11） |
| B5 | **天线描述 / 高度 / 物理频率** | `setUserPhyAnt` / `setUserPhyAntHeight` / `setUserPhyFreq` | ≤15 / 0-100000m / 0-1000MHz · ✅ 已实现（2026-10-11） |
| B6 | **QSO 祝福语 / 登录公告** | `setQsoBestWish` / `setServerLoginAnnouncement` | ≤64字节 / ≤127字节 · ✅ 已实现（2026-10-14） |
| B7 | **服务器过滤半径** | `setServerFilter` | 0-8 整数 · ✅ 已实现（2026-10-14）。**语义按官方使用说明书修正**：以本机网格为圆心、该值为半径画圆，圆内服务器保留、圆外过滤（UI 已改为「0 · 不过滤 / N 级」） |
| B8 | **广播服务器 / 广播用户模式** | `setBroadcastServer` / `setBroadcastUser` | 无参数、无查询接口，做成即时按钮 · ✅ 已实现（2026-10-14） |
| B9 | **物理设备名** | `setUserPhyDeviceName` | ≤15 字符 · ✅ 已实现（2026-10-11） |
| — | ~~上游服务器地址 / 端口~~ | ~~`setUrl` / `setPort`~~ | ⛔ **主动放弃**：改错即掉线，设备就在手边，网页端收益低风险高 |

> 注意：`config.setUrl` / `setPort` 会改设备连的上游地址，**不建议做**（改错就掉线）。

### C 级：日志持久化与导入导出

| # | 缺失功能 | 依据 | 说明 |
|---|---------|------|------|
| C1 | **日志全量备份下载** | HTTP `POST http://<host>/api/qso/backup`，再 GET 同一地址拿 `.db`/`.zip`（FmoLogs `fmoBackupService.ts` 中 `BACKUP_PATH = '/api/qso/backup'`） | ✅ **已实现**（2026-10-14）：通联记录面板「备份」按钮，隐藏 iframe POST 触发导出 + 新标签页 GET 下载，规避 CORS |
| C2 | **本地持久化（IndexedDB）** | FmoLogs / FMO-Dashboard / FmoDeck 都用 IndexedDB + sql.js | ✅ **已实现**（2026-10-14）：IndexedDB 缓存 QSO + 服务器列表，启动先渲染缓存再增量合并，翻页命中缓存即停；设置里可查缓存量与清空 |
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
| E1 | **「老朋友」页** | ✅ **已实现**（2026-10-14）：TOP 面板新增「TOP20 / 老朋友」tab；老朋友按呼号聚合（次数 / 最近 / 首次 / 网格），今日已联高亮；点击弹出与该友台的全部通联历史，每行可再点开 A7 详情 |
| E2 | **排行榜多维度** | ✅ **已实现**（2026-10-14）：TOP 面板 4 个 tab —— TOP20（呼号）/ 老友 / **网格**（取前 4 位方块 + QTH 地名）/ **中继**（点击名字直接切换，复用 A4） |
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

### H 级：2026-10-14 新增（外部服务对接 + 固件日志里挖出来的能力）

| # | 功能 | 依据 | 状态 |
|---|------|------|------|
| H1 | **网格→行政区划改用 `grid.lzyike.cn`** | `GET https://grid.lzyike.cn/api/grid2addr/<GRID4>` → `{retcode,data:{country,province,city,district,township}}`。免费、免 Key | ✅ **已实现**（2026-10-14）：提到 Tier 0，高德降为 Tier 1。高德 Key 有每日配额（曾报 `CUQPS_HAS_EXCEEDED_THE_LIMIT`），此服务无配额问题。**注意只取前 4 位网格查询**，6 位精度该服务只返回国家 |
| H2 | **APRS / 节点地图外链** | [map.srv.ink](https://map.srv.ink/)（BG9JYT，实时抓 APRS 节点位置与状态）、[aprsmap.feel101.com](https://aprsmap.feel101.com)（全国 FMO 设备实时分布 + 通联事件流 + 台站与客户端一览） | 待做。替代 E4 自研地图：不引地图库，直接外链 |
| H3 | **台网点名** | [fmo.bh1jss.net/checkin](http://fmo.bh1jss.net/checkin/)（BH1JSS 开发的点名主控软件） | 待做。可加外链入口 |
| H4 | **浏览器定位写入设备坐标** | 官方 [FMO-Andorid-GPS-Tool](https://github.com/BG5ESN/FMO-Andorid-GPS-Tool) 用手机 GPS 实时设置 FMO 位置；网页端可用 `navigator.geolocation` + 已有 B4 的 `config.setCordinate` | 待做。零依赖，是 B4 的自然延伸（车载 / 移动场景很实用） |
| H5 | **QSO 日志签名验证** | 官方 [fmo-log-sign-verify-tool](https://github.com/BG5ESN/fmo-log-sign-verify-tool)，FMO 日志带 **Ed25519** 数字签名（固件 v2.2.19 起「增加日志数字签名功能」） | 待做，难度高（需在浏览器实现 Ed25519 验签 + 拿到签名格式） |
| H6 | **`.db` 日志 → ADIF** | 官方 [FMO-sqlite-2-adif](https://github.com/BG5ESN/FMO-sqlite-2-adif) | 待做。与 C3/C4 合并：备份拿到的 `.db` 在前端转 ADIF（需 sql.js） |
| H7 | **黑名单用户库对接** | 官方 [fmo-blacklist-users](https://github.com/BG5ESN/fmo-blacklist-users) 公开的黑名单数据 | 待做，可选（隐私与误伤需谨慎） |
| H8 | **设备端网页的其他能力** | 固件日志：`v2.2.13` 网页远控页增加**待机控制 / 个人信息 / 搜索到台站切换**；`v2.3.8` **配网 API**（`/api/provision`）；`V4.1.0` **台站导入**；`v2.2.20` **MESSAGE 短消息**；`v2.3.13` **活跃服务器列表** | ⚠️ **需实测**：这些是设备端功能，但 WebSocket 接口名未知。可加 `probeDeviceApi()` 逐个试 `/api/*` 与 `message.*` 等命名空间 |

> **收藏服务器的重要更正**：固件 `V4.1.10`（2026/9/1）「修复收藏服务器」，说明**设备端确实有收藏功能**，
> 只是未通过 WebSocket 暴露（我们 2026-10-11 探测的 12 个候选名全部超时）。若 H8 实测能找到接口，可重新加入。

---

## 三、建议实施顺序

**已完成**：A1–A8（全清）、B1–B9（全清，除主动放弃的 setUrl/setPort）、C1、C2、E1、E2、E5、H1 —— 共 23 项

1. **下一步可做（都很轻）**：H2 APRS/节点地图外链、H3 台网点名外链、H4 浏览器定位写坐标、E6 回到顶部
2. **中等工作量**：D1-D3 语音播报（NATO）、E3 多地址
3. **较重**：C3/C4 `.db` 日志导入与转 ADIF（H6，需 sql.js）、D4 离线 TTS 兜底
4. **需先实测**：H8 设备端网页其他接口（`message.*` / `/api/provision` / 待机控制 / 台站导入）
5. **暂缓**：F 平台化、G 不做项、H5 日志签名验证、H7 黑名单库

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
