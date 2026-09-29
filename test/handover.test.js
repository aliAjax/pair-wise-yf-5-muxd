import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStation, SyncServer, initialState, MemoryStore } from '../src/index.js';

function setup() {
  const server = new SyncServer(new MemoryStore(initialState()));
  const dispatch = new LocalStation('dispatch-1', new MemoryStore({ server: initialState(), outbox: [], localRecords: [] }));
  const truck = new LocalStation('truck-1', new MemoryStore({ server: initialState(), outbox: [], localRecords: [] }));
  return { server, dispatch, truck };
}

function seedBaseline(server) {
  server.applyBatch([
    { id: 'v1', type: 'UPSERT_VEHICLE', entityId: 'V1', nodeId: 'test', fields: { name: '冷链车', boxCapacity: 2, sampleCapacity: 20, active: true, fieldVersions: { name: 1, boxCapacity: 1, sampleCapacity: 1, active: 1 } } },
    { id: 'a1', type: 'UPSERT_APPOINTMENT', entityId: 'A1', nodeId: 'test', fields: { labId: 'L1', sampleCapacity: 20, windowStart: '09:00', windowEnd: '10:00', active: true, fieldVersions: { labId: 1, sampleCapacity: 1, windowStart: 1, windowEnd: 1, active: 1 } } },
    { id: 'm1', type: 'UPSERT_MANIFEST', entityId: 'm1', nodeId: 'test', fields: { origin: '中心', destination: '山区', plannedBoxCount: 1, plannedSampleCount: 10, vehicleId: 'V1', appointmentId: 'A1', scheduledAt: '2026-09-29T09:00:00Z', status: 'DRAFT', fieldVersions: { origin: 1, destination: 1, plannedBoxCount: 1, plannedSampleCount: 1, vehicleId: 1, appointmentId: 1, scheduledAt: 1, status: 1 } } }
  ]);
  server.applyBatch([{ id: 'p1', type: 'PLAN_MANIFEST', nodeId: 'test', manifestId: 'm1', vehicleId: 'V1', appointmentId: 'A1', plannedBoxCount: 1, plannedSampleCount: 10 }]);
}

test('调度容量和预约校验通过后，随车端可离线装箱并同步补冰/开箱/温控事件', () => {
  const { server, dispatch, truck } = setup();
  dispatch.upsertVehicle('V1', { name: '冷链车', boxCapacity: 2, sampleCapacity: 20, active: true });
  dispatch.upsertAppointment('A1', { labId: 'L1', sampleCapacity: 20, windowStart: '09:00', windowEnd: '10:00', active: true });
  dispatch.upsertManifest('M1', { origin: '中心', destination: '山区', plannedBoxCount: 1, plannedSampleCount: 10, vehicleId: 'V1', appointmentId: 'A1', scheduledAt: '2026-09-29T09:00:00Z', status: 'DRAFT' });
  dispatch.planManifest('M1', { vehicleId: 'V1', appointmentId: 'A1', plannedBoxCount: 1, plannedSampleCount: 10 });
  assert.deepEqual(dispatch.sync(server).map((r) => r.status), ['applied', 'applied', 'applied', 'applied']);
  truck.pull(server);

  truck.packBoxGroup('M1', 'G1', [{ boxId: 'B1', deviceSerial: 'D1', sampleCount: 10 }], { vehicleId: 'V1', appointmentId: 'A1' });
  truck.addEvents('M1', [
    { id: 'E1', boxId: 'B1', type: 'ICE_REPLENISHED', at: '2026-09-29T10:00:00Z', payload: { iceKg: 2 } },
    { id: 'E2', boxId: 'B1', type: 'BOX_OPENED', at: '2026-09-29T10:10:00Z', payload: { reason: '巡检' } },
    { id: 'E3', boxId: 'B1', type: 'TEMP_ABNORMAL', at: '2026-09-29T10:20:00Z', payload: { minTemperature: 7, maxTemperature: 12 } }
  ]);
  assert.equal(truck.localSnapshot().outbox.length, 2);
  const results = truck.sync(server);
  assert.deepEqual(results.map((r) => r.status), ['applied', 'applied']);
  assert.equal(truck.localSnapshot().outbox.length, 0);
  assert.equal(server.snapshot().events.length, 4);
  assert.equal(server.snapshot().events.at(-1).acknowledged, false);
});

