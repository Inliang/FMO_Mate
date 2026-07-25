# fmo-secondary

> FMO 副屏伴侣 — 单 HTML 零依赖、纵向信息流仪表盘、三主题 Web 控制面板

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white)
![WebSocket](https://img.shields.io/badge/WebSocket-010101?style=flat-square&logo=socket.io&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)

基于 [fmo-show](https://github.com/EthanYan6/fmo-show)（[@EthanYan6](https://github.com/EthanYan6)）和 [FmoDeck](https://github.com/wh0am1i/FmoDeck)（[@wh0am1i](https://github.com/wh0am1i)）的二次开发。

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
┌─────────────────────────────────────┐
│      Status Bar（KPI 卡片行）         │
├─────────────────────────────────────┤
│  Speaking Bar  │ 上个通联 + 服务器卡片 │
│  (.middle-split)                     │
├─────────────────────────────────────┤
│  最近发言       │  QSO 通联记录       │
│  (.bottom-panels)                    │
├─────────────────────────────────────┤
│  Footer: 51la统计 + GitHub/Envo链接  │
└─────────────────────────────────────┘
```

### 三路 WebSocket

| 连接 | 端点 | 协议 | 用途 |
|------|------|------|------|
| `/ws` | JSON-RPC | FmoDeck 串行队列 | 设备信息 / 服务器列表 / QSO 查询 |
| `/events` | Event Stream | 推送 | 讲话事件 / QSO 实时更新 |
| `/audio` | PCM 8kHz | 二进制流 | 对讲音频播放 + VU 电平 |

### 三主题

| 主题 | 风格 | 场景 |
|------|------|------|
| **Steel**（默认） | 工业风浅色，金属灰 + 雾蓝点缀 | 日常监控 |
| **CyberGuard** | 赛博青暗色，战术 HUD | 夜间 / 暗光环境 |
| **E-ink** | 高对比度黑白 | 墨水屏副屏 |

---

## 功能一览

### 顶部 Status Bar
- KPI 卡片行：CALL / UID / 天线 / 固件版本紧凑排列
- 连接状态指示 + 主题切换按钮

### 中段 .middle-split
- **左：Speaking Bar** — 实时发言者信息（呼号 / 方位角 / 距离 / Grid / 服务器 / 通联计时）
- **右纵列** — 上个通联卡片 + 服务器搜索卡片（弹窗搜索，拼音首字母/名称/UID 快速检索）

### 底部 .bottom-panels
- 最近发言（Recent Speakers）+ QSO 通联记录左右等宽分栏
- 呼号 / 网格（可点击地图）/ QTH / 留言 / 中继 / 时间六列统一布局
- QSO 留言/中继通过 `qso.getDetail` 全量补全

### 页脚
- 51la 访客统计 + GitHub / Envo 项目链接单行排列

### 音频收听

- VU 电平实时显示
- 迷你频谱：24 柱真实 FFT（1024 点 Hann 窗，200–3800Hz 对数分频）
- 静音按钮 + 音量调节滑块（AudioContext GainNode）

### 移动端适配

- 响应式布局，呼号 / 频谱 / 信息栏自动缩放

---

## 文件结构

```
fmo-secondary/
├── index.html        # 主页面
├── app.js            # 核心逻辑（WebSocket / 串行队列 / UI 渲染）
├── style.css         # 样式（三主题 + 响应式）
├── ARCHITECTURE.md   # 架构设计文档
├── PROTOCOL.md       # WebSocket 协议映射
├── UI_DESIGN.md      # UI/UX 设计规范
├── CHANGELOG.md      # 更新日志
└── README.md
```

---

## 参考项目

| 项目 | 说明 |
|------|------|
| [fmo-show](https://github.com/EthanYan6/fmo-show) | 墨水屏风格单行紧凑布局参考 |
| [FmoDeck](https://github.com/wh0am1i/FmoDeck) | 战术 HUD 主题，SpeakingBar + SSTV 解码 |
| [FmoLogs](https://github.com/dingle1122/FmoLogs) | 原始 FMO 日志平台 |
| [FMO 文档](https://bg5esn.com/categories/docs/) | 固件接口文档 |

---

## 致谢

本项目是基于 fmo-show（[@EthanYan6](https://github.com/EthanYan6)）和 FmoDeck（[@wh0am1i](https://github.com/wh0am1i)）的二次开发作品。原项目完整搭建了与 FMO 设备交互的协议实现、日志同步、APRS 等核心业务逻辑。本仓库在其基础上做界面与交互层的重写，所有底层能力均来自 fmo-show，特此鸣谢。

---

> 更新日志详见 [CHANGELOG.md](CHANGELOG.md)
