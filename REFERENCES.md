# FMO 生态参考项目清单

> 开发 FMO Mate 过程中参考、对照、借鉴过的全部项目、工具与服务。
>
> 来源：社区维护的 [FMO 工具导航](https://fmo.net.cn/)、[BG5ESN 官方文档站](https://bg5esn.com/docs/)，以及各项目的 GitHub 仓库。
>
> 最近更新：2026-10-15

---

## 一、直接上游（本项目基于其二次开发）

| 项目 | 作者 | 说明 | 我们从它拿走了什么 |
|------|------|------|------|
| [fmo-show](https://github.com/EthanYan6/fmo-show) | EthanYan6 | 墨水屏风格网页端，紧凑单行布局 | **协议逆向的主要来源**；紧凑信息密度布局思路 |
| [FmoDeck](https://github.com/wh0am1i/FmoDeck) | wh0am1i（BH6SCA） | 战术 HUD 主题，SpeakingBar + SSTV 解码 | JSON-RPC 串行队列实现；Speaking Bar 卡设计；霓虹绿 HUD 风格 |

---

## 二、同生态网页端（功能对照与灵感来源）

| 项目 | 作者 | 说明 | 对照价值 |
|------|------|------|------|
| [FMO-Dashboard](https://github.com/54dashayu/FMO-Dashboard) | 54dashayu（BH1JSS）★17 | Vue3 + Tauri，实时仪表盘 + 日志 + 语音播报 | **功能最全**，我们的功能缺口清单主要对照它 |
| [FmoLogs](https://github.com/dingle1122/FmoLogs) | dingle1122（BH5HSJ）★13 | 日志管理 + APRS 远控，支持多端 APP | `/api/qso/backup` 端点来源；日志持久化方案 |
| [fmo-mobile-controller](https://github.com/niufox/fmo-mobile-controller) | niufox ★13 | 移动端控制器 | **`API_DOCUMENTATION_v2.md` — 官方 API v2 最完整文档** |
| [FMO 魔方](https://fmo.feel101.com/) | BI2RHY | PC 仪表盘 / 大字版 / 手机版 / 小爱音箱版 / 24h 值守屏 / APRS 地图 | 多终端形态参考；`grid.lzyike.cn` 服务来源 |
| [FMOC](http://fmo.bg5eit.cn/) | BG5EIT | 网页控制端（非 HTTPS） | 控制交互参考 |
| [FMO Console](https://map.fmoconsole.cn/) | — | 实时台站与通联状态面板，支持台站搜索、集群状态，含 iOS App | 面板信息组织参考 |
| [FMO 设备信息统计](https://fmo.panyong.top/fmo-statistics) | BI1THT | 统计全网 FMO 设备，可按 CA 分组，展示 uid / 持有者 / 历史持有者 / 采集时间 | 设备维度信息展示参考 |

---

## 三、官方开源工具集（[BG5ESN](https://github.com/BG5ESN)）

| 工具 | 说明 | 对应我们待办 |
|------|------|-------------|
| [FMO-APRS-Remote-Control-Tool](https://github.com/BG5ESN/FMO-APRS-Remote-Control-Tool) | 通过 APRS-IS 消息遥控 FMO 进入待机 | 参考思路 |
| [FMO-Andorid-GPS-Tool](https://github.com/BG5ESN/FMO-Andorid-GPS-Tool) | 用手机 GPS 实时设置 FMO 位置 | **H4**：网页端用 `navigator.geolocation` + `config.setCordinate` |
| [fmo-log-sign-verify-tool](https://github.com/BG5ESN/fmo-log-sign-verify-tool) | FMO 日志 **Ed25519** 数字签名验证（固件 v2.2.19 起） | **H5**：高难度待定 |
| [FMO-sqlite-2-adif](https://github.com/BG5ESN/FMO-sqlite-2-adif) | `.db` 日志转 ADIF | **H6**：与 C3/C4 合并（需 sql.js） |
| [fmo-blacklist-users](https://github.com/BG5ESN/fmo-blacklist-users) | 公开黑名单数据 | **H7**：可选，隐私与误伤需谨慎 |

---

## 四、地图 / 查询 / 数据服务

| 服务 | 地址 | 用途 |
|------|------|------|
| FMO APRS 实时地图 | [map.fmo.net.cn](https://map.fmo.net.cn/) · [map.srv.ink](https://map.srv.ink/)（BG9JYT） | 实时抓取 APRS 节点位置与状态 |
| FMO Tracker | [map.bg5esn.com](https://map.bg5esn.com/)（官方） | 全国 FMO 分布 + 范围显示 + 猎狐 |
| FMO APRS 地图（魔方） | [aprsmap.feel101.com](https://aprsmap.feel101.com/) | 设备实时分布 + 通联事件流 |
| Maidenhead Map | [maidenmap.wh0am1i.com](https://maidenmap.wh0am1i.com/) | 梅登海德网格可视化 |
| 网格 → 行政区划 | [grid.lzyike.cn](https://grid.lzyike.cn/api/grid2addr/) | **免 Key**，当前 Tier 0 地理编码服务 |
| 逆地理编码（备） | 高德 · Nominatim | Tier 1 / Tier 2 兜底 |
| 呼号查询 | [qrz.com](https://www.qrz.com/db/) | 点击呼号跳转 |
| 台网点名 | [fmo.bh1jss.net/checkin](http://fmo.bh1jss.net/checkin/)（BH1JSS） | **H3**：待加外链 |
| V4 活动公告接收站 | [events.bi8spf.cn](https://events.bi8spf.cn/)（BI8SRC） | 常驻监听节点，公告保留 7 天 |

---

## 五、集群 / 服务器管理

| 站点 | 地址 |
|------|------|
| 西南集群在线网站 | [makepc.cn](http://www.makepc.cn/index.php) |
| 洛凯集群探针 | [a.tylk.cc](https://a.tylk.cc/)（BG6HFD） |
| 彩云之南集群监控面板 | [status.bi8spf.cn](https://status.bi8spf.cn/) |
| 彩云之南集群台网活动信息聚合 | [bh6sva.top/net](http://bh6sva.top/net/) |

---

## 六、硬件 / 结构件

| 项目 | 作者 | 说明 |
|------|------|------|
| [FMO 开源背板 V2.00](https://github.com/vchenys/FMO-Radio-Module-BK4802-V2.00) | vchenys | PY32F030x8 + BK4802 收发芯片，AT 指令控制，MIT 协议 |
| [FMO-Radio-Module-BK4802-V2.00](https://github.com/xd785/FMO-Radio-Module-BK4802-V2.00) | xd785 | 同上（另一镜像） |
| FMO 音频转接板（三合一背板） | BI8SIG, Bi8SPD | 6P 电台接口 + K 口手咪 + 音频输入切换 + 双向音量调节 |
| FMO 伴侣及 FMO 网关 | BI8SIG, Bi8SPD | ESP32 仪表盘伴侣终端 + WebSocket 数据中转（硬件 / Docker） |
| FMO 伴侣屏 M5CORE 固件 | BH1JSS | 面向 M5Core 一代的独立信息伴侣屏 |
| 狐狸叔叔的 FMO 竖版伴侣 | BH4FOX | ESP32 兼容硬件竖版伴侣，提供固件 |
| FMO PAB 供电音频背板 | BI4KQN | 手咪 / 喇叭接口 + 锂电充放电 + 排针扩展 |
| FMO 军旅风格外壳 | BH4XIX | 延续 CWO 外壳风格 |

---

## 七、文档与教程

| 资源 | 地址 | 说明 |
|------|------|------|
| FMO 作者官方网站 | [bg5esn.com/docs](https://bg5esn.com/docs/) | 使用说明书 · 更新说明 · 开源资源清单 · 实践分享 |
| FMO 使用说明书 | [bg5esn.com/docs/fmo-usage](http://bg5esn.com/docs/fmo-usage) | 新手向，含配网 / 远控 / 过滤器等说明 |
| FMO 产品指南 | [bg5esn.com/docs/fmo-product-guide](http://bg5esn.com/docs/fmo-product-guide) | 产品定位与 4.0 设计模型 |
| FMO 教程合集 | [tylk.cc/fmo](https://tylk.cc/fmo) | 洛凯 BG6HFD 整理的配置 / 进阶技巧 |
| 官方 API v2 文档 | [fmo-mobile-controller/API_DOCUMENTATION_v2.md](https://github.com/niufox/fmo-mobile-controller/blob/main/API_DOCUMENTATION_v2.md) | `config.*` / `station.*` / `qso.*` / `wifi.*` 完整命名空间 |

---

## 八、设计参考

| 资源 | 地址 | 用途 |
|------|------|------|
| UI UX Pro Max | [ui-ux-pro-max-skill](https://ui-ux-pro-max-skill.nextlevelbuilder.io/) | 界面风格与交互规范 |
| awesome-design-md | [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) | 设计规范速查 |
| Dribbble | [dribbble.com](https://dribbble.com/) | 视觉灵感 |
| React Bits | [reactbits.dev](https://reactbits.dev/) | 组件动效参考 |

---

> 缺口分析与实施顺序见 [FEATURES_GAP.md](FEATURES_GAP.md)；版本历史见 [CHANGELOG.md](CHANGELOG.md)
