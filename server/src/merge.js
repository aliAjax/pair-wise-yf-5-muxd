// 离线合并引擎
// 规则：
//  1. 按 (转运单, 箱号, 字段版本) 合并：字段版本高者得；同版本不同值 => 字段冲突，保留两版
//  2. 箱号与调度记录不一致（箱号已属于另一转运单）=> 保留两版 + 待核异常，不覆盖
//  3. 交接数量与转运单不一致 => 保留两版 + 待核异常；已收样记录(handover_qty)绝不被自动盖掉
//  4. 容量不足/预约已满 => 隔离受影响箱组（不计入占用），保留最后一次确认结果，
//     异常中给出最早阻塞的转运单
//  5. event_id 幂等：已应用的事件重试只返回原结果，不重复占用容量、不增加交接次数
//     （rejected 事件未产生任何占用，允许重跑）
const { randomUUID } = require('crypto');

// 处理一批随车端上报的事件（一个事务），返回每条事件的处理结果
function processSync(db, deviceSerial, events) {
  const results = [];
  const tx = db.transaction((list) => {
    for (const ev of list) {
      results.push(processOne(db, deviceSerial, ev));
    }
  });
  tx(events);
  return results;
}

function processOne(db, deviceSerial, ev) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM events WHERE event_id=?').get(ev.event_id);
  if (existing && existing.status !== 'rejected') {
    // 幂等重试：直接返回上次结果，不再占用容量、不再增加交接次数
    return {
      event_id: ev.event_id,
      status: existing.status,
      reason: existing.reason,
      anomaly_id: existing.anomaly_id,
      duplicate: true,
    };
  }
  if (existing) {
    // rejected 事件未产生任何副作用，删除流水后重跑
    db.prepare('DELETE FROM events WHERE event_id=?').run(ev.event_id);
  }

  db.prepare(`INSERT INTO events
    (event_id, order_no, box_no, device_serial, type, payload, occurred_at, received_at, status)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(ev.event_id, ev.order_no, ev.box_no, deviceSerial, ev.type,
      JSON.stringify(ev.fields || {}), ev.occurred_at || now, now, 'received');

  // --- 转运单校验 ---
  const order = db.prepare('SELECT * FROM orders WHERE order_no=?').get(ev.order_no);
  if (!order) {
    const reason = `转运单 ${ev.order_no} 在调度系统中不存在，本地记录已保留，请核对单号后重新登记`;
    db.prepare("UPDATE events SET status='rejected', reason=? WHERE event_id=?")
      .run(reason, ev.event_id);
    return { event_id: ev.event_id, status: 'rejected', reason };
  }

  // --- 箱号一致性：该箱号已属于另一张转运单 => 箱号不一致 ---
  const box = db.prepare('SELECT * FROM boxes WHERE box_no=?').get(ev.box_no);
  if (box && box.order_no !== ev.order_no) {
    const anomalyId = randomUUID();
    db.prepare(`INSERT INTO anomalies
      (anomaly_id, order_no, box_no, type, severity, title, dispatch_version, vehicle_version,
       blocking_order_no, status, resolution, resolved_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(anomalyId, ev.order_no, ev.box_no, 'box_mismatch', 'critical',
        `箱号 ${ev.box_no} 与调度记录不一致`,
        JSON.stringify({ order_no: box.order_no, device_serial: box.device_serial, source: 'dispatch' }),
        JSON.stringify({ order_no: ev.order_no, device_serial: deviceSerial, source: 'vehicle' }),
        null, 'pending', null, null, now);
    db.prepare("UPDATE events SET status='conflict', reason=?, anomaly_id=? WHERE event_id=?")
      .run(`箱号不一致：箱 ${ev.box_no} 已属于转运单 ${box.order_no}，两版均保留待核`, anomalyId, ev.event_id);
    return {
      event_id: ev.event_id,
      status: 'conflict',
      reason: `箱号不一致：箱 ${ev.box_no} 已属于转运单 ${box.order_no}，两版记录均保留，请核处`,
      anomaly_id: anomalyId,
    };
  }

  // --- 容量/预约校验（仅装箱事件占用箱位）---
  if (ev.type === 'pack') {
    const cap = checkCapacity(db, order);
    if (!cap.ok) {
      // 隔离受影响箱组：已存在的箱组保留最后一次确认结果（不动字段），新箱组以 isolated 落库但不计入占用
      if (!box) {
        const f = ev.fields || {};
        db.prepare(`INSERT INTO boxes
          (box_no, order_no, device_serial, status, qty, handover_qty, ice_qty, temp,
           handover_count, isolated, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(ev.box_no, ev.order_no, deviceSerial, 'isolated',
            f.qty?.value ?? null, null, null, f.temp?.value ?? null, 0, 1, now);
      } else {
        db.prepare('UPDATE boxes SET isolated=1, updated_at=? WHERE box_no=?').run(now, ev.box_no);
      }
      const anomalyId = randomUUID();
      db.prepare(`INSERT INTO anomalies
        (anomaly_id, order_no, box_no, type, severity, title, dispatch_version, vehicle_version,
         blocking_order_no, status, resolution, resolved_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(anomalyId, ev.order_no, ev.box_no, cap.type, 'critical', cap.title,
          JSON.stringify({ capacity: cap.capacity, occupied: cap.occupied,
            blocking_orders: cap.blockingOrders, source: 'dispatch' }),
          JSON.stringify({ fields: ev.fields || {}, device_serial: deviceSerial, source: 'vehicle' }),
          cap.blockingOrderNo, 'pending', null, null, now);
      db.prepare("UPDATE events SET status='isolated', reason=?, anomaly_id=? WHERE event_id=?")
        .run(cap.reason, anomalyId, ev.event_id);
      return { event_id: ev.event_id, status: 'isolated', reason: cap.reason, anomaly_id: anomalyId };
    }
  }

  // --- 确保箱组存在 ---
  if (!box) {
    db.prepare(`INSERT INTO boxes
      (box_no, order_no, device_serial, status, qty, handover_qty, ice_qty, temp,
       handover_count, isolated, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ev.box_no, ev.order_no, deviceSerial, 'packed', null, null, null, null, 0, 0, now);
  }

  // --- 字段级合并（按版本）---
  const fieldConflicts = [];
  for (const [field, fv] of Object.entries(ev.fields || {})) {
    const stored = db.prepare('SELECT * FROM box_fields WHERE box_no=? AND field=?')
      .get(ev.box_no, field);
    const incomingVal = JSON.stringify(fv.value);
    if (!stored) {
      db.prepare('INSERT INTO box_fields (box_no, field, value, version, updated_at) VALUES (?,?,?,?,?)')
        .run(ev.box_no, field, incomingVal, fv.version, now);
    } else if (fv.version > stored.version) {
      // handover_qty（已收样数量）：已有确认值且新版本要改成不同值 => 不能盖掉已收样记录
      if (field === 'handover_qty' && stored.value !== incomingVal) {
        fieldConflicts.push({ field, stored: JSON.parse(stored.value), incoming: fv.value,
          version: fv.version, reason: '已收样记录不可自动覆盖' });
        continue;
      }
      db.prepare('UPDATE box_fields SET value=?, version=?, updated_at=? WHERE box_no=? AND field=?')
        .run(incomingVal, fv.version, now, ev.box_no, field);
    } else if (fv.version === stored.version && stored.value !== incomingVal) {
      fieldConflicts.push({ field, stored: JSON.parse(stored.value), incoming: fv.value,
        version: fv.version, reason: '同版本不同值' });
    }
    // fv.version < stored.version：过期字段，静默跳过（幂等）
  }

  // --- 反规范化到 boxes 行（便于列表展示）---
  const merged = db.prepare('SELECT field, value FROM box_fields WHERE box_no=?').all(ev.box_no);
  const get = (f) => {
    const r = merged.find((x) => x.field === f);
    return r ? JSON.parse(r.value) : undefined;
  };
  db.prepare(`UPDATE boxes SET
      status = COALESCE(?, status),
      qty = COALESCE(?, qty),
      handover_qty = COALESCE(?, handover_qty),
      ice_qty = COALESCE(?, ice_qty),
      temp = COALESCE(?, temp),
      device_serial = COALESCE(?, device_serial),
      updated_at = ?
    WHERE box_no=?`)
    .run(get('status') ?? null, get('qty') ?? null, get('handover_qty') ?? null,
      get('ice_qty') ?? null, get('temp') ?? null, get('device_serial') ?? deviceSerial,
      now, ev.box_no);

  // --- 交接次数：仅装箱/开箱事件在首次应用时 +1（幂等重试不会重复增加）---
  if (ev.type === 'pack' || ev.type === 'unbox') {
    db.prepare('UPDATE boxes SET handover_count = handover_count + 1, updated_at=? WHERE box_no=?')
      .run(now, ev.box_no);
  }

  // --- 字段版本冲突 => 保留两版 + 待核异常 ---
  if (fieldConflicts.length) {
    const anomalyId = randomUUID();
    db.prepare(`INSERT INTO anomalies
      (anomaly_id, order_no, box_no, type, severity, title, dispatch_version, vehicle_version,
       blocking_order_no, status, resolution, resolved_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(anomalyId, ev.order_no, ev.box_no, 'field_conflict', 'warning',
        `箱 ${ev.box_no} 字段版本冲突：${fieldConflicts.map((c) => c.field).join('、')}`,
        JSON.stringify(fieldConflicts.map((c) => ({
          field: c.field, value: c.stored, version: c.version, reason: c.reason, source: 'dispatch' }))),
        JSON.stringify(fieldConflicts.map((c) => ({
          field: c.field, value: c.incoming, version: c.version, source: 'vehicle' }))),
        null, 'pending', null, null, now);
    db.prepare("UPDATE events SET status='conflict', reason=?, anomaly_id=? WHERE event_id=?")
      .run(`字段版本冲突（${fieldConflicts.map((c) => c.field).join('、')}），两版均保留待核`,
        anomalyId, ev.event_id);
    return {
      event_id: ev.event_id,
      status: 'conflict',
      reason: `字段版本冲突：${fieldConflicts.map((c) => c.field).join('、')}，两版记录均保留，请核处`,
      anomaly_id: anomalyId,
    };
  }

  // --- 交接数量与转运单不一致 => 保留两版 + 待核异常 ---
  const boxAfter = db.prepare('SELECT * FROM boxes WHERE box_no=?').get(ev.box_no);
  // 交接数量优先用 handover_qty（开箱交接数），否则用装箱 qty
  const actualQty = boxAfter.handover_qty ?? boxAfter.qty;
  if (actualQty != null && order.planned_qty != null && actualQty !== order.planned_qty) {
    const dup = db.prepare(
      "SELECT anomaly_id FROM anomalies WHERE box_no=? AND type='qty_mismatch' AND status='pending'")
      .get(ev.box_no);
    if (!dup) {
      const anomalyId = randomUUID();
      db.prepare(`INSERT INTO anomalies
        (anomaly_id, order_no, box_no, type, severity, title, dispatch_version, vehicle_version,
         blocking_order_no, status, resolution, resolved_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(anomalyId, ev.order_no, ev.box_no, 'qty_mismatch', 'warning',
          `箱 ${ev.box_no} 交接数量与转运单不一致`,
          JSON.stringify({ planned_qty: order.planned_qty, source: 'dispatch' }),
          JSON.stringify({ qty: boxAfter.qty, handover_qty: boxAfter.handover_qty, source: 'vehicle' }),
          null, 'pending', null, null, now);
    }
  }

  // --- 温控事件：超 range 生成温控异常（不阻断业务）---
  if (ev.type === 'temp' && get('temp') != null) {
    const t = get('temp');
    const critical = t < 2 || t > 8;
    const anomalyId = randomUUID();
    db.prepare(`INSERT INTO anomalies
      (anomaly_id, order_no, box_no, type, severity, title, dispatch_version, vehicle_version,
       blocking_order_no, status, resolution, resolved_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(anomalyId, ev.order_no, ev.box_no, 'temp', critical ? 'critical' : 'warning',
        `箱 ${ev.box_no} 温控记录：${t}℃（冷链范围 2~8℃）`,
        null,
        JSON.stringify({ temp: t, note: ev.fields?.note?.value ?? null,
          device_serial: deviceSerial, source: 'vehicle' }),
        null, 'pending', null, null, now);
  }

  db.prepare("UPDATE events SET status='applied' WHERE event_id=?").run(ev.event_id);
  return { event_id: ev.event_id, status: 'applied' };
}

// 容量校验：车辆容量 / 实验室预约容量。返回最早阻塞的转运单
function checkCapacity(db, order) {
  const mk = (type, title, capacity, occupied, rows) => {
    const blocking = rows[0]?.order_no ?? null;
    const plate = type === 'capacity' ? title : '';
    return {
      ok: false,
      type,
      title,
      capacity,
      occupied,
      blockingOrderNo: blocking,
      blockingOrders: rows.map((r) => r.order_no),
      reason: type === 'capacity'
        ? `车辆容量不足：已占用 ${occupied}/${capacity} 箱，本箱组已隔离（不计入占用），`
          + `最早阻塞转运单：${blocking ?? '—'}`
        : `实验室预约已满：已占用 ${occupied}/${capacity} 箱，本箱组已隔离（不计入占用），`
          + `最早阻塞转运单：${blocking ?? '—'}`,
    };
  };

  if (order.vehicle_id) {
    const v = db.prepare('SELECT * FROM vehicles WHERE vehicle_id=?').get(order.vehicle_id);
    if (v) {
      const rows = db.prepare(`SELECT o.order_no, o.created_at, COUNT(b.box_no) AS c
        FROM orders o
        LEFT JOIN boxes b ON b.order_no=o.order_no AND b.isolated=0
        WHERE o.vehicle_id=?
        GROUP BY o.order_no ORDER BY o.created_at ASC`)
        .all(order.vehicle_id);
      const occupied = rows.reduce((s, r) => s + r.c, 0);
      if (occupied + 1 > v.capacity) {
        return mk('capacity', `车辆 ${v.plate} 容量不足`, v.capacity, occupied, rows);
      }
    }
  }
  if (order.appointment_id) {
    const a = db.prepare('SELECT * FROM appointments WHERE appointment_id=?').get(order.appointment_id);
    if (a) {
      const rows = db.prepare(`SELECT o.order_no, o.created_at, COUNT(b.box_no) AS c
        FROM orders o
        LEFT JOIN boxes b ON b.order_no=o.order_no AND b.isolated=0
        WHERE o.appointment_id=?
        GROUP BY o.order_no ORDER BY o.created_at ASC`)
        .all(order.appointment_id);
      const occupied = rows.reduce((s, r) => s + r.c, 0);
      if (occupied + 1 > a.capacity) {
        return mk('appointment', `实验室预约已满（${a.slot}）`, a.capacity, occupied, rows);
      }
    }
  }
  return { ok: true };
}

// 异常核处：采纳随车版本 / 采纳调度版本 / 保持隔离 / 解除隔离 / 标记核实
function resolveAnomaly(db, anomalyId, resolution) {
  const now = Date.now();
  const a = db.prepare('SELECT * FROM anomalies WHERE anomaly_id=?').get(anomalyId);
  if (!a || a.status !== 'pending') return { ok: false, error: '异常不存在或已处理' };

  const bumpField = (boxNo, field, value) => {
    const stored = db.prepare('SELECT * FROM box_fields WHERE box_no=? AND field=?')
      .get(boxNo, field);
    const version = stored ? stored.version + 1 : 1;
    const val = JSON.stringify(value);
    if ( stored) {
      db.prepare('UPDATE box_fields SET value=?, version=?, updated_at=? WHERE box_no=? AND field=?')
        .run(val, version, now, boxNo, field);
    } else {
      db.prepare('INSERT INTO box_fields (box_no, field, value, version, updated_at) VALUES (?,?,?,?,?)')
        .run(boxNo, field, val, version, now);
    }
  };

  const box = db.prepare('SELECT * FROM boxes WHERE box_no=?').get(a.box_no);

  if (resolution === 'release') {
    // 解除隔离：重新校验容量，仍不足则拒绝
    if (!box) return { ok: false, error: '箱组不存在' };
    const order = db.prepare('SELECT * FROM orders WHERE order_no=?').get(box.order_no);
    const cap = checkCapacity(db, order);
    if (!cap.ok) return { ok: false, error: cap.reason };
    db.prepare("UPDATE boxes SET isolated=0, status='packed', updated_at=? WHERE box_no=?")
      .run(now, a.box_no);
  } else if (resolution === 'accept_vehicle') {
    if (a.type === 'box_mismatch') {
      const vv = JSON.parse(a.vehicle_version);
      db.prepare('UPDATE boxes SET order_no=?, updated_at=? WHERE box_no=?')
        .run(vv.order_no, now, a.box_no);
    } else if (a.type === 'qty_mismatch') {
      const vv = JSON.parse(a.vehicle_version);
      if (vv.handover_qty != null) bumpField(a.box_no, 'handover_qty', vv.handover_qty);
      if (vv.qty != null) bumpField(a.box_no, 'qty', vv.qty);
    } else if (a.type === 'field_conflict') {
      const vv = JSON.parse(a.vehicle_version);
      for (const c of vv) bumpField(a.box_no, c.field, c.incoming ?? c.value);
    }
  } else if (resolution === 'accept_dispatch') {
    if (a.type === 'qty_mismatch') {
      const dv = JSON.parse(a.dispatch_version);
      if (dv.planned_qty != null) {
        bumpField(a.box_no, 'handover_qty', dv.planned_qty);
        bumpField(a.box_no, 'qty', dv.planned_qty);
      }
    }
    // box_mismatch / field_conflict 采纳调度版本 => 保持现状即可
  }
  // dismissed / keep：保持现状

  // 反规范化
  if (box) {
    const merged = db.prepare('SELECT field, value FROM box_fields WHERE box_no=?').all(a.box_no);
    const get = (f) => {
      const r = merged.find((x) => x.field === f);
      return r ? JSON.parse(r.value) : undefined;
    };
    db.prepare(`UPDATE boxes SET
        qty = COALESCE(?, qty), handover_qty = COALESCE(?, handover_qty),
        ice_qty = COALESCE(?, ice_qty), temp = COALESCE(?, temp), updated_at=?
      WHERE box_no=?`)
      .run(get('qty') ?? null, get('handover_qty') ?? null, get('ice_qty') ?? null,
        get('temp') ?? null, now, a.box_no);
  }

  db.prepare("UPDATE anomalies SET status='resolved', resolution=?, resolved_at=? WHERE anomaly_id=?")
    .run(resolution, now, anomalyId);
  return { ok: true };
}

module.exports = { processSync, resolveAnomaly, checkCapacity };
