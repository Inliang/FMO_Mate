/*
 * FMO_Mate 共享核心（core.js）
 * ------------------------------------------------------------
 * 从 app.js 抽取出的「纯函数 + 调试开关」，单文件、零依赖、零构建。
 *
 * 双环境支持（UMD 风格）：
 *   - 浏览器：以经典 <script> 引入（兼容 file:// 双击打开），挂到 window.FMOCore
 *   - Node：   require('./core.js')，供 test.js 做零依赖回归测试
 *
 * 设计约束（来自项目定位「单 HTML 零依赖、双击即用」）：
 *   - 不能用 ES Module（file:// 下不加载），所以用经典脚本 + UMD 守卫。
 *   - 不引入任何 npm 包，测试也只用 Node 内置断言。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FMOCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ============================================================
  // 调试总开关
  // ============================================================
  // 默认关闭。浏览器侧在 init() 里根据 URL ?debug 或 localStorage fmo-debug=1 调用 setDebug(true)。
  // Node 测试里默认关闭，避免噪音；测试会主动 setDebug(true) 验证开关有效。
  var DEBUG = false;

  function setDebug(v) { DEBUG = !!v; }
  function isDebug() { return DEBUG; }

  // 通用调试水槽：开启时原样转发所有参数给 console.log，关闭时静默。
  // 调用方约定：第一个参数通常是 '[FMO-DEBUG-xxx]' 之类的标签。
  function dbg() {
    if (!DEBUG) return;
    // eslint-disable-next-line no-console
    console.log.apply(console, arguments);
  }

  // ============================================================
  // 响应匹配（从 app.js handleWsMessage 抽取，CHANGELOG 里反复修过的 bug 源）
  // ============================================================
  // 协议：请求 {type, subType} -> 响应 subType 通常为 '<subType>Response'。
  // 已知别名（见 PROTOCOL.md）：station.getListRange 的响应 subType 实为 'getListResponse'，
  // 即响应里去掉 Response 后缀后变成 'getList'，需映射回请求的 'getListRange'。
  // V2 协议补充：响应可能带 event:"ok" 且含 data，此时仅靠 type 匹配（排除纯心跳）。
  var RESPONSE_ALIASES = {
    station: { getListRange: 'getListResponse' }
  };

  function matchResponse(msg, req) {
    if (!msg || !req) return false;

    var respSubType = (msg.subType || '').replace('Response', '');
    var effectiveSubType = respSubType;

    // station 别名：响应 getListResponse -> 请求 getListRange
    if (req.type === 'station' && effectiveSubType === 'getList') {
      effectiveSubType = 'getListRange';
    }

    // 严格匹配：type 相同 + 规格化后的 subType 相同
    if (msg.type === req.type && effectiveSubType === req.subType) return true;

    // V2 兜底：event:"ok" 且带 data，按 type 匹配（排除纯心跳事件）
    if (msg.event === 'ok' && msg.type === req.type && msg.data !== undefined) return true;

    return false;
  }

  // ============================================================
  // 梅登海德网格（Maidenhead）换算
  // ============================================================
  // latLonToGrid 原样照搬 app.js 既有实现，确保行为零偏差；gridToLatLon 为其逆运算（取网格中心），用于测试往返。
  var FIELD = 'ABCDEFGHIJKLMNOPQR'; // 18 个场（经度 20° / 纬度 10°）
  var SUB = 'abcdefghijklmnopqrstuvwx'; // 24 个子网格（经度 5' / 纬度 2.5'，标准 Maidenhead 用 a–x）

  function latLonToGrid(lat, lon) {
    lat = +lat; lon = +lon;
    var L = lon + 180, La = lat + 90;
    var fl = Math.floor(L / 20), fL = Math.floor(La / 10);
    var sl = Math.floor((L % 20) / 2), sL = Math.floor(La % 10);
    var ssLon = Math.floor((L % 2) * 12), ssLat = Math.floor((La % 1) * 24);
    return String.fromCharCode(65 + fl) + String.fromCharCode(65 + fL) +
           String(sl) + String(sL) +
           String.fromCharCode(97 + ssLon) + String.fromCharCode(97 + ssLat);
  }

  function gridToLatLon(grid) {
    grid = (grid || '').toUpperCase().replace(/\s+/g, '');
    if (grid.length < 4) return null;
    var fl = FIELD.indexOf(grid[0]), fL = FIELD.indexOf(grid[1]);
    if (fl < 0 || fL < 0) return null;
    var sl = parseInt(grid[2], 10), sL = parseInt(grid[3], 10);
    if (isNaN(sl) || isNaN(sL)) return null;

    var ssLon = -1, ssLat = -1;
    if (grid.length >= 6) {
      ssLon = SUB.indexOf(grid[4].toLowerCase());
      ssLat = SUB.indexOf(grid[5].toLowerCase());
    }

    // 取单元格中心；4 位网格无子网格时取方格中心
    var lon = fl * 20 - 180 + sl * 2 + (ssLon >= 0 ? (ssLon + 0.5) / 12 : 1);
    var lat = fL * 10 - 90 + sL * 1 + (ssLat >= 0 ? (ssLat + 0.5) / 24 : 0.5);
    return { lat: lat, lon: lon };
  }

  return {
    setDebug: setDebug,
    isDebug: isDebug,
    dbg: dbg,
    RESPONSE_ALIASES: RESPONSE_ALIASES,
    matchResponse: matchResponse,
    latLonToGrid: latLonToGrid,
    gridToLatLon: gridToLatLon
  };
});
