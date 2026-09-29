// 随车端：按设备序号登记装箱/补冰/开箱/温控事件，断网存本机，恢复同步
const Vehicle = {
  async init() {
    const serial = document.getElementById('deviceSerial');
    serial.value = Sync.deviceSerial();
    serial.addEventListener('change', () => {
      localStorage.setItem('cc_device_serial', serial.value.trim());
    });

    document.getElementById('evType').addEventListener('change', () => this.renderFields());
    this.renderFields();

    document.getElementById('evSubmit').addEventListener('click', () => this.submit());
    await this.refreshOrders();
    await this.renderOutbox();
  },

  renderFields() {
    const type = document.getElementById('evType').value;
    const el = document.getElementById('evFields');
    const num = (id, label, ph) => `<div class="form-row"><label>${label}</label>
      <input id="${id}" type="number" step="any" placeholder="${ph}"></div>`;
    el.innerHTML = {
      pack: num('fQty', '装箱数量', '本箱样品数量'),
      ice: num('fIce', '补冰数量', '补充冰排数量'),
      unbox: num('fHandover', '交接数量', '实际交接样品数量'),
      temp: num('fTemp', '温度(℃)', '实测箱内温度') +
        `<div class="form-row"><label>备注</label><input id="fNote" placeholder="异常情况说明"></div>`,
    }[type];
  },

  async refreshOrders() {
    const state = await IDB.cacheGet('state');
    const list = document.getElementById('orderList');
    if (state) {
      list.innerHTML = state.orders
        .map((o) => `<option value="${o.order_no}">${UI.escape(o.route || '')}</option>`).join('');
    }
  },

  async submit() {
    const orderNo = document.getElementById('evOrder').value.trim();
    const boxNo = document.getElementById('evBox').value.trim();
    const type = document.getElementById('evType').value;
    if (!orderNo || !boxNo) {
      UI.toast('请填写转运单号和箱号', true);
      return;
    }
    const serial = Sync.deviceSerial();
    if (!serial) {
      UI.toast('请先填写设备序号', true);
      return;
    }

    const fields = {};
    const add = (field, value) => {
      if (value === '' || value == null) return;
      fields[field] = { value: Number(value), version: Sync.nextFieldVersion(boxNo, field) };
    };
    add('device_serial', serial);
    if (type === 'pack') {
      fields.status = { value: 'packed', version: Sync.nextFieldVersion(boxNo, 'status') };
      add('qty', document.getElementById('fQty').value);
    } else if (type === 'ice') {
      add('ice_qty', document.getElementById('fIce').value);
    } else if (type === 'unbox') {
      fields.status = { value: 'opened', version: Sync.nextFieldVersion(boxNo, 'status') };
      add('handover_qty', document.getElementById('fHandover').value);
    } else if (type === 'temp') {
      add('temp', document.getElementById('fTemp').value);
      const note = document.getElementById('fNote').value.trim();
      if (note) fields.note = { value: note, version: Sync.nextFieldVersion(boxNo, 'note') };
    }

    const rec = {
      event_id: crypto.randomUUID(),
      order_no: orderNo,
      box_no: boxNo,
      type,
      fields,
      occurred_at: Date.now(),
      status: 'pending',
      reason: null,
      anomaly_id: null,
      created_at: Date.now(),
    };
    await IDB.outboxAdd(rec);
    UI.toast('已登记到本机，等待同步');
    document.getElementById('evBox').value = '';
    await this.renderOutbox();

    // 在线则立即同步；离线则保留在 outbox，恢复后自动同步
    if (navigator.onLine) {
      const r = await Sync.syncNow();
      if (r.error) UI.toast('同步失败，记录已保留本机：' + r.error, true);
      await this.renderOutbox();
      await Dispatch.render();
      await UI.refreshAnomalyBadge();
    }
  },

  async renderOutbox() {
    const all = await IDB.outboxAll();
    const el = document.getElementById('outboxList');
    document.getElementById('outboxCount').textContent =
      all.filter((r) => ['pending', 'failed'].includes(r.status)).length;
    if (!all.length) {
      el.innerHTML = '<p class="muted">暂无记录</p>';
      return;
    }
    const typeLabel = { pack: '装箱', ice: '补冰', unbox: '开箱交接', temp: '温控异常' };
    el.innerHTML = all.map((r) => `
      <div class="outbox-item ${r.status}">
        <div>
          <div><strong>${UI.escape(r.box_no)}</strong> · ${UI.escape(r.order_no)} · ${typeLabel[r.type] || r.type}</div>
          <div class="outbox-meta">${UI.fmtTime(r.occurred_at)} · ${UI.escape(Sync.deviceSerial())}</div>
          ${r.reason ? `<div class="outbox-reason ${r.status === 'failed' ? 'tag danger' : 'muted'}">${UI.escape(r.reason)}</div>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          ${UI.typeTag(r.status)}
          ${r.status === 'failed' ? '<button class="btn small" data-retry="' + r.event_id + '">重试</button>' : ''}
          ${['pending', 'failed'].includes(r.status)
            ? '<button class="btn small danger" data-discard="' + r.event_id + '">丢弃</button>' : ''}
        </div>
      </div>`).join('');

    el.querySelectorAll('[data-retry]').forEach((b) => {
      b.addEventListener('click', async () => {
        const rec = all.find((r) => r.event_id === b.dataset.retry);
        rec.status = 'pending';
        await IDB.outboxUpdate(rec);
        const r = await Sync.syncNow();
        if (r.error) UI.toast('同步失败：' + r.error, true);
        await this.renderOutbox();
        await Dispatch.render();
        await UI.refreshAnomalyBadge();
      });
    });
    el.querySelectorAll('[data-discard]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('确定丢弃这条本地记录？丢弃后无法恢复（建议先重试同步）。')) return;
        await IDB.outboxDelete(b.dataset.discard);
        await this.renderOutbox();
      });
    });
  },
};