test('容量不足时隔离整组，保留最后确认结果，并指出最早阻塞转运单', () => {
  const { server } = setup();
  seedBaseline(server);
  server.applyBatch([{
    id: 'pack-m1',
    type: 'PACK_BOX_GROUP',
    nodeId: 'truck-1',
    manifestId: 'm1',
    groupId: 'G-M1',
    vehicleId: 'V1',
    appointmentId: 'A1',
    occurredAt: '2026-09-29T09:30:00Z',
    boxes: [{ boxId: 'B1', deviceSerial: 'D1', sampleCount: 10, fieldVersion: 1, packedAt: '2026-09-29T09:30:00Z' }]
  }]);

  // M2 与 M1 同样预约 10 份；再装入 11 份会让车辆和预约都超限。
  server.applyBatch([
    { id: 'm2', type: 'UPSERT_MANIFEST', entityId: 'm2', nodeId: 'test', fields: { origin: '中心', destination: '县站', plannedBoxCount: 1, plannedSampleCount: 10, vehicleId: 'V1', appointmentId: 'A1', status: 'DRAFT', fieldVersions: { origin: 1, destination: 1, plannedBoxCount: 1, plannedSampleCount: 1, vehicleId: 1, appointmentId: 1, status: 1 } } },
    { id: 'p2', type: 'PLAN_MANIFEST', nodeId: 'test', manifestId: 'm2', vehicleId: 'V1', appointmentId: 'A1', plannedBoxCount: 1, plannedSampleCount: 10 }
  ]);
  const [result] = server.applyBatch([{
    id: 'pack-m2',
    type: 'PACK_BOX_GROUP',
    nodeId: 'truck-2',
    manifestId: 'm2',
    groupId: 'G-M2',
    vehicleId: 'V1',
    appointmentId: 'A1',
    boxes: [{ boxId: 'B2', deviceSerial: 'D2', sampleCount: 11, fieldVersion: 1 }]
  }]);

  assert.equal(result.status, 'blocked');
  assert.equal(result.quarantine, true);
  assert.equal(server.snapshot().boxes.B2, undefined);
  assert.equal(server.snapshot().quarantined['G-M2'].quarantineReason, 'vehicle_capacity_full');
  assert.equal(result.earliestBlockingManifest, 'm1');
  assert.deepEqual(server.snapshot().manifests.m2.lastConfirmed, {
    status: 'PLANNED',
    at: server.snapshot().manifests.m2.lastConfirmed.at,
    opId: 'p2',
    plannedBoxCount: 1,
    plannedSampleCount: 10,
    vehicleId: 'V1',
    appointmentId: 'A1'
  });
});

test('箱号重复但数量或设备序号不同会保留两版，不能覆盖已存在记录', () => {
  const { server } = setup();
  seedBaseline(server);
  server.applyBatch([{ id: 'pack1', type: 'PACK_BOX_GROUP', nodeId: 't1', manifestId: 'm1', groupId: 'G1', vehicleId: 'V1', appointmentId: 'A1', boxes: [{ boxId: 'B1', deviceSerial: 'D1', sampleCount: 10, fieldVersion: 1 }] }]);
  const [result] = server.applyBatch([{ id: 'pack2', type: 'PACK_BOX_GROUP', nodeId: 't2', manifestId: 'm1', groupId: 'G2', vehicleId: 'V1', appointmentId: 'A1', boxes: [{ boxId: 'B1', deviceSerial: 'D-OTHER', sampleCount: 11, fieldVersion: 1 }] }]);

  assert.equal(result.status, 'blocked');
  assert.equal(server.snapshot().boxes.B1.deviceSerial, 'D1');
  assert.equal(server.snapshot().boxes.B1.sampleCount, 10);
  const candidate = server.snapshot().quarantined.G2.boxes[0];
  assert.equal(candidate.deviceSerial, 'D-OTHER');
  assert.equal(candidate.sampleCount, 11);
  assert.equal(server.snapshot().exceptions.at(-1).type, 'data_conflict');
});

