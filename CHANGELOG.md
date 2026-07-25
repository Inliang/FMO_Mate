---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 4d32f127e120f5be24dadce57b263d70_718434ba723711f1897e5254002afed2
    ReservedCode1: ULwvedkHCQCnTYd1YhKrAPpNqsFRdUbaznmy9McD8ctT2KLDgebYNYDYOYLjBkxZynmX5bmHOwKTL8UjyVDk5n4YFgUFkTzK26b1jNo1QVAJXDb5PNVNtMoIudKoaibC39FZIg5p4aU71LtmTVXZBObP4QfFuwZq1OhmdBRdQoxyeALIOy0g7TMVX1A=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 4d32f127e120f5be24dadce57b263d70_718434ba723711f1897e5254002afed2
    ReservedCode2: ULwvedkHCQCnTYd1YhKrAPpNqsFRdUbaznmy9McD8ctT2KLDgebYNYDYOYLjBkxZynmX5bmHOwKTL8UjyVDk5n4YFgUFkTzK26b1jNo1QVAJXDb5PNVNtMoIudKoaibC39FZIg5p4aU71LtmTVXZBObP4QfFuwZq1OhmdBRdQoxyeALIOy0g7TMVX1A=
---

# FMO 副屏伴侣 — 更新日志

## 2026-07-25

### 整站 UI 重构：三主题体系 + 新布局 + 细节打磨（v=0725a ~ v=0725g）

**CyberGuard 赛博青暗色主题（v=0725a）**
- 全新暗色主题，以赛博青（Cyber Cyan）为主色调
- CSS 变量体系：`--accent: #00e5ff` 贯穿全局
- Status Bar / 卡片 / 按钮 / Speaking Bar 全面适配

**布局重构：三段式信息流（v=0725d）**

三段式纵向布局替代旧网格布局：

| 区域 | 类名 | 内容 |
|------|------|------|
| 顶部 | `.status-bar` | KPI 卡片行（CALL / UID / 天线 / 固件）融入 Status Bar |
| 中段 | `.middle-split` | 左：Speaking Bar（当前发言者）+ 右纵列（上个通联 + 服务器卡片） |
| 底部 | `.bottom-panels` | 最近发言 \| QSO 通联记录等宽分栏 |

- 旧类名 `dashboard-grid` / `dashboard-side` / `bottom-split` / `bottom-row` 全部移除
- `.kpi-row` 改为 `.status-bar .kpi-row` 紧凑样式

**三主题体系更新**
- **Steel**：工业风浅色主题（默认），金属灰 + 雾蓝色点缀
- **CyberGuard**：赛博青暗色主题
- **E-ink**：高对比度黑白主题，适配墨水屏
- 三套主题同步覆盖新布局所有断点（≤1200 / ≤900 / ≤480 及横屏）

**细节打磨**

- **Speaking Bar 布局**（v=0725f）：`.ac-hero` 呼号区 `flex:1` 垂直居中，`.detail-card` padding 收窄贴底
- **页脚单行布局**（v=0725e）：51la 统计左对齐 + GitHub / Envo 链接右对齐，`flex space-between`
- **服务器列表铺满卡片**（v=0725g）：`.server-list-sidebar` 改为 `flex: 1; min-height: 0`，自动占满剩余空间
- **最近发言与 QSO 行高统一**：`.recent-item` 由双行改为单行布局，字号与 padding 对齐 `.qso-row`
- **51la 访客统计**：页脚集成 51la 统计代码

### 最近发言卡片 memo/relay 全链路修复 — 追溯式补全（v=0721c → v=0722a）

### 最近发言卡片 memo/relay 全链路修复 — 追溯式补全（v=0721c → v=0722a）

**根因**：发言记录创建时（`speaking_start` / `qso.callsign` with `isSpeaking`）未携带 memo/relay 字段，后续的 QSO 查找补全因两个原因失败：① QSO 列表在发言事件到达时可能尚未加载；② `_enrichQsoDetails` 仅补全前 15 条 QSO，命中未补全条目时 `renderRecentSpeakers` 的兜底查询仅做本地字段提取，没有异步 fetch。

**修复**：不再追加新的兜底逻辑，而是将发言记录补全嫁接到 QSO 数据的同一加载生命周期：
- 新增 **`_enrichSpeakingRecords()`**：在 `fetchQsoListAll` 中 `_enrichQsoDetails()` 完成后立即调用


