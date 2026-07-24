# 隐藏 server-ping "--" 占位符

**日期**: 2026-06-27
**版本**: v0.4.18

## 目标

server-ping 在延迟探测未完成时显示 `--`（如 `-- 192.168.1.13:80`），视觉不美观。改为无数据时隐藏该元素。

## 设计

| 状态 | 当前行为 | 改后行为 |
|------|---------|---------|
| 延迟已测量（23ms） | 显示 `23ms` | 不变 |
| 延迟超时 | 显示 `超时` | 不变 |
| 尚未测量 | 显示 `--` | `display: none` |

## 改动点

`app.js` `_showServerInfo()` 方法：

```js
// 当前
if (pingEl && this.hostPort) {
  const lat = this._serverLatency[this.hostPort];
  pingEl.textContent = lat === -1 ? '超时' : (lat !== undefined ? lat + 'ms' : '--');
}

// 改为
if (pingEl && this.hostPort) {
  const lat = this._serverLatency[this.hostPort];
  if (lat === undefined) {
    pingEl.style.display = 'none';
  } else {
    pingEl.style.display = '';
    pingEl.textContent = lat === -1 ? '超时' : lat + 'ms';
  }
}
```

## 影响范围

- 仅 `_showServerInfo()` 一处修改
- HTML/CSS 不变
- server-addr 不受影响
