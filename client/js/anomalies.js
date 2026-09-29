// 异常核处：两版记录对照，采纳随车/调度版本，或解除隔离
const Anomalies = {
  async render() {
    const state = await Sync.refreshCache();
    const el = document.getElementById('anomalyContent');
    if (!state) {
      el.innerHTML = '<p class="muted">暂无数据</p>';
      return;
    }
    const pending = state.anomalies.filter((a) => a.status === 'pending');
    const resolved = state.anomalies.filter((a) => a.status !== 'pending');

    const card = (a) => {
      const dv = a.dispatch_version ? `<pre>${UI.escape(JSON.stringify(JSON.parse(a.dispatch_version), null, 2))}</pre>` : '<p class="muted">无</p>';
      const vv = a.vehicle_version ? `<pre>${UI.escape(JSON.stringify(JSON.parse(a.vehicle_version), null, 2))}</pre>` : '<p class="muted">无</p>';
      const actions = this.actionsFor(a);
      return `
      <div class="card anomaly ${a.severity === 'critical' ? '' : 'warning'} ${a.type === 'temp' ? 'temp' : ''}">
        <div class="anomaly-head">
          <div>
            <span class="tag ${a.severity === 'critical' ? 'danger' : a.type === 'temp' ? 'info' : 'warn'}">${UI.escape(UI.anomalyTypeLabel(a.type))}</span>
            <strong style="margin-left:8px;">${UI.escape(a.title)}</strong>
          </div>
          <span class="muted">${UI.fmtTime(a.created_at)}</span>
        </div>
        <div class="muted" style="margin:6px 0;">
          转运单 ${UI.escape(a.order_no || '—')} · 箱号 ${UI.escape(a.box_no || '—')}
          ${a.blocking_order_no ? ` · 最早阻塞转运单：<strong>${UI.escape(a.blocking_order_no)}</strong>` : ''}
        </div>
        <div class="versions">
          <div class="version-box dispatch"><h4>调度版本（已确认）</h4>${dv}</div>
          <div class="version-box vehicle"><h4>随车版本（现场上报）</h4>${vv}</div>
        </div>
        <div class="anomaly-actions">${actions}</div>
      </div>`;
    };

    el.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="num">${pending.length}</div><div class="lbl">待核异常</div></div>
        <div class="stat"><div class="num">${resolved.length}</div><div class="lbl">已处理</div></div>
      </div>
      ${pending.length ? pending.map(card).join('') : '<div class="card"><p class="muted">暂无待核异常 ✓</p></div>'}
      ${resolved.length ? `<h3 class="muted" style="margin:16px 4px 8px;">已处理记录</h3>${resolved.map(card).join('')}` : ''}
    `;

    el.querySelectorAll('[data-resolve]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.dataset.id;
        const resolution = b.dataset.resolve;
        try {
          const resp = await fetch(`/api/anomalies/${id}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolution }),
          });
          const r = await resp.json();
          if (!resp.ok) throw new Error(r.error || '操作失败');
          UI.toast('已处理');
          await this.render();
          await Dispatch.render();
          await UI.refreshAnomalyBadge();
        } catch (err) {
          UI.toast(err.message, true);
        }
      });
    });
  },

  actionsFor(a) {
    const btn = (label, resolution, cls = '') =>
      `<button class="btn small ${cls}" data-resolve="${resolution}" data-id="${a.anomaly_id}">${label}</button>`;
    if (a.type === 'box_mismatch') {
      return btn('采纳随车版本（按现场箱号改派）', 'accept_vehicle')
        + btn('采纳调度版本（维持原单）', 'accept_dispatch')
        + btn('标记核实', 'dismiss');
    }
    if (a.type === 'qty_mismatch') {
      return btn('采纳随车数量（按现场交接数）', 'accept_vehicle')
        + btn('采纳调度数量（按转运单）', 'accept_dispatch')
        + btn('标记核实', 'dismiss');
    }
    if (a.type === 'field_conflict') {
      return btn('采纳随车版本', 'accept_vehicle')
        + btn('采纳调度版本', 'accept_dispatch')
        + btn('标记核实', 'dismiss');
    }
    if (a.type === 'capacity' || a.type === 'appointment') {
      return btn('解除隔离（重新校验容量）', 'release', 'primary')
        + btn('保持隔离', 'dismiss');
    }
    // temp
    return btn('标记已核实', 'dismiss');
  },
};