- 逻辑：遍历 `_speakingHistory` → QSO 匹配 → 本地字段提取（已补全的直接命中）→ 未补全的按 `logId` 并发拉取 `qso.getDetail`
- 补全完成后调用 `renderRecentSpeakers()` 刷新 UI

### 最近发言卡片 memo/relay 数据路径对齐 QSO 卡片（v=0721b → v=0721c）

- **`_getQsoMemoRelay(item)`**：统一 memo/relay 字段提取链，与 `renderQsoList` 完全一致
  - memo: `toComment → memo → message → msg → text → content`
  - relay: `relayName → serverName → stationName → relay → gateway`
- **`_fetchQsoMemoRelayByLogId(logId)`**：按 logId 获取 QSO 详情（带缓存），用于未补全的 QSO 记录
- **`_addSpeakingRecord` 改为 async**：先走本地字段提取，QSO 未补全时通过 `qso.getDetail` 拉取 memo/relay
- **`renderRecentSpeakers`**：两个 QSO 兜底查询全部改用 `_getQsoMemoRelay`，字段链与 QSO 卡片一致

### APRS BEACON 频率/高度解析 + 最近发言卡片字段补全（v=0704e → v=0721a）

- **频率/高度卡片**：新增 APRS-IS APFMO4 BEACON 消息解析。`_processEvent` 监听 `event: beacon` 事件，`_parseBeaconPayload` 从逗号分隔载荷中提取 `FREQ:`（4位小数 MHz）和 `HEIGHT:`（整数米），同时更新频率卡片和设备信息条。`_extractFreqFromEvent` 新增 Tier 1 优先级：先尝试 APRS BEACON 载荷格式匹配，命中后直接返回，未命中再回退到 JSON 字段提取
- **最近发言卡片**：重构为与通联记录卡片一致的六列布局——呼号、网格（可点击地图）、QTH 地理位置、留言、中继/服务器、相对时间 + 通联次数徽章。`_addSpeakingRecord` 自动从 QSO 历史中查找匹配呼号补全 memo 和 relay 字段
- **CSS**：新增 `.recent-accent` / `.recent-callsign` / `.recent-grid-cell` / `.recent-qth-cell` / `.recent-memo-cell` / `.recent-relay-cell` / `.recent-time` / `.recent-cell-empty` 样式类，与 QSO 行风格统一；移除旧的 `.recent-index-bg` / `.recent-main` / `.recent-callsign-line`

## 2026-07-04

### 移动端 / 平板端响应式优化 + 横竖屏切换（v=0704a → v=0704b）

- 四层响应式断点：≤1200px（小桌面）/ ≤900px（平板）/ ≤480px（手机竖屏）/ 横屏≤500px
- 移动端新增横竖屏切换按钮（⇅），`mobile-landscape` class 强制两栏布局，localStorage 持久化
- 左栏活跃联系人卡：bearing-panel 改为内联布局，ac-hero 改为水平排列，详情卡弹性换行
- 所有断点统一紧凑字号/间距/圆角，设备信息条 tablet 以下自动折行

### 三主题切换 + ADIF 中继信息导出（v=0628g → v=0704a）

- 右上角"视图"按钮替换为暗/亮/墨三主题切换按钮，CSS 变量覆盖实现浅色和水墨屏主题
- `_applyTheme()` 切换 `data-theme` 属性 + 按钮 active 态，localStorage 持久化
- ADIF 导出 COMMENT 字段加入中继信息（Relay:xxx）
- 删除底部 ICP 备案信息，README.md 排版美化

## 2026-06-28

### QSO 留言/中继 getDetail 响应路径修正（v=0628f → v=0628g）

- 上轮修复 `_enrichQsoDetails` 取 `r.value.data` 合并到 QSO 列表项 — 但 `send()` 返回完整消息体 `{ type, subType, data: { log: {...} }, code }`，`data.log` 才是真实 QSO 记录
- 修正为 `r.value.data.log`，加 `code === 0` 校验和异常日志
- 参照 FMO-Dashboard 的 `detailResponse.log` 数据路径确认此修复

### QSO 留言/中继通过 getDetail 逐条补全（v=0628e → v=0628f）

- 根本原因：V2 API `qso.getList` 只返回 `{logId, timestamp, toCallsign, grid}` 四个基础字段，完全不包含 `toComment`/`relayName`，之前追加字段名提取链是无效修复
- 方案：新增 `_enrichQsoDetails()` — 对列表前 15 条 QSO 逐条调用 `qso.getDetail` 获取完整记录，以 `_qsoDetailCache` 缓存避免重复请求，并发度 5
- `RESPONSE_ALIASES.qso` 追加 `getDetail: 'getDetailResponse'`
- 版本号 bump 至 v=0628f