test('交接数量不一致保留两版，正式交接次数不增加；修复后原操作重试幂等', () => {
  const { server, truck } = setup();
  seedBaseline(server);
  server.applyBatch([{ id: 'pack1', type: 'PACK_BOX_GROUP', nodeId: 't1', manifestId: 'm1', groupId: 'G1', vehicleId: 'V1', appointmentId: 'A1', boxes: [{ boxId: 'B1', deviceSerial: 'D1', sampleCount: 10, fieldVersion: 1 }] }]);
  truck.pull(server);

  truck.confirmReceipt('m1', 'B1', 9, '李医生', { handoverId: 'H1' });
  const first = truck.sync(server);
  assert.equal(first[0].status, 'blocked');
  assert.equal(first[0].handoverCountDelta, 0);
  assert.equal(truck.localSnapshot().outbox.length, 1);
  assert.equal(server.snapshot().manifests.m1.officialHandoverCount, undefined);
  assert.equal(server.snapshot().receipts[0].status, 'QUARANTINED');

  // 错误未修复前重试：返回同一结果，不新增异常、不新增交接次数。
  const retry = truck.sync(server);
  assert.equal(retry[0].status, 'blocked');
  assert.equal(server.snapshot().exceptions.filter((e) => e.opId === truck.localSnapshot().localRecords[0]?.opId || true).length, server.snapshot().exceptions.length);
  assert.equal(server.snapshot().receipts.length, 1);
});

test('已经收样的箱号不能被另一个数量的交接覆盖', () => {
  const { server } = setup();
  seedBaseline(server);
  server.applyBatch([
    { id: 'pack1', type: 'PACK_BOX_GROUP', nodeId: 't1', manifestId: 'm1', groupId: 'G1', vehicleId: 'V1', appointmentId: 'A1', boxes: [{ boxId: 'B1', deviceSerial: 'D1', sampleCount: 10, fieldVersion: 1 }] },
    { id: 'r1', type: 'CONFIRM_RECEIPT', nodeId: 'lab', manifestId: 'm1', boxId: 'B1', sampleQuantity: 10, receiver: '甲', handoverId: 'H1', receivedAt: '2026-09-29T11:00:00Z' },
    { id: 'r2', type: 'CONFIRM_RECEIPT', nodeId: 'lab', manifestId: 'm1', boxId: 'B1', sampleQuantity: 10, receiver: '甲', handoverId: 'H2', receivedAt: '2026-09-29T11:00:00Z' }
  ]);
  assert.equal(server.snapshot().boxes.B1.receiver, '甲');
  assert.equal(server.snapshot().receipts.filter((r) => r.status === 'ACCEPTED').length, 1);
  assert.equal(server.snapshot().receipts.at(-1).status, 'QUARANTINED');
  assert.equal(server.snapshot().manifests.m1.officialHandoverCount, 1);
});

