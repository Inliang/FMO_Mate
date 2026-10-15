# fmo-secondary

> FMO 副屏伴侣 — 单 HTML 零依赖、纵向信息流仪表盘、三主题 Web 控制面板

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-010101?style=flat-square&logo=socket.io&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)

基于 [fmo-show](https://github.com/EthanYan6/fmo-show)（[@EthanYan6](https://github.com/EthanYan6)）和 [FmoDeck](https://github.com/wh0am1i/FmoDeck)（[@wh0am1i](https://github.com/wh0am1i)）的二次开发。

**当前版本：`v=1014g`**（版本号体现在 `style.css?v=xxxx` / `app.js?v=xxxx` 查询串上，用于强制刷新浏览器缓存）

---

## 快速开始

1. 确保电脑与 FMO 设备在同一局域网
2. 双击 `index.html` 打开页面
3. 输入 FMO 设备 IP 和端口（默认 `80`），点击连接
4. 连接成功后自动加载设备信息、服务器列表和 QSO 数据

---

## 项目定位

| 维度 | 说明 |
|------|------|
| 目标场景 | FMO 设备副屏 / 第二显示器，实时监控 QSO 状态 |
| 技术特点 | 单 HTML 文件、零外部依赖、双击即用 |
| 协议参考 | [FW 接口文档](https://bg5esn.com/categories/docs/) |
| 设计参考 | [UI UX Pro Max](https://ui-ux-pro-max-skill.nextlevelbuilder.io/) · [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) · [Dribbble](https://dribbble.com/) · [React Bits](https://reactbits.dev/) |

---

## 架构概览

```
┌───────────────────────────────────────────────┐
│  Status Bar：连接状态 · 统计 · 工具按钮         │
├───────────────────────────────────────────────┤
│  KPI 行：CALL / UID / AGL / VER / HW / ANT /   │
│          FREQ / 在线 / FMO IP / 坐标·GRID      │
├───────────────────────────────────────────────┤
│  Speaking Bar      │ 上个通联                  │
│                    │ 服务器（当前条 + 全量列表） │
├───────────────────────────────────────────────┤
│  最近发言  │ QSO 通联记录 │ TOP（4 个 tab）     │
├───────────────────────────────────────────────┤
│  Footer：51la 统计 + GitHub / Envo 链接         │
└───────────────────────────────────────────────┘
```

### 三路 WebSocket

| 连接 | 端点 | 协议 | 用途 |
|------|------|------|------|
| `/ws` | JSON-RPC | FmoDeck 串行队列（5s 超时） | 设备信息 / 服务器列表 / QSO 查询 |
| `/events` | Event Stream | 推送 | 讲话事件 / QSO 实时更新 |
| `/audio` | PCM 8kHz | 二进制流（16-bit LE mono） | 对讲音频播放 + VU 电平 |

### 三主题

| 主题 | 风格 | 场景 |
|------|------|------|
| **暗**（默认） | 霓虹绿控制室 HUD | 夜间 / 暗光环境、长时间值守 |
| **亮** | 工业风浅色，金属灰 + 雾蓝点缀 | 日常监控、强光环境 |
| **墨** | 高对比度黑白 | 墨水屏副屏 |

---

## 功能一览

### 顶部状态栏 + KPI 行

- 连接状态指示；统计：累计通联 / 今日 / 友台数
- **UTC 时钟**：点击即可复制当前 UTC 时间
- 工具栏：主题切换（亮 / 暗 / 墨）、横竖屏切换、设备配置、设置
- KPI 卡片：`CALL` `UID` `AGL` `VER` `HW` `ANT` `FREQ` `在线` `FMO IP` `坐标 / GRID`

### 中段

- **左：Speaking Bar** — 当前发言者呼号、方位角、距离、网格、服务器、通联计时、历史通联次数、`新` 标记、**今日已联 ★**，右上角地球按钮一键查 QRZ
- **右上：上个通联** — 相对时间展示（超过 24h 显示 `X天X小时前`）
- **右下：服务器卡** — 当前服务器条（上一台 / 下一台 + 名称 + UID）、全量滚轮列表、搜索弹窗（拼音首字母 / 名称 / UID）、最近使用的服务器快捷 chips

### 底部三面板

- **最近发言**：单行紧凑布局；点呼号 → QRZ；点网格 → 复制呼号并打开 `map.fmo.net.cn`；点中继名 → 直接切换服务器
- **QSO 通联记录**：六列统一布局（呼号 / 网格 / QTH / 留言 / 中继 / 时间）；支持**呼号或网格搜索**、点击行查看详情弹窗、点留言复制、点中继切换服务器；面板右上角「**备份**」下载设备完整日志
- **TOP 面板**（4 个 tab）：
  - `TOP20` — 按呼号排行
  - `老友` — 历史通联过的友台，点击进入老友详情
  - `网格` — 按网格方块（前 4 位）聚合，右侧显示 QTH 地名
  - `中继` — 按中继名聚合，**点击名字直接切换服务器**

### 设备配置（工具栏「设备」）

- 设备名 / 天线类型 / 天线高度 / 频率 / 备注
- 广播模式、APRS 类型与密码、APRS 服务器名、**过滤半径**、寄语、公告
- 支持重启 APRS 服务

### 坐标设置

- 点击 KPI 行「坐标 / GRID」卡片：输入经纬度 → 实时预览梅登海德网格 → 写入设备（`config.setCordinate`）
- 网格 → QTH 地名采用三级兜底：① `grid.lzyike.cn`（免 Key）② 高德 ③ Nominatim

### 音频收听

- VU 电平实时显示
- 迷你频谱：24 柱真实 FFT（1024 点 Hann 窗，200–3800Hz 对数分频）
- 静音按钮 + **音量加减控件**（`−` / 数值 / `+`，步进 10%，滚轮可调）
- 音量范围 **0% – 300%**：设备过来的声音偏小，超过 100% 为增益放大；`>100%` 时数值变琥珀色提示
- 大增益时经 `DynamicsCompressorNode` 限幅（阈值 −6dB，压缩比 12），避免爆音刺耳
- 音量记忆在 `localStorage['fmo-volume']`；点击数值可一键恢复 100%

### 数据与日志

- **设备备份**：`POST http://<host>/api/qso/backup` 触发设备导出，再 GET 同一地址下载**完整原始日志**（隐藏 iframe POST + 新标签页下载，规避 CORS；换电脑、清缓存也不丢历史）
- **本地缓存**：IndexedDB（库 `fmo-mate` v1，仓库 `qso` / `meta`）；启动时先渲染缓存再增量合并；1.5s 防抖写盘；上限 5000 条自动裁剪；不支持时静默降级
- 设置弹窗可查看缓存条数与更新时间，支持一键清空

### 移动端适配

- 响应式布局，呼号 / 频谱 / 信息栏自动缩放

---

## 版本说明

缓存失效依赖查询串 `?v=1014g`，每次改动都会同步 bump。若发现样式或行为异常，先强制刷新（<kbd>Ctrl</kbd>+<kbd>F5</kbd>）。

---

## 文件结构

```
fmo-secondary/
├── index.html        # 主页面
├── app.js            # 核心逻辑（WebSocket / 串行队列 / UI 渲染）
├── style.css         # 样式（三主题 + 响应式）
├── ARCHITECTURE.md   # 架构设计文档
├── PROTOCOL.md       # WebSocket 协议映射
├── FEATURES_GAP.md   # 功能缺口清单（对照第三方项目）
├── REFERENCES.md     # FMO 生态参考项目总清单
├── UI_DESIGN.md      # UI/UX 设计规范
├── CHANGELOG.md      # 更新日志
└── README.md
```

---

## 参考项目

本项目站在 FMO 生态众多开源项目的肩膀上，完整清单见 [REFERENCES.md](REFERENCES.md)。

### 直接上游

| 项目 | 作者 | 说明 |
|------|------|------|
| [fmo-show](https://github.com/EthanYan6/fmo-show) | EthanYan6 | 墨水屏风格网页端，协议逆向来源 |
| [FmoDeck](https://github.com/wh0am1i/FmoDeck) | wh0am1i（BH6SCA） | 战术 HUD + SpeakingBar + SSTV 解码 |

### 功能对照对象

| 项目 | 作者 | 说明 |
|------|------|------|
| [FMO-Dashboard](https://github.com/54dashayu/FMO-Dashboard) | 54dashayu（BH1JSS） | Vue3 + Tauri，功能最全，缺口清单主要对照它 |
| [FmoLogs](https://github.com/dingle1122/FmoLogs) | dingle1122（BH5HSJ） | 日志管理 + APRS 远控，`/api/qso/backup` 来源 |
| [fmo-mobile-controller](https://github.com/niufox/fmo-mobile-controller) | niufox | **官方 API v2 最完整文档** |
| [FMO 魔方](https://fmo.feel101.com/) | BI2RHY | 多终端网页控制端 |
| [FMOC](http://fmo.bg5eit.cn/) | BG5EIT | 网页控制端（非 HTTPS） |
| [FMO Console](https://map.fmoconsole.cn/) | — | 台站与通联状态面板 + iOS App |
| [FMO 设备信息统计](https://fmo.panyong.top/fmo-statistics) | BI1THT | 全网设备统计，按 CA 分组 |

其余分类（官方工具集 · 地图查询服务 · 集群管理 · 硬件结构件 · 文档教程 · 设计参考）详见 [REFERENCES.md](REFERENCES.md)。

---

## 致谢

本项目是基于 fmo-show（[@EthanYan6](https://github.com/EthanYan6)）和 FmoDeck（[@wh0am1i](https://github.com/wh0am1i)）的二次开发作品。原项目完整搭建了与 FMO 设备交互的协议实现、日志同步、APRS 等核心业务逻辑。本仓库在其基础上做界面与交互层的重写，所有底层能力均来自 fmo-show，特此鸣谢。

---

> 更新日志详见 [CHANGELOG.md](CHANGELOG.md)