### QSO 留言/中继字段名修复 + 版本号 Bump（v=0628d → v=0628e）

- QSO `renderQsoList()` 中留言字段提取链遗漏 `toComment`，中继字段提取链遗漏 `relayName`，导致 FMO V2 API 返回的留言和中继数据始终显示为空 → 在提取链前端追加 `toComment` 和 `relayName`
- 证据来源：FmoLogs 开源项目 `ColumnNames: { toComment: '留言', relayName: '中继' }`
- 版本号 bump 至 v=0628e 强制刷新缓存

### 版本号 Bump（v=0628c → v=0628d）

- 搜索弹窗 `$` 修复已部署但浏览器缓存旧版本（v=0628c），错误持续复现 → bump 版本号强制刷新缓存

### 服务器搜索弹窗修复（第二轮：$ 未定义）

- `_renderSearchPopup()` 中使用了 `$('...')` 简写，但 `$` 仅在 `bindEvents()` 内局部定义，导致 `ReferenceError: $ is not defined`，搜索弹窗完全无法渲染 → 替换为 `document.getElementById()`
- 根因与第一轮 `<button>` 非法嵌套修复叠加，两者共同导致搜索功能失效

### 服务器搜索弹窗修复（第一轮） + AMap Key 加密

- 服务器搜索弹窗 `server-search-popup` 原本嵌套在 `<button>` 内，违反 HTML 规范导致浏览器自动修正 DOM 结构，弹窗脱离定位上下文无法正常工作 → 将 `<button>` 改为 `<div>`，弹窗恢复正常
- 高德 API Key 明文硬编码于 `app.js` → 采用 XOR+Base64 混淆方案（seed=`FMOSECURE2026`），新增 `_getAmapKey()` 解码方法，`_AMAP_KEY` 常量替换为 Base64 混淆值，所有 API 调用改用 `_getAmapKey()` 获取真实 Key
- 提交 1615bf5

### 上个通联卡片呼号裁切修复

- `.dashboard-side` 宽度 260px → 280px，为三列网格提供更多空间
- `.prev-info-item` 水平 padding 10px → 6px，节省 8px 左右空间
- `.prev-info-value` 字号 15px → 14px，添加 `overflow:hidden` + `text-overflow:ellipsis` 兜底
- `.prev-info-item` 新增 `min-width:0` 防止网格项撑破容器
- 内容区从 ~55px 增至 ~70px（+27%），彻底解决 6 位呼号被截断问题

### 仪表盘布局优化：呼号卡片右边框左移 + prev-card 空间扩展

- `.active-contact-card` 新增 `max-width: calc(100% - 288px)`，右侧留出 20px 呼吸空间，避免呼号卡片贴边到 sidebar
- `.dashboard-side` 宽度从 250px 增至 260px，为右侧卡片内容提供更多展示空间
- `.previous-card` `max-height` 从 130px 增至 210px，3 列网格信息（呼号/网格/时间）不再被截断
- 移动端 `.active-contact-card` 添加 `max-width: 100%` 覆盖桌面约束
- 提交 b9acf68

### 修复地理编码重复请求导致 API 耗尽 & QTH 全量回退

- 分析设备日志发现 `_resolveGridLocation` 被 `renderQsoList` 和 `fetchQsoListAll.all.forEach` 双重调用，同一网格码在缓存写入前（异步间隙）通过两次 cache check，导致 2x Amap + 2x Nominatim = 4 个请求/网格码，15 条 QSO = 60+ 并发地理编码请求
- 新增 `_gridLocationPending` Set 追踪进行中的异步调用，彻底消除重复请求
- 当 Amap 和 Nominatim 均失败时，将网格码本身缓存为 fallback（避免无限重试并保证 QTH 列至少显示网格码而非 `--`）
- 异常路径 finally 块确保 `_gridLocationPending` 清理，防止死锁
- 提交 (待提交)

- `_AMAP_KEY` 属性从未定义（提交 `2aa9f31` 删除后未恢复），导致 29 次 `INVALID_USER_KEY` 错误，所有逆地理编码回退到 Nominatim 超时
- AudioContext 在页面加载时创建（无用户手势），触发浏览器 60+ 次安全警告。改为延迟到首次交互时初始化
- HTTPS 页面连接 `ws://` 触发 Mixed Content 警告。新增自动检测 `location.protocol === 'https:'` 升级到 `wss://`
- 提交 9bcee4e

