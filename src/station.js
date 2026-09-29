import { MemoryStore } from './store.js';
import { initialState } from './server.js';
import { bump, now, randomId } from './util.js';

export class LocalStation {
  constructor(nodeId, store = new MemoryStore({ server: initialState(), outbox: [], localRecords: [] })) {
    this.nodeId = nodeId;
    this.store = store;
    const state = this.store.read();
    if (!state.server) state.server = initialState();
    if (!Array.isArray(state.outbox)) state.outbox = [];
    if (!Array.isArray(state.localRecords)) state.localRecords = [];
    this.store.write(state);
  }

  localSnapshot() {
    return this.store.read();
  }

  serverSnapshot() {
    return this.localSnapshot().server;
  }

  dispatch(type, payload = {}) {
    const state = this.store.read();
    const op = {
      id: payload.opId || randomId('op'),
      type,
      nodeId: this.nodeId,
      at: now(),
      ...sanitizePayload(payload)
    };
    state.outbox.push(op);
    state.localRecords.push({ id: randomId('rec'), opId: op.id, type, at: op.at, payload: sanitizePayload(payload), status: 'PENDING' });
    this.store.write(state);
    return op;
  }

  sync(remote) {
    const state = this.store.read();
    const pending = state.outbox.filter((op) => !['applied', 'applied_noop', 'applied_duplicate'].includes(op.lastSyncResult?.status));
    const results = remote.applyBatch(pending.map((op) => structuredClone(op)));
    const synced = [];
    for (let i = 0; i < pending.length; i += 1) {
      const op = pending[i];
      const result = results[i];
      synced.push({ opId: op.id, ...result });
      op.syncedAt = now();
      op.lastSyncResult = result;
      const record = state.localRecords.find((item) => item.opId === op.id);
      if (record) {
        record.status = result.status;
        record.result = result;
      }
    }
    // 只有无副作用地完全成功才离开待处理队列；blocked/rejected 保留，修复后可用原 opId 重试。
    state.outbox = state.outbox.filter((op) => {
      const result = op.lastSyncResult;
      return !result || !['applied', 'applied_noop', 'applied_duplicate'].includes(result.status);
    });
    state.server = structuredClone(remote.snapshot());
    this.store.write(state);
    return synced;
  }

  pull(remote) {
    const state = this.store.read();
    state.server = structuredClone(remote.snapshot());
    this.store.write(state);
    return state.server;
  }

  upsertVehicle(vehicleId, fields) {
    return this.dispatch('UPSERT_VEHICLE', {
      entityId: vehicleId,
      fields: withBumpedVersions(this.serverSnapshot().vehicles[vehicleId]?.fieldVersions, fields)
    });
  }

  upsertAppointment(appointmentId, fields) {
    return this.dispatch('UPSERT_APPOINTMENT', {
      entityId: appointmentId,
      fields: withBumpedVersions(this.serverSnapshot().appointments[appointmentId]?.fieldVersions, fields)
    });
  }

  upsertManifest(manifestId, fields) {
    return this.dispatch('UPSERT_MANIFEST', {
      entityId: manifestId,
      fields: withBumpedVersions(this.serverSnapshot().manifests[manifestId]?.fieldVersions, fields)
    });
  }

  planManifest(manifestId, plan = {}) {
    return this.dispatch('PLAN_MANIFEST', { manifestId, ...plan });
  }

  packBoxGroup(manifestId, groupId, boxes, extra = {}) {
    const manifest = this.serverSnapshot().manifests[manifestId] || {};
    return this.dispatch('PACK_BOX_GROUP', {
      manifestId,
      groupId,
      boxes: boxes.map((box) => ({
        ...box,
        fieldVersion: bump(box.fieldVersion ?? this.serverSnapshot().boxes[box.boxId || box.id]?.fieldVersion)
      })),
      groupFieldVersion: bump(extra.groupFieldVersion ?? this.serverSnapshot().groups[groupId]?.fieldVersion),
      vehicleId: extra.vehicleId ?? manifest.vehicleId,
      appointmentId: extra.appointmentId ?? manifest.appointmentId,
      occurredAt: extra.occurredAt || now()
    });
  }

  addEvents(manifestId, events) {
    return this.dispatch('ADD_BOX_EVENTS', { manifestId, events, occurredAt: now() });
  }

  confirmReceipt(manifestId, boxId, sampleQuantity, receiver, extra = {}) {
    return this.dispatch('CONFIRM_RECEIPT', {
      manifestId,
      boxId,
      sampleQuantity,
      receiver,
      handoverId: extra.handoverId,
      receivedAt: extra.receivedAt || now(),
      note: extra.note
    });
  }

  resolveException(exceptionId, resolution) {
    return this.dispatch('RESOLVE_EXCEPTION', { exceptionId, resolution });
  }
}

function sanitizePayload(payload) {
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function withBumpedVersions(existingVersions = {}, fields) {
  const fieldVersions = {};
  for (const key of Object.keys(fields)) {
    fieldVersions[key] = bump(existingVersions[key]);
  }
  return { ...fields, fieldVersions };
}
