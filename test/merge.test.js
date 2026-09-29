// 合并引擎测试：幂等、冲突保留两版、容量隔离、失败重试不丢数据
const { test } = require('node:test');
const assert = require('node:assert');
const { initDb } = require('../server/src/db');
const { seed } = require('../server/src/api');
const { processSync, resolveAnomaly } = require('../server/src/merge');

let seq = 0;
function setup() {
  const db = initDb(':memory:');
  seed(db);
  seq = 0;
  return db;
}
function mkEvent(order_no, box_no, type, fields) {
  return {
    event_id: `evt-${++seq}`,
    order_no, box_no, type,
    occurred_at: 1000 + seq,
    fields,
  };
}
const F = (field, value, version) => ({ [field]: { value, version } });

test('幂等：同一装箱事件上报两次，箱组只建一个、交接次数不增加', () => {
  const db = setup();
  const e = mkEvent('ZY-2026-001', 'BOX-001', 'pack', {
    ...F('status', 'packed', 1), ...F('qty', 10, 1),
  });
  const r1 = processSync(db, 'DEV-1', [e]);
  const r2 = processSync(db, 'DEV-1', [e]);
  assert.equal(r1[0].status, 'applied');
  assert.equal(r2[0].status, 'applied');
  assert.equal(r2[0].duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes').get().c, 1);
  assert.equal(db.prepare('SELECT handover_count FROM boxes WHERE box_no=?').get('BOX-001').handover_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 1);
});

test('箱号不一致：箱已属于另一转运单，保留两版并生成待核异常，不覆盖归属', () => {
  const db = setup();
  processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-002', 'pack', F('status', 'packed', 1))]);
  const r = processSync(db, 'DEV-1', [mkEvent('ZY-2026-002', 'BOX-002', 'pack', F('status', 'packed', 1))]);
  assert.equal(r[0].status, 'conflict');
  const box = db.prepare('SELECT order_no FROM boxes WHERE box_no=?').get('BOX-002');
  assert.equal(box.order_no, 'ZY-2026-001'); // 未被盖掉
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-002' AND type='box_mismatch'").get();
  assert.equal(a.status, 'pending');
  assert.ok(JSON.parse(a.dispatch_version).order_no === 'ZY-2026-001');
  assert.ok(JSON.parse(a.vehicle_version).order_no === 'ZY-2026-002');
});

test('交接数量不一致：已收样记录不可自动盖掉，保留两版待核', () => {
  const db = setup();
  // 计划 10，实际交接 10
  processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-010', 'unbox', {
    ...F('status', 'opened', 1), ...F('handover_qty', 10, 1),
  })]);
  // 又上报 12（新版本）=> 不能盖掉已收样的 10
  const r = processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-010', 'unbox', {
    ...F('handover_qty', 12, 2),
  })]);
  assert.equal(r[0].status, 'conflict');
  assert.equal(db.prepare('SELECT handover_qty FROM boxes WHERE box_no=?').get('BOX-010').handover_qty, 10);
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-010' AND type='field_conflict'").get();
  assert.equal(a.status, 'pending');
});

test('装箱数量与转运单计划不一致 => 待核异常（两版保留）', () => {
  const db = setup();
  const r = processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-011', 'pack', {
    ...F('status', 'packed', 1), ...F('qty', 12, 1),
  })]);
  assert.equal(r[0].status, 'applied');
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-011' AND type='qty_mismatch'").get();
  assert.equal(a.status, 'pending');
  assert.equal(JSON.parse(a.dispatch_version).planned_qty, 10);
  assert.equal(JSON.parse(a.vehicle_version).qty, 12);
});

test('车辆容量不足：箱组隔离、保留最后确认结果、给出最早阻塞转运单；重试不重复占用', () => {
  const db = setup(); // V2 容量 2，ZY-2026-003 配 V2
  processSync(db, 'DEV-1', [
    mkEvent('ZY-2026-003', 'BOX-100', 'pack', F('status', 'packed', 1)),
    mkEvent('ZY-2026-003', 'BOX-101', 'pack', F('status', 'packed', 1)),
  ]);
  const overflow = mkEvent('ZY-2026-003', 'BOX-102', 'pack', F('status', 'packed', 1));
  const r1 = processSync(db, 'DEV-1', [overflow]);
  assert.equal(r1[0].status, 'isolated');
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-102' AND type='capacity'").get();
  assert.equal(a.status, 'pending');
  assert.equal(a.blocking_order_no, 'ZY-2026-003'); // 最早阻塞转运单
  // 隔离箱组不计入占用
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes WHERE isolated=0').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes WHERE isolated=1').get().c, 1);
  // 重试同一事件：幂等隔离，不重复占用
  const r2 = processSync(db, 'DEV-1', [overflow]);
  assert.equal(r2[0].status, 'isolated');
  assert.equal(r2[0].duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes WHERE isolated=0').get().c, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes').get().c, 3);
});

test('实验室预约已满：隔离并给出最早阻塞转运单', () => {
  const db = setup();
  db.prepare("INSERT INTO vehicles (vehicle_id, plate, capacity) VALUES ('V9','沪A·大车',99)").run();
  db.prepare("INSERT INTO appointments (appointment_id, lab_id, slot, capacity) VALUES ('AP9','L1','加班时段',2)").run();
  db.prepare(`INSERT INTO orders (order_no, route, vehicle_id, appointment_id, planned_qty, status, created_at)
    VALUES ('ZY-901','线1','V9','AP9',2,'open',?)`).run(100);
  db.prepare(`INSERT INTO orders (order_no, route, vehicle_id, appointment_id, planned_qty, status, created_at)
    VALUES ('ZY-902','线2','V9','AP9',2,'open',?)`).run(200);
  processSync(db, 'DEV-1', [
    mkEvent('ZY-901', 'BOX-901', 'pack', F('status', 'packed', 1)),
    mkEvent('ZY-901', 'BOX-902', 'pack', F('status', 'packed', 1)),
  ]);
  const r = processSync(db, 'DEV-1', [mkEvent('ZY-902', 'BOX-903', 'pack', F('status', 'packed', 1))]);
  assert.equal(r[0].status, 'isolated');
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-903' AND type='appointment'").get();
  assert.equal(a.blocking_order_no, 'ZY-901'); // 最早阻塞转运单
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes WHERE isolated=0').get().c, 2);
});