### 回滚 ws→wss 自动升级（关键回退）

- commit 9bcee4e 的 Mixed Content 修复导致所有 WebSocket 连接全线断开（ERR_CONNECTION_RESET）
- 根因：FMO 设备（192.168.1.13）仅支持纯 ws://，不支持 wss://
- 三个端点（/ws, /events, /audio）同时失效，整个 App 不可用
- 回滚为直接使用 `this.protocol`，Mixed Content 警告不影响功能
- 提交 055a83f

### 逆地理编码双层 Fallback 重构

- BigDataCloud API 已彻底不可用（400），且 fetch() 非抛异常导致 fallback 永不触发
- **移除** BigDataCloud 分支和 `_amapJsonp` JSONP 注入方法
- **Tier 1**：高德 REST API，`fetch()` 直连（CORS `*` 支持，无 JSONP 脚本注入）
- **Tier 2**：Nominatim 国际环境兜底
- 全部错误路径加 `throw` 确保 fallback 可靠触发
- 提交 f0d7348

### 缓存版本号修复

- app.js 缓存版本号落后于 CSS，统一升级至 v=0628c
- 提交 576afd8

## 2026-06-27

### 服务器列表改为浮动搜索弹窗

- 服务器列表右侧"列表"标签改为"搜索"，点击弹出浮动搜索框
- 支持中文名、拼音首字母、UID 多维匹配
- 点击搜索结果后弹窗关闭并跳转到对应服务器
- click-outside 关闭弹窗

### 服务器列表在线数添加 APRS V4 U 前缀

- 服务器列表每行右侧在线数前添加 APRS V4 `U` 前缀，格式如 `U5 在线`
- U 字段表示 APRS 协议中的 `<online>` 用户数

### APRS UID 参数显示

- device-strip 中 CALL 后方新增 UID 参数标签
- 数据来源 `user.getInfo` 响应的 `uid` 字段

### 日志模块重构

- 更新日志内容从 app.js 抽离到 CHANGELOG.md，还原 app.js 纯净运行日志
- FMO-DEBUG 调试日志抽离到独立 `logger.js` 模块

---

## 2026-06-28

### UI 均衡调整
- 主呼号字体 `clamp(96px,12vw,140px)` → `clamp(60px,7vw,84px)`
- 罗盘 80px→60px，箭头 18×28→15×24，方位数值字体缩小
- 主卡片 hero 底部 padding 24px→14px
- 底部面板 max-height 300px→380px，右侧边栏 320px→272px
- 缓存版本 v=0628b

### 卡片高度固定（flex overflow 修复）

- `.live-table-wrap` 和 `.server-list-sidebar` 添加 `min-height: 0`
- 修复 flex 子元素默认 `min-height: auto` 导致内容撑破父容器 `max-height` 的问题
- 最近发言、通联记录、服务器列表卡片高度固定，内容溢出时内部滚动

### 设置面板暗色扁平风格

- 设置面板 overlay-box 改为纯暗色扁平风格（`#0c1117`）
- 边框透明度提升至 0.12，叠加深度阴影
- btn-muted / btn-accent 统一 `box-shadow: none` + `outline: none` + `border: none`
- 输入框回车键触发保存

### UTF-8 编码修复

- `index.html` / `app.js` 从 UTF-16 LE 转为 UTF-8
- 内嵌 overlay CSS 确保 file:// 协议下样式生效
- 修复编码问题导致设置按钮无响应的 bug

### 上个通联卡片微调

- 参数值水平居中
- 参数垂直居中 + 方位值不换行

### 逆地理编码三层 fallback 链路

- 梅登海德网格 → QTH 地址解析重构
- 修复 `_resolveGridLocation` 调用链与查错能力
- 修复 display_name 解析缺少市级的 bug（从区与省之间提取市级）
- Nominatim 中国大陆被墙 → 高德 JSONP（key 类型不匹配）→ BigDataCloud（无需 key）
- 最终形成 BigDataCloud → 高德 JSONP → Nominatim 三层 fallback 链路

---

## 2026-06-21

### v0.4.9

**Bugfix：修复部分固件版本服务器列表无法获取**