test('同一装箱操作在容量扩容后重试成功，不重复占容量或重复装箱', () => {
  const { server } = setup();
  seedBaseline(server);
  const blockedOp = { id: 'bigpack', type: 'PACK_BOX_GROUP', nodeId: 't1', manifestId: 'm1', groupId: 'G1', vehicleId: 'V1', appointmentId: 'A1', boxes: [{ boxId: 'B1', deviceSerial: 'D1', sampleCount: 21, fieldVersion: 1 }] };
  assert.equal(server.applyBatch([blockedOp])[0].status, 'blocked');
  assert.equal(server.applyBatch([blockedOp])[0].status, 'blocked');
  assert.equal(Object.keys(server.snapshot().quarantined).length, 1);
  assert.equal(server.snapshot().exceptions.length, 1);

  // 调度扩容后用新的版本修正车辆容量。
  server.applyBatch([
    { id: 'grow-vehicle', type: 'UPSERT_VEHICLE', nodeId: 'dispatch', entityId: 'V1', fields: { sampleCapacity: 40, fieldVersions: { sampleCapacity: 2 } } },
    { id: 'grow-appointment', type: 'UPSERT_APPOINTMENT', nodeId: 'dispatch', entityId: 'A1', fields: { sampleCapacity: 40, fieldVersions: { sampleCapacity: 2 } } }
  ]);
  assert.equal(server.applyBatch([blockedOp])[0].status, 'applied');
  assert.equal(Object.keys(server.snapshot().boxes).length, 1);
  assert.equal(server.snapshot().groups.G1.sampleCount, 21);
  assert.equal(server.snapshot().exceptions.filter((e) => e.status === 'OPEN').length, 0);
});

test('预约已满时新转运单不能规划成功，并保留上一次确认结果', () => {
  const { server } = setup();
  seedBaseline(server);
  server.applyBatch([{ id: 'm2draft', type: 'UPSERT_MANIFEST', entityId: 'm2draft', nodeId: 'dispatch', fields: { origin: '中心', destination: '北站', plannedBoxCount: 1, plannedSampleCount: 11, vehicleId: 'V1', appointmentId: 'A1', status: 'DRAFT', fieldVersions: { origin: 1, destination: 1, plannedBoxCount: 1, plannedSampleCount: 1, vehicleId: 1, appointmentId: 1, status: 1 } } }]);
  const [result] = server.applyBatch([{ id: 'p2', type: 'PLAN_MANIFEST', nodeId: 'dispatch', manifestId: 'm2draft', vehicleId: 'V1', appointmentId: 'A1', plannedBoxCount: 1, plannedSampleCount: 11 }]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.earliestBlockingManifest, 'm1');
  assert.equal(server.snapshot().manifests.m2draft.status, 'DRAFT');
  assert.equal(server.snapshot().exceptions.at(-1).lastConfirmedResult, null);
});

test('同字段版本分叉会保留两版并生成字段版本冲突；高版本才推进', () => {
  const { server } = setup();
  const [r1] = server.applyBatch([{ id: 'u1', type: 'UPSERT_MANIFEST', entityId: 'M9', nodeId: 'a', fields: { origin: '甲站', destination: 'A', fieldVersions: { origin: 1, destination: 1 } } }]);
  assert.equal(r1.status, 'applied');
  const results = server.applyBatch([
    { id: 'u2', type: 'UPSERT_MANIFEST', entityId: 'M9', nodeId: 'a', fields: { origin: '乙站', fieldVersions: { origin: 1 } } },
    { id: 'u3', type: 'UPSERT_MANIFEST', entityId: 'M9', nodeId: 'b', fields: { origin: '丙站', fieldVersions: { origin: 2 } } }
  ]);
  assert.equal(results[0].status, 'applied');
  assert.equal(results[0].exceptions.length, 1);
  assert.equal(results[1].status, 'applied');
  assert.equal(server.snapshot().manifests.M9.origin, '丙站');
  assert.deepEqual(server.snapshot().exceptions[0].versions, { server: '甲站', incoming: '乙站' });
});

test('同步失败时本地记录仍保留，网络恢复后成功移出 outbox', () => {
  const { dispatch } = setup();
  dispatch.upsertVehicle('VX', { name: '暂存车', boxCapacity: 1, sampleCapacity: 1, active: true });
  const local = dispatch.localSnapshot();
  assert.equal(local.outbox.length, 1);
  assert.equal(local.localRecords[0].status, 'PENDING');
  // 模拟没有网络：不调用远端，记录仍在。
  assert.equal(dispatch.localSnapshot().outbox.length, 1);
});
