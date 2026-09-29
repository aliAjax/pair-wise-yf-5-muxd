// 共享 UI 工具
const UI = {
  escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },

  fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },

  toast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(this._tt);
    this._tt = setTimeout(() => t.classList.add('hidden'), 3500);
  },

  setSyncState(state) {
    const badge = document.getElementById('netBadge');
    const syncBtn = document.getElementById('syncBtn');
    badge.className = 'net-badge ' + state;
    badge.textContent = state === 'online' ? '在线' : state === 'syncing' ? '同步中…' : '离线';
    syncBtn.disabled = state === 'syncing';
    document.getElementById('offlineBanner').classList.toggle('hidden', state !== 'offline');
  },

  async refreshAnomalyBadge() {
    const state = await Sync.refreshCache();
    const n = state ? state.anomalies.filter((a) => a.status === 'pending').length : 0;
    const el = document.getElementById('anomalyBadge');
    el.textContent = n;
    el.dataset.zero = n === 0 ? 'true' : 'false';
    return state;
  },

  typeTag(type) {
    const map = {
      applied: ['ok', '已合并'], synced: ['ok', '已同步'], conflict: ['warn', '待核冲突'],
      isolated: ['isolated', '已隔离'], failed: ['danger', '失败待重试'],
      pending: ['info', '待同步'], rejected: ['danger', '已拒绝'],
      open: ['info', '运输中'], packed: ['info', '已装箱'], opened: ['ok', '已开箱'],
    };
    const [cls, label] = map[type] || ['info', type];
    return `<span class="tag ${cls}">${label}</span>`;
  },

  anomalyTypeLabel(type) {
    return ({
      box_mismatch: '箱号不一致', qty_mismatch: '交接数量不一致',
      field_conflict: '字段版本冲突', capacity: '车辆容量不足',
      appointment: '实验室预约已满', temp: '温控异常',
    })[type] || type;
  },
};
