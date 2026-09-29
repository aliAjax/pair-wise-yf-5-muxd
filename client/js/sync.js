// 同步引擎：断网时事件只进本地 outbox；恢复后按批上报，
// 服务端按 转运单+箱号+字段版本 合并；失败记录本地保留，重试幂等不重复占用容量
const Sync = {
  syncing: false,

  deviceSerial() {
    return localStorage.getItem('cc_device_serial') || '';
  },

  async syncNow() {
    if (this.syncing) return { sent: 0 };
    const pending = (await IDB.outboxAll()).filter((r) =>
      ['pending', 'failed'].includes(r.status));
    if (!pending.length) return { sent: 0 };
    this.syncing = true;
    UI.setSyncState('syncing');
    try {
      const resp = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_serial: this.deviceSerial(),
          events: pending.map((r) => ({
            event_id: r.event_id,
            order_no: r.order_no,
            box_no: r.box_no,
            type: r.type,
            occurred_at: r.occurred_at,
            fields: r.fields,
          })),
        }),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const { results } = await resp.json();
      const byId = Object.fromEntries(results.map((r) => [r.event_id, r]));
      for (const rec of pending) {
        const r = byId[rec.event_id];
        if (!r) continue;
        if (r.status === 'applied') {
          rec.status = 'synced';
          rec.reason = null;
        } else if (r.status === 'conflict') {
          // 已应用但有两版待核异常：不再重发，异常在调度端核处
          rec.status = 'conflict';
          rec.reason = r.reason;
          rec.anomaly_id = r.anomaly_id;
        } else if (r.status === 'isolated') {
          // 箱组已被服务端隔离保留：不重发（重试幂等，不会二次占用容量）
          rec.status = 'isolated';
          rec.reason = r.reason;
          rec.anomaly_id = r.anomaly_id;
        } else if (r.status === 'rejected') {
          // 本地记录保留，可修改后重试（服务端对 rejected 重跑，无副作用）
          rec.status = 'failed';
          rec.reason = r.reason;
        }
        await IDB.outboxUpdate(rec);
      }
      await this.refreshCache();
      UI.setSyncState(navigator.onLine ? 'online' : 'offline');
      return { sent: pending.length, results };
    } catch (err) {
      // 网络失败：本地记录一条不丢，保持 pending 待下次重试
      UI.setSyncState('offline');
      return { sent: 0, error: err.message };
    } finally {
      this.syncing = false;
    }
  },

  async refreshCache() {
    try {
      const resp = await fetch('/api/state');
      if (resp.ok) {
        const state = await resp.json();
        await IDB.cacheSet('state', state);
        return state;
      }
    } catch { /* 离线：用缓存 */ }
    return IDB.cacheGet('state');
  },

  // 字段版本号：同箱同字段每次登记递增，保证离线多次编辑后版本单调
  nextFieldVersion(boxNo, field) {
    const key = `cc_v_${boxNo}_${field}`;
    const v = parseInt(localStorage.getItem(key) || '0', 10) + 1;
    localStorage.setItem(key, String(v));
    return v;
  },
};
