/*
 * FMO_Mate 零依赖回归测试
 * ------------------------------------------------------------
 * 只依赖 Node 内置能力，不装任何包。运行：node test.js
 * 覆盖从 app.js 抽取到 core.js 的纯函数（这些正是 CHANGELOG 里反复出 bug 的地方）。
 */
var C = require('./core.js');

var pass = 0, fail = 0;

function show(actual) {
  try { return JSON.stringify(actual); } catch (e) { return String(actual); }
}

function eq(actual, expected, name) {
  var a = show(actual), e = show(expected);
  if (a === e) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + '  expected ' + e + ' got ' + a); }
}

function ok(cond, name) { eq(!!cond, true, name); }

console.log('\n[matchResponse]');
// 1. 严格匹配：type 相同 + 去掉 Response 后缀后的 subType 相同
ok(C.matchResponse(
  { type: 'user', subType: 'getInfoResponse', code: 0 },
  { type: 'user', subType: 'getInfo' }),
  'user.getInfo 严格匹配');

// 2. station 别名：响应 getListResponse -> 请求 getListRange
ok(C.matchResponse(
  { type: 'station', subType: 'getListResponse' },
  { type: 'station', subType: 'getListRange' }),
  'station getListResponse -> getListRange 别名');

// 3. V2 兜底：event:"ok" 且带 data
ok(C.matchResponse(
  { type: 'config', subType: 'getCordinate', event: 'ok', data: {} },
  { type: 'config', subType: 'getCordinate' }),
  'event:ok + data 兜底匹配');

// 4. 通用 Response 后缀剥离
ok(C.matchResponse(
  { type: 'qso', subType: 'getTodayCountResponse' },
  { type: 'qso', subType: 'getTodayCount' }),
  '通用 Response 后缀剥离');

// 5. 不匹配：type 错误
eq(C.matchResponse(
  { type: 'qso', subType: 'getListResponse' },
  { type: 'station', subType: 'getListRange' }),
  false, 'type 错误时不匹配');

// 6. event:ok 但 subType 不匹配且无 data -> 不应误匹配
eq(C.matchResponse(
  { type: 'config', subType: 'other', event: 'ok' },
  { type: 'config', subType: 'getCordinate' }),
  false, 'event:ok 且无 data 且 subType 不匹配 -> 不误匹配');

// 7. 空消息安全
eq(C.matchResponse(null, { type: 'x', subType: 'y' }), false, 'null 消息安全');

console.log('\n[latLonToGrid]');
eq(C.latLonToGrid(0, 0), 'JJ00aa', '(0,0) -> JJ00aa');
eq(C.latLonToGrid(39.9042, 116.4074).slice(0, 4), 'OM89', '北京 场+方格 = OM89');
eq(C.latLonToGrid(-33.8688, 151.2093).slice(0, 4), 'QF56', '悉尼 场+方格 = QF56');

console.log('\n[gridToLatLon 往返]');
['JJ00aa', 'OM89ev', 'PM01rf', 'FN31pr', 'EM73ct', 'QF56aa'].forEach(function (g) {
  var ll = C.gridToLatLon(g);
  eq(C.latLonToGrid(ll.lat, ll.lon), g, '往返 ' + g);
});

console.log('\n[dbg 调试开关]');
var logged = false;
var origLog = console.log;
console.log = function () { logged = true; };

C.dbg('[FMO-DEBUG]', '默认不应打印');
eq(logged, false, 'DEBUG 关闭时静默');

C.setDebug(true);
C.dbg('[FMO-DEBUG]', 'hello');
console.log = origLog;
eq(logged, true, 'DEBUG 开启时打印');

console.log('\n========================================');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('========================================\n');
process.exit(fail ? 1 : 0);