test('字段版本冲突：同版本不同值 => 保留两版，已确认值不被覆盖', () => {
  const db = setup();
  processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-200', 'pack', F('status', 'packed', 1))]);
  const r = processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-200', 'pack', F('status', 'in_transit', 1))]);
  assert.equal(r[0].status, 'conflict');
  assert.equal(db.prepare('SELECT status FROM boxes WHERE box_no=?').get('BOX-200').status, 'packed');
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-200' AND type='field_conflict'").get();
  assert.equal(a.status, 'pending');
});

test('温控异常：超范围温度生成 critical 待核异常', () => {
  const db = setup();
  const r = processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-300', 'temp', {
    ...F('temp', 15, 1), ...F('note', '箱内温度过高', 1),
  })]);
  assert.equal(r[0].status, 'applied');
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-300' AND type='temp'").get();
  assert.equal(a.severity, 'critical');
  assert.equal(a.status, 'pending');
});

test('合并失败不丢数据：转运单不存在 => rejected 保留；补单后重试成功且不重复', () => {
  const db = setup();
  const e = mkEvent('ZY-NOPE', 'BOX-400', 'pack', F('status', 'packed', 1));
  const r1 = processSync(db, 'DEV-1', [e]);
  assert.equal(r1[0].status, 'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes').get().c, 0); // 未产生占用
  // 调度端补建转运单
  db.prepare(`INSERT INTO orders (order_no, route, status, created_at) VALUES ('ZY-NOPE','补录线','open',?)`).run(100);
  const r2 = processSync(db, 'DEV-1', [e]); // 同一 event_id 重试
  assert.equal(r2[0].status, 'applied');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes').get().c, 1);
  assert.equal(db.prepare('SELECT handover_count FROM boxes WHERE box_no=?').get('BOX-400').handover_count, 1);
});

test('异常核处：采纳随车版本后数量更新且版本号提升；解除隔离在容量仍不足时被拒绝', () => {
  const db = setup();
  processSync(db, 'DEV-1', [mkEvent('ZY-2026-001', 'BOX-500', 'pack', {
    ...F('status', 'packed', 1), ...F('qty', 12, 1),
  })]);
  const a = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-500' AND type='qty_mismatch'").get();
  assert.equal(resolveAnomaly(db, a.anomaly_id, 'accept_vehicle').ok, true);
  assert.equal(db.prepare('SELECT qty FROM boxes WHERE box_no=?').get('BOX-500').qty, 12);
  const field = db.prepare('SELECT version FROM box_fields WHERE box_no=? AND field=?').get('BOX-500', 'qty');
  assert.ok(field.version >= 2);
  assert.equal(db.prepare('SELECT status FROM anomalies WHERE anomaly_id=?').get(a.anomaly_id).status, 'resolved');

  // 隔离解除：容量仍占满时拒绝
  processSync(db, 'DEV-1', [
    mkEvent('ZY-2026-003', 'BOX-600', 'pack', F('status', 'packed', 1)),
    mkEvent('ZY-2026-003', 'BOX-601', 'pack', F('status', 'packed', 1)),
    mkEvent('ZY-2026-003', 'BOX-602', 'pack', F('status', 'packed', 1)), // 被隔离
  ]);
  const iso = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-602' AND type='capacity'").get();
  const r = resolveAnomaly(db, iso.anomaly_id, 'release');
  assert.equal(r.ok, false);
  assert.equal(db.prepare('SELECT isolated FROM boxes WHERE box_no=?').get('BOX-602').isolated, 1);
});

test('隔离箱组不会被温控事件自动解除；解除隔离在容量仍满时被拒', () => {
  const db = setup();
  processSync(db, 'DEV-1', [
    mkEvent('ZY-2026-003', 'BOX-700', 'pack', F('status', 'packed', 1)),
    mkEvent('ZY-2026-003', 'BOX-701', 'pack', F('status', 'packed', 1)),
    mkEvent('ZY-2026-003', 'BOX-702', 'pack', F('status', 'packed', 1)), // 被隔离
  ]);
  assert.equal(db.prepare('SELECT isolated FROM boxes WHERE box_no=?').get('BOX-702').isolated, 1);
  // 温控事件上报到隔离箱：只记录温度，不自动解除隔离
  processSync(db, 'DEV-1', [mkEvent('ZY-2026-003', 'BOX-702', 'temp', {
    ...F('temp', 5, 1), ...F('note', '正常', 1),
  })]);
  assert.equal(db.prepare('SELECT isolated FROM boxes WHERE box_no=?').get('BOX-702').isolated, 1);
  assert.equal(db.prepare('SELECT temp FROM boxes WHERE box_no=?').get('BOX-702').temp, 5);
  // 容量仍占满，解除隔离被拒
  const iso = db.prepare("SELECT * FROM anomalies WHERE box_no='BOX-702' AND type='capacity'").get();
  assert.equal(resolveAnomaly(db, iso.anomaly_id, 'release').ok, false);
  // 隔离箱组不计入占用
  assert.equal(db.prepare('SELECT COUNT(*) c FROM boxes WHERE isolated=0').get().c, 2);
});
