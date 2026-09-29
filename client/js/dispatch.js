// 调度端：维护车辆容量、实验室预约、转运单；查看箱组与占用
const Dispatch = {
  async render() {
    const state = await Sync.refreshCache();
    const el = document.getElementById('dispatchContent');
    if (!state) {
      el.innerHTML = '<p class="muted">暂无数据，请点击「载入演示数据」或在下方录入基础数据。</p>';
      return;
    }
    const boxCount = (pred) => state.boxes.filter((b) => !b.isolated && pred(b)).length;
    const orderBoxes = (ono) => state.boxes.filter((b) => b.order_no === ono);

    const stats = `
      <div class="stats">
        <div class="stat"><div class="num">${state.orders.length}</div><div class="lbl">转运单</div></div>
        <div class="stat"><div class="num">${state.boxes.length}</div><div class="lbl">箱组总数</div></div>
        <div class="stat"><div class="num">${boxCount(() => true)}</div><div class="lbl">在计箱组</div></div>
        <div class="stat"><div class="num">${state.boxes.filter((b) => b.isolated).length}</div><div class="lbl">隔离箱组</div></div>
        <div class="stat"><div class="num">${state.anomalies.filter((a) => a.status === 'pending').length}</div><div class="lbl">待核异常</div></div>
      </div>`;

    const vehicles = `
      <div class="card">
        <h2>车辆与容量</h2>
        <table>
          <thead><tr><th>车牌</th><th>容量(箱)</th><th>已占用</th><th>利用率</th></tr></thead>
          <tbody>
            ${state.vehicles.map((v) => {
              const used = boxCount((b) => state.orders.some((o) => o.order_no === b.order_no && o.vehicle_id === v.vehicle_id));
              const pct = v.capacity ? Math.min(100, Math.round((used / v.capacity) * 100)) : 0;
              return `<tr>
                <td>${UI.escape(v.plate)} <span class="muted">${UI.escape(v.vehicle_id)}</span></td>
                <td>${v.capacity}</td>
                <td>${used}</td>
                <td><span class="progress"><span class="${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></span></span>${used}/${v.capacity}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="4" class="muted">暂无车辆</td></tr>'}
          </tbody>
        </table>
        <form class="inline-form" data-api="/api/vehicles" data-reset>
          <div class="form-row">
            <input name="vehicle_id" placeholder="车辆编号 如 V3" required>
            <input name="plate" placeholder="车牌 如 沪A·冷链03" required>
            <input name="capacity" type="number" min="1" placeholder="容量(箱)" required>
            <button class="btn small">新增车辆</button>
          </div>
        </form>
      </div>`;

    const appointments = `
      <div class="card">
        <h2>实验室预约</h2>
        <table>
          <thead><tr><th>预约号</th><th>实验室</th><th>时段</th><th>容量(箱)</th><th>已占用</th><th>利用率</th></tr></thead>
          <tbody>
            ${state.appointments.map((a) => {
              const used = boxCount((b) => state.orders.some((o) => o.order_no === b.order_no && o.appointment_id === a.appointment_id));
              const pct = a.capacity ? Math.min(100, Math.round((used / a.capacity) * 100)) : 0;
              return `<tr>
                <td>${UI.escape(a.appointment_id)}</td>
                <td>${UI.escape(a.lab_name)}</td>
                <td>${UI.escape(a.slot)}</td>
                <td>${a.capacity}</td>
                <td>${used}</td>
                <td><span class="progress"><span class="${pct >= 100 ? 'full' : ''}" style="width:${pct}%"></span></span>${used}/${a.capacity}</td>
              </tr>`;
            }).join('') || '<tr><td colspan="6" class="muted">暂无预约</td></tr>'}
          </tbody>
        </table>
        <form class="inline-form" data-api="/api/appointments" data-reset>
          <div class="form-row">
            <input name="appointment_id" placeholder="预约号 如 AP3" required>
            <select name="lab_id" required>
              <option value="">选择实验室</option>
              ${state.labs.map((l) => `<option value="${l.lab_id}">${UI.escape(l.name)}</option>`).join('')}
            </select>
            <input name="slot" placeholder="时段 如 09-30 上午" required>
            <input name="capacity" type="number" min="1" placeholder="容量" required>
            <button class="btn small">新增预约</button>
          </div>
        </form>
        <form class="inline-form" data-api="/api/labs" data-reset>
          <div class="form-row">
            <input name="lab_id" placeholder="实验室编号 如 L2" required>
            <input name="name" placeholder="实验室名称" required>
            <button class="btn small">新增实验室</button>
          </div>
        </form>
      </div>`;

    const orders = `
      <div class="card">
        <h2>转运单</h2>
        ${state.orders.map((o) => {
          const boxes = orderBoxes(o.order_no);
          return `<div style="margin-bottom:14px;border:1px solid var(--line);border-radius:8px;padding:10px 12px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
              <strong>${UI.escape(o.order_no)}</strong>
              <span class="muted">${UI.escape(o.route || '')} · ${UI.escape(o.vehicle_id || '未配车')} · ${UI.escape(o.appointment_id || '未预约')}</span>
              <span>${UI.typeTag(o.status)}</span>
            </div>
            <div class="muted" style="margin:4px 0;">计划数量 ${o.planned_qty ?? '—'} · 计划箱数 ${o.planned_boxes ?? '—'} · 建单 ${UI.fmtTime(o.created_at)}</div>
            <table>
              <thead><tr><th>箱号</th><th>设备</th><th>状态</th><th>装箱数</th><th>交接数</th><th>补冰</th><th>温度</th><th>交接次数</th><th>备注</th></tr></thead>
              <tbody>
                ${boxes.map((b) => `<tr>
                  <td>${UI.escape(b.box_no)}</td>
                  <td>${UI.escape(b.device_serial || '—')}</td>
                  <td>${UI.typeTag(b.status)} ${b.isolated ? '<span class="tag isolated">已隔离</span>' : ''}</td>
                  <td>${b.qty ?? '—'}</td>
                  <td>${b.handover_qty ?? '—'}</td>
                  <td>${b.ice_qty ?? '—'}</td>
                  <td>${b.temp != null ? b.temp + '℃' : '—'}</td>
                  <td>${b.handover_count}</td>
                  <td class="muted">${b.isolated ? '容量/预约不足，箱组隔离不计入占用，最后确认结果已保留' : ''}</td>
                </tr>`).join('') || '<tr><td colspan="9" class="muted">暂无箱组（随车端同步后显示）</td></tr>'}
              </tbody>
            </table>
          </div>`;
        }).join('') || '<p class="muted">暂无转运单</p>'}
        <form class="inline-form" data-api="/api/orders" data-reset>
          <div class="form-row">
            <input name="order_no" placeholder="转运单号 如 ZY-2026-004" required>
            <input name="route" placeholder="路线">
            <select name="vehicle_id">
              <option value="">配车…</option>
              ${state.vehicles.map((v) => `<option value="${v.vehicle_id}">${UI.escape(v.plate)}</option>`).join('')}
            </select>
            <select name="appointment_id">
              <option value="">预约…</option>
              ${state.appointments.map((a) => `<option value="${a.appointment_id}">${UI.escape(a.slot)}</option>`).join('')}
            </select>
            <input name="planned_qty" type="number" min="0" placeholder="计划数量">
            <input name="planned_boxes" type="number" min="0" placeholder="计划箱数">
            <button class="btn small">新增转运单</button>
          </div>
        </form>
      </div>`;

    el.innerHTML = stats + vehicles + appointments + orders;
    el.querySelectorAll('form.inline-form').forEach(Form.bind);
  },
};

// 通用表单提交：POST JSON 到 data-api，成功后刷新
const Form = {
  bind(form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {};
      new FormData(form).forEach((v, k) => { body[k] = v === '' ? null : v; });
      try {
        const resp = await fetch(form.dataset.api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const r = await resp.json();
        if (!resp.ok) throw new Error(r.error || '提交失败');
        form.reset();
        UI.toast('已保存');
        await Dispatch.render();
        await UI.refreshAnomalyBadge();
      } catch (err) {
        UI.toast(err.message, true);
      }
    });
  },
};
