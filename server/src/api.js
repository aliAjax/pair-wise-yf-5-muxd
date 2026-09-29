// HTTP API：调度端维护基础数据、随车端离线同步、异常核处
const express = require('express');
const { processSync, resolveAnomaly } = require('./merge');

function createApi(db) {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  const now = () => Date.now();

  // ---------- 基础数据（调度端维护）----------
  router.get('/state', (req, res) => {
    res.json({
      vehicles: db.prepare('SELECT * FROM vehicles ORDER BY vehicle_id').all(),
      labs: db.prepare('SELECT * FROM labs ORDER BY lab_id').all(),
      appointments: db.prepare(`SELECT a.*, l.name AS lab_name
        FROM appointments a JOIN labs l ON l.lab_id=a.lab_id
        ORDER BY a.appointment_id`).all(),
      orders: db.prepare('SELECT * FROM orders ORDER BY created_at').all(),
      boxes: db.prepare('SELECT * FROM boxes ORDER BY box_no').all(),
      anomalies: db.prepare('SELECT * FROM anomalies ORDER BY created_at DESC').all(),
    });
  });

  router.post('/vehicles', (req, res) => {
    const { vehicle_id, plate, capacity } = req.body;
    if (!vehicle_id || !plate || capacity == null) {
      return res.status(400).json({ error: 'vehicle_id / plate / capacity 必填' });
    }
    db.prepare('INSERT INTO vehicles (vehicle_id, plate, capacity) VALUES (?,?,?)')
      .run(vehicle_id, plate, Number(capacity));
    res.json({ ok: true });
  });

  router.post('/labs', (req, res) => {
    const { lab_id, name } = req.body;
    if (!lab_id || !name) return res.status(400).json({ error: 'lab_id / name 必填' });
    db.prepare('INSERT INTO labs (lab_id, name) VALUES (?,?)').run(lab_id, name);
    res.json({ ok: true });
  });

  router.post('/appointments', (req, res) => {
    const { appointment_id, lab_id, slot, capacity } = req.body;
    if (!appointment_id || !lab_id || !slot || capacity == null) {
      return res.status(400).json({ error: 'appointment_id / lab_id / slot / capacity 必填' });
    }
    db.prepare('INSERT INTO appointments (appointment_id, lab_id, slot, capacity) VALUES (?,?,?,?)')
      .run(appointment_id, lab_id, slot, Number(capacity));
    res.json({ ok: true });
  });

  router.post('/orders', (req, res) => {
    const { order_no, route, vehicle_id, appointment_id, planned_qty, planned_boxes } = req.body;
    if (!order_no) return res.status(400).json({ error: 'order_no 必填' });
    db.prepare(`INSERT INTO orders
      (order_no, route, vehicle_id, appointment_id, planned_qty, planned_boxes, status, created_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(order_no, route ?? null, vehicle_id ?? null, appointment_id ?? null,
        planned_qty ?? null, planned_boxes ?? null, 'open', now());
    res.json({ ok: true });
  });

  // ---------- 随车端离线同步 ----------
  router.post('/sync', (req, res) => {
    const { device_serial, events } = req.body;
    if (!Array.isArray(events)) return res.status(400).json({ error: 'events 必须是数组' });
    const results = processSync(db, device_serial ?? 'unknown', events);
    res.json({ results, server_time: now() });
  });

  // ---------- 异常核处 ----------
  router.post('/anomalies/:id/resolve', (req, res) => {
    const r = resolveAnomaly(db, req.params.id, req.body.resolution);
    if (!r.ok) return res.status(400).json(r);
    res.json({ ok: true });
  });

  // ---------- 演示数据 ----------
  router.post('/seed', (req, res) => {
    seed(db);
    res.json({ ok: true });
  });

  return router;
}

function seed(db) {
  const t = Date.now();
  const ins = (sql, ...args) => db.prepare(sql).run(...args);
  ins("INSERT OR IGNORE INTO vehicles (vehicle_id, plate, capacity) VALUES ('V1','沪A·冷链01',3)");
  ins("INSERT OR IGNORE INTO vehicles (vehicle_id, plate, capacity) VALUES ('V2','沪A·冷链02',2)");
  ins("INSERT OR IGNORE INTO labs (lab_id, name) VALUES ('L1','市疾控中心实验室')");
  ins("INSERT OR IGNORE INTO appointments (appointment_id, lab_id, slot, capacity) VALUES ('AP1','L1','2026-09-30 上午',4)");
  ins("INSERT OR IGNORE INTO appointments (appointment_id, lab_id, slot, capacity) VALUES ('AP2','L1','2026-09-30 下午',2)");
  ins(`INSERT OR IGNORE INTO orders
    (order_no, route, vehicle_id, appointment_id, planned_qty, planned_boxes, status, created_at)
    VALUES ('ZY-2026-001','市区采样点→市疾控','V1','AP1',10,2,'open',?)`, t);
  ins(`INSERT OR IGNORE INTO orders
    (order_no, route, vehicle_id, appointment_id, planned_qty, planned_boxes, status, created_at)
    VALUES ('ZY-2026-002','郊区采样点→市疾控','V1','AP1',8,2,'open',?)`, t + 1);
  ins(`INSERT OR IGNORE INTO orders
    (order_no, route, vehicle_id, appointment_id, planned_qty, planned_boxes, status, created_at)
    VALUES ('ZY-2026-003','远郊采样点→市疾控','V2','AP2',6,1,'open',?)`, t + 2);
}

module.exports = { createApi, seed };