- `fetchServerListAll()` 移除对 `resp.code === undefined` 的强制跳过，兼容不返回 `code` 字段的固件版本
- 响应解析扩展 `payload.stations` / `payload.items` 格式支持

### v0.4.12

**Bugfix：RESPONSE_ALIASES 修正 + 响应匹配兼容 V2 协议 event 字段**

- RESPONSE_ALIASES 从 `getListRangeResponse` 修正为 `getListResponse`（对齐 FmoLogs 参考实现，设备实际返回 subType 为 getListResponse）
- handleWsMessage 外 guard 从 `!msg.event` 改为 `!msg.event || msg.subType !== undefined || msg.code !== undefined`：V2 协议响应可能带 `event: "ok"`（遵循 AT 协议规范），需通过 subType/code 辅助识別响应消息
- 回退匹配移除冗余 `!msg.event` 条件（外 guard 已拦截纯事件）
- fetchServerListAll 移除 `resp.event` continue 跳過邏輯（現已冗餘，且會誤跳 V2 合法響應）

### v0.4.11

**Bugfix：RESPONSE_ALIASES 回退 + 恢复 type 回退匹配**

- RESPONSE_ALIASES 从 `getListResponse` 回退为 `getListRangeResponse`（部分固件实际返回格式）
- 恢复 `!matched && msg.type === r.type && !msg.event` 回退匹配（v0.3.39 时期已存在）
- 两层匹配：先严格 type+subType，失败后 type 回退兜底（排除事件消息污染）

### v0.4.10

**Bugfix：移除 handleWsMessage 贪婪回退匹配，修复服务器列表获取失败**

- `handleWsMessage` 中删除 `!matched && msg.type === r.type && !msg.event` 回退匹配
- 该回退在串行队列模式下过于贪婪：当 station/getListRange 在飞行中时，任何 type=station 的非事件消息都会被错误消费为响应，导致真实 getListResponse 被丢弃
- 对齐 fmo-show / FMO-Dashboard / FmoDeck 三个参考项目的严格 type+subType 匹配策略

### v0.4.15

**Tide 风格全面 UI 优化** — 30 项精细化调整，参考 Dribbble 金融仪表盘设计

- 新增 warning 色系 + border 精细化变量
- Active Contact Card / Device Strip / Detail Card / Bearing Panel 去玻璃化改纯色
- 全局卡片圆角统一 10px/16px，边框统一 --border-subtle
- 底部面板 header 增加分割线，行间距优化
- Status Bar 玻璃保留但精炼，Stat Pill 样式收窄
- 全局 typography 微调（标签字重/尺寸、数值加粗）

### v0.4.14

**右侧边栏去除毛玻璃效果** — `.previous-card` / `.server-card` / `.prev-info-item` 改为纯色不透明背景

### v0.4.13

**右侧边栏 UI 统一为毛玻璃卡片风格**

- `.prev-info-item` 升级为玻璃卡片，匹配主面板 `.detail-card` 视觉语言
- `.server-card-header` padding 对齐 `.section-label` 节奏
- `.side-loading` 加载状态对齐主面板占位风格
- `.server-list-trigger` 增加 mono 字体和字重，匹配交互元素

### v0.4.8

**底部面板去毛玻璃化 + 最近发言/通联记录左右分栏**

- live-panel 和 qso-panel 移除毛玻璃效果，改为纯色背景
- index.html 新增 `.bottom-split` 包裹 div，桌面端横向 50/50 分栏，移动端纵向堆叠

### v0.4.7

**Bugfix：修复频率、服务器列表、QSO 日志三项数据获取为空**

- **服务器列表**：`RESPONSE_ALIASES` 修正为 `{ station: { getListRange: 'getListResponse' } }`，与协议文档和 fmo-show 源码一致
- **QSO 日志**：`fetchQsoListAll()` 改为 `getListRange` + `{ start, count }` 分页参数
- **频率显示**：新增 `fetchRadioInfo()` 方法，兼容不同固件版本的频率端点，支持 polling 刷新

### v0.4.6

**bearing-panel 右上角重定位** — 罗盘方位组件从卡片中部移到右上角

- `.bearing-panel` 移入 `.ac-hero` 内部作为 flex 右侧伴生元素，新增 `.hero-main` 包裹层
- 罗盘尺寸 72→48px，箭头 22×32→16×24px，方位文字字号同步缩小

---

> 更早的版本记录可通过 `git log` 查看。
*（内容由AI生成，仅供参考）*
