import { MemoryStore } from './store.js';
import { bump, compareVersion, integer, now, randomId, requireString, stableSortBy } from './util.js';

const MANIFEST_FIELDS = ['origin', 'destination', 'plannedBoxCount', 'plannedSampleCount', 'vehicleId', 'appointmentId', 'scheduledAt', 'status'];
const VEHICLE_FIELDS = ['name', 'boxCapacity', 'sampleCapacity', 'active'];
const APPOINTMENT_FIELDS = ['labId', 'sampleCapacity', 'windowStart', 'windowEnd', 'active'];

const EVENT_TYPES = new Set(['PACK', 'ICE_REPLENISHED', 'BOX_OPENED', 'TEMP_ABNORMAL']);

export function initialState() {
  return {
    vehicles: {},
    appointments: {},
    manifests: {},
    boxes: {},
    groups: {},
    events: [],
    receipts: [],
    quarantined: {},
    exceptions: [],
    appliedOps: {}
  };
}

function ensureState(input) {
  const base = initialState();
  const state = { ...base, ...(input || {}) };
  for (const key of Object.keys(base)) {
    if (state[key] === undefined) state[key] = structuredClone(base[key]);
  }
  return state;
}

export class SyncServer {
  constructor(store = new MemoryStore(initialState())) {
    this.store = store;
    this.clock = now;
  }

  snapshot() {
    return ensureState(this.store.read());
  }

  applyBatch(ops) {
    if (!Array.isArray(ops)) throw new Error('ops must be an array');
    const results = [];
    const state = ensureState(this.store.read());
    for (const op of ops) results.push(this.#apply(state, op));
    this.store.write(state);
    return results;
  }

  #commit(state) {
    this.store.write(ensureState(state));
  }

  #apply(state, inputOp) {
    let op;
    try {
      op = normalizeOp(inputOp);
    } catch (error) {
      return { ok: false, status: 'rejected', errors: [error.message] };
    }

    const cached = state.appliedOps[op.id];
    if (cached) return structuredClone(cached);

    const at = op.at || this.clock();
    try {
      switch (op.type) {
        case 'UPSERT_VEHICLE': return this.#upsertVehicle(state, op, at);
        case 'UPSERT_APPOINTMENT': return this.#upsertAppointment(state, op, at);
        case 'UPSERT_MANIFEST': return this.#upsertManifest(state, op, at);
        case 'PLAN_MANIFEST': return this.#planManifest(state, op, at);
        case 'PACK_BOX_GROUP': return this.#packBoxGroup(state, op, at);
        case 'ADD_BOX_EVENTS': return this.#addBoxEvents(state, op, at);
        case 'CONFIRM_RECEIPT': return this.#confirmReceipt(state, op, at);
        case 'RESOLVE_EXCEPTION': return this.#resolveException(state, op, at);
        default:
          return this.#reject(state, op, `unknown operation type ${op.type}`);
      }
    } catch (error) {
      return this.#reject(state, op, error.message);
    }
  }

  #finish(state, op, result) {
    const complete = {
      opId: op.id,
      type: op.type,
      at: this.clock(),
      ...result
    };
    // blocked 是可修复的临时判定：扩容/改约后必须允许原操作重新校验。
    // 真正的重放保护由确定性 opId、异常 ID、handoverId 和箱号唯一约束承担。
    if (complete.status !== 'blocked') {
      state.appliedOps[op.id] = complete;
    }
    return structuredClone(complete);
  }

  #reject(state, op, error) {
    return this.#finish(state, op, { ok: false, status: 'rejected', errors: [error] });
  }

  #upsertVehicle(state, op, at) {
    const fields = selectFields(op.fields, VEHICLE_FIELDS, {
      integer: ['boxCapacity', 'sampleCapacity'],
      boolean: ['active']
    });
    const existing = state.vehicles[op.entityId];
    const base = existing || { id: op.entityId, createdAt: at, fieldVersions: {} };
    const merged = mergeVersionedFields(base, fields, op.type, op.entityId, state, op.id, at);
    merged.updatedAt = at;
    state.vehicles[op.entityId] = merged;
    return this.#finish(state, op, { ok: true, status: merged._changed ? 'applied' : 'applied_noop', entityId: op.entityId, exceptions: merged._exceptionRefs });
  }

  #upsertAppointment(state, op, at) {
    const fields = selectFields(op.fields, APPOINTMENT_FIELDS, {
      integer: ['sampleCapacity'],
      boolean: ['active']
    });
    const existing = state.appointments[op.entityId];
    const base = existing || { id: op.entityId, createdAt: at, fieldVersions: {} };
    const merged = mergeVersionedFields(base, fields, op.type, op.entityId, state, op.id, at);
    merged.updatedAt = at;
    state.appointments[op.entityId] = merged;
    return this.#finish(state, op, { ok: true, status: merged._changed ? 'applied' : 'applied_noop', entityId: op.entityId, exceptions: merged._exceptionRefs });
  }

  #upsertManifest(state, op, at) {
    const fields = selectFields(op.fields, MANIFEST_FIELDS, { integer: ['plannedBoxCount', 'plannedSampleCount'] });
    const existing = state.manifests[op.entityId];
    if (!existing && !existingOrHas(fields, 'origin')) throw new Error('manifest.origin is required');
    if (!existing && !existingOrHas(fields, 'destination')) throw new Error('manifest.destination is required');
    const base = existing || {
      id: op.entityId,
      createdAt: at,
      fieldVersions: {},
      status: 'DRAFT',
      plannedBoxCount: 0,
      plannedSampleCount: 0
    };
    const merged = mergeVersionedFields(base, fields, op.type, op.entityId, state, op.id, at);
    merged.updatedAt = at;
    state.manifests[op.entityId] = merged;
    return this.#finish(state, op, { ok: true, status: merged._changed ? 'applied' : 'applied_noop', entityId: op.entityId, exceptions: merged._exceptionRefs });
  }

  #planManifest(state, op, at) {
    const manifest = state.manifests[op.manifestId];
    if (!manifest) throw new Error(`manifest ${op.manifestId} not found`);
    const vehicleId = op.vehicleId || manifest.vehicleId;
    const appointmentId = op.appointmentId || manifest.appointmentId;
    const vehicle = state.vehicles[vehicleId];
    if (!vehicleId || !vehicle) return this.#blockPlanning(state, op, at, 'missing_vehicle', `vehicle ${vehicleId || '(unset)'} not found`);
    const appointment = state.appointments[appointmentId];
    if (!appointmentId || !appointment) return this.#blockPlanning(state, op, at, 'missing_appointment', `appointment ${appointmentId || '(unset)'} not found`);

    const planned = {
      ...manifest,
      vehicleId,
      appointmentId,
      plannedBoxCount: integer(op.plannedBoxCount ?? manifest.plannedBoxCount, { name: 'plannedBoxCount' }),
      plannedSampleCount: integer(op.plannedSampleCount ?? manifest.plannedSampleCount, { name: 'plannedSampleCount' }),
      status: 'PLANNED',
      plannedAt: at
    };

    const vehicleBlocker = usageProjection(state, { manifestId: manifest.id, vehicleId, vehicleDelta: planned, at }).vehicleOverflow?.earliest;
    if (vehicleBlocker) return this.#blockPlanning(state, op, at, 'vehicle_capacity_full', `vehicle ${vehicleId} capacity exceeded`, vehicleBlocker);

    const appointmentBlocker = usageProjection(state, { manifestId: manifest.id, appointmentId, appointmentDelta: planned, at }).appointmentOverflow?.earliest;
    if (appointmentBlocker) return this.#blockPlanning(state, op, at, 'appointment_full', `appointment ${appointmentId} is full`, appointmentBlocker);

    state.manifests[manifest.id] = {
      ...planned,
      fieldVersions: {
        ...(planned.fieldVersions || {}),
        plannedBoxCount: Number(planned.fieldVersions?.plannedBoxCount || 0) + 1,
        plannedSampleCount: Number(planned.fieldVersions?.plannedSampleCount || 0) + 1,
        vehicleId: Number(planned.fieldVersions?.vehicleId || 0) + 1,
        appointmentId: Number(planned.fieldVersions?.appointmentId || 0) + 1,
        status: Number(planned.fieldVersions?.status || 0) + 1
      },
      updatedAt: at,
      planOpId: op.id,
      lastConfirmed: {
        status: 'PLANNED',
        at,
        opId: op.id,
        plannedBoxCount: planned.plannedBoxCount,
        plannedSampleCount: planned.plannedSampleCount,
        vehicleId,
        appointmentId
      }
    };
    this.#resolveOpenBySubjects(state, [`manifest:${manifest.id}`], op.id, at);
    return this.#finish(state, op, { ok: true, status: 'applied', manifestId: manifest.id, vehicleId, appointmentId });
  }

  #blockPlanning(state, op, at, reason, message, earliestBlockingManifest = null) {
    const existing = state.manifests[op.manifestId];
    const exception = addException(state, {
      id: `exc_${op.id}`,
      type: reason,
      severity: 'BLOCKED',
      status: 'OPEN',
      message,
      opId: op.id,
      at,
      subjects: [`manifest:${op.manifestId}`],
      earliestBlockingManifest,
      lastConfirmedResult: existing?.lastConfirmed || null
    });
    if (existing) {
      state.manifests[op.manifestId] = { ...existing, planningRejectedAt: at, planningRejectionReason: reason, updatedAt: at };
    }
    return this.#finish(state, op, { ok: false, status: 'blocked', manifestId: op.manifestId, exceptions: [exception.id], earliestBlockingManifest });
  }

  #packBoxGroup(state, op, at) {
    const manifest = state.manifests[op.manifestId];
    if (!manifest) throw new Error(`manifest ${op.manifestId} not found`);
    if (!Array.isArray(op.boxes) || op.boxes.length === 0) throw new Error('boxes must contain at least one box');

    const incoming = op.boxes.map((box) => normalizePackedBox(box, op, at));
    const conflicts = detectBoxConflicts(state, op.manifestId, incoming);
    const vehicleId = op.vehicleId || manifest.vehicleId;
    const appointmentId = op.appointmentId || manifest.appointmentId;
    const group = {
      id: op.groupId,
      manifestId: op.manifestId,
      vehicleId: vehicleId || null,
      appointmentId: appointmentId || null,
      opId: op.id,
      nodeId: op.nodeId,
      status: 'PACKED',
      boxIds: incoming.map((box) => box.id),
      boxes: incoming,
      sampleCount: incoming.reduce((sum, box) => sum + box.sampleCount, 0),
      packedAt: op.occurredAt || at,
      fieldVersion: integer(op.groupFieldVersion ?? 1, { name: 'groupFieldVersion' }),
      createdAt: at
    };

    if (conflicts.length) return this.#quarantineGroup(state, op, at, group, incoming, 'data_conflict', conflicts);

    if (!vehicleId || !state.vehicles[vehicleId]) {
      return this.#quarantineGroup(state, op, at, group, incoming, 'missing_vehicle', [], null, {
        resource: vehicleId ? `vehicle:${vehicleId}` : 'vehicle:(unset)'
      });
    }
    if (!appointmentId || !state.appointments[appointmentId]) {
      return this.#quarantineGroup(state, op, at, group, incoming, 'missing_appointment', [], null, {
        resource: appointmentId ? `appointment:${appointmentId}` : 'appointment:(unset)'
      });
    }

    const overflow = usageProjection(state, {
      manifestId: op.manifestId,
      vehicleId,
      appointmentId,
      incomingGroup: group,
      at
    });

    if (vehicleId && overflow.vehicleOverflow) {
      return this.#quarantineGroup(state, op, at, group, incoming, 'vehicle_capacity_full', [], overflow.vehicleOverflow.earliest, {
        resource: `vehicle:${vehicleId}`,
        capacity: overflow.vehicleOverflow.capacity,
        used: overflow.vehicleOverflow.used
      });
    }
    if (appointmentId && overflow.appointmentOverflow) {
      return this.#quarantineGroup(state, op, at, group, incoming, 'appointment_full', [], overflow.appointmentOverflow.earliest, {
        resource: `appointment:${appointmentId}`,
        capacity: overflow.appointmentOverflow.capacity,
        used: overflow.appointmentOverflow.used
      });
    }

    state.groups[group.id] = group;
    for (const box of incoming) state.boxes[box.id] = box;
    const events = incoming.map((box) => ({
      id: randomId('evt'),
      opId: op.id,
      boxId: box.id,
      manifestId: op.manifestId,
      groupId: group.id,
      deviceSerial: box.deviceSerial,
      type: 'PACK',
      at: box.packedAt,
      nodeId: op.nodeId,
      payload: { sampleCount: box.sampleCount, fieldVersion: box.fieldVersion }
    }));
    state.events.push(...events);
    state.manifests[op.manifestId] = {
      ...manifest,
      status: manifest.status === 'RECEIVED' ? 'RECEIVED' : 'IN_TRANSIT',
      vehicleId: vehicleId || manifest.vehicleId || null,
      appointmentId: appointmentId || manifest.appointmentId || null,
      packedGroupIds: unique([...(manifest.packedGroupIds || []), group.id]),
      actualBoxCount: countOfficialBoxes(state, op.manifestId),
      actualSampleCount: sumOfficialBoxSamples(state, op.manifestId),
      lastConfirmed: { status: 'PACKED', at, opId: op.id, groupId: group.id },
      updatedAt: at
    };
    delete state.quarantined[group.id];
    this.#resolveOpenBySubjects(state, [`manifest:${op.manifestId}`, `group:${group.id}`, ...group.boxIds.map((id) => `box:${id}`)], op.id, at);
    return this.#finish(state, op, { ok: true, status: 'applied', groupId: group.id, manifestId: op.manifestId });
  }

  #quarantineGroup(state, op, at, group, incoming, reason, conflicts = [], earliestBlockingManifest = null, capacityInfo = null) {
    const quarantine = {
      ...group,
      status: 'QUARANTINED',
      quarantineReason: reason,
      conflicts,
      boxes: incoming,
      earliestBlockingManifest,
      capacity: capacityInfo,
      quarantinedAt: at
    };
    state.quarantined[group.id] = quarantine;
    const existingManifest = state.manifests[op.manifestId];
    const exception = addException(state, {
      id: `exc_${op.id}`,
      type: reason,
      severity: 'QUARANTINED',
      status: 'OPEN',
      message: reason === 'data_conflict' ? 'box identity or handover quantity diverges' : 'capacity or appointment limit blocks box group',
      opId: op.id,
      at,
      subjects: [`manifest:${op.manifestId}`, `group:${group.id}`, ...incoming.map((box) => `box:${box.id}`)],
      groupId: group.id,
      manifestId: op.manifestId,
      candidate: quarantine,
      conflicts,
      earliestBlockingManifest,
      capacity: capacityInfo,
      lastConfirmedResult: latestConfirmedResult(state, op.manifestId, group.id)
    });
    state.manifests[op.manifestId] = {
      ...existingManifest,
      status: existingManifest.status === 'RECEIVED' ? 'RECEIVED' : existingManifest.status || 'DRAFT',
      quarantinedGroupIds: unique([...(existingManifest.quarantinedGroupIds || []), group.id]),
      updatedAt: at
    };
    return this.#finish(state, op, {
      ok: false,
      status: 'blocked',
      quarantine: true,
      groupId: group.id,
      manifestId: op.manifestId,
      exceptions: [exception.id],
      conflicts,
      earliestBlockingManifest
    });
  }

  #addBoxEvents(state, op, at) {
    const manifest = state.manifests[op.manifestId];
    if (!manifest) throw new Error(`manifest ${op.manifestId} not found`);
    if (!Array.isArray(op.events)) throw new Error('events must be an array');
    const added = [];
    const warnings = [];
    for (const item of op.events) {
      const type = requireString(item.type, 'event.type');
      if (!EVENT_TYPES.has(type) || type === 'PACK') throw new Error(`event type ${type} is not allowed here`);
      const boxId = requireString(item.boxId, 'event.boxId');
      const eventAt = requireString(item.at || op.occurredAt || at, 'event.at');
      const id = item.id || randomId('evt');
      const duplicate = state.events.find((event) => event.id === id || (
        event.opId === op.id && event.boxId === boxId && event.type === type && event.at === eventAt
      ));
      if (duplicate) {
        added.push(duplicate.id);
        continue;
      }
      const box = state.boxes[boxId];
      if (!box || box.manifestId !== op.manifestId) {
        warnings.push({ code: 'detached_event', boxId, reason: 'box is not officially packed under this manifest' });
      }
      const event = {
        id,
        opId: op.id,
        boxId,
        manifestId: op.manifestId,
        groupId: item.groupId || box?.groupId || null,
        deviceSerial: item.deviceSerial || box?.deviceSerial || null,
        type,
        at: eventAt,
        nodeId: op.nodeId,
        payload: item.payload || {},
        detached: !box || box.manifestId !== op.manifestId
      };
      if (type === 'TEMP_ABNORMAL') {
        const min = Number(event.payload.minTemperature);
        const max = Number(event.payload.maxTemperature);
        if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('TEMP_ABNORMAL requires minTemperature and maxTemperature');
        event.acknowledged = false;
      }
      state.events.push(event);
      added.push(id);
    }
    return this.#finish(state, op, { ok: true, status: warnings.length ? 'applied_with_warnings' : 'applied', eventIds: added, warnings });
  }

  #confirmReceipt(state, op, at) {
    const manifest = state.manifests[op.manifestId];
    if (!manifest) throw new Error(`manifest ${op.manifestId} not found`);
    const boxId = requireString(op.boxId, 'boxId');
    const quantity = integer(op.sampleQuantity, { name: 'sampleQuantity', min: 0 });
    const receiver = requireString(op.receiver, 'receiver');
    const receivedAt = requireString(op.receivedAt || op.occurredAt || at, 'receivedAt');
    const handoverId = op.handoverId || op.id;
    const duplicate = state.receipts.find((receipt) => receipt.handoverId === handoverId && receipt.status !== 'QUARANTINED');
    if (duplicate) {
      return this.#finish(state, op, { ok: true, status: 'applied_duplicate', receiptId: duplicate.id, handoverCountDelta: 0 });
    }
    const priorCandidate = state.receipts.find((receipt) => receipt.handoverId === handoverId && receipt.status === 'QUARANTINED');
    if (priorCandidate) {
      return this.#finish(state, op, {
        ok: false,
        status: 'blocked',
        receiptId: priorCandidate.id,
        handoverCountDelta: 0,
        exceptions: state.exceptions.filter((e) => e.opId === op.id).map((e) => e.id),
        conflicts: [priorCandidate.conflict].filter(Boolean)
      });
    }

    const box = state.boxes[boxId];
    const receipt = {
      id: randomId('rcpt'),
      handoverId,
      opId: op.id,
      manifestId: op.manifestId,
      boxId,
      groupId: box?.groupId || op.groupId || null,
      deviceSerial: op.deviceSerial || box?.deviceSerial || null,
      sampleQuantity: quantity,
      receiver,
      receivedAt,
      nodeId: op.nodeId,
      status: 'ACCEPTED',
      note: op.note || '',
      createdAt: at
    };

    let conflict = null;
    if (!box || box.manifestId !== op.manifestId) {
      conflict = { code: 'unknown_box', boxId, serverVersion: null, incomingVersion: quantity };
    } else if (box.sampleCount !== quantity) {
      conflict = { code: 'quantity_mismatch', boxId, packedQuantity: box.sampleCount, receivedQuantity: quantity };
    } else {
      const prior = stableSortBy(state.receipts.filter((r) => r.boxId === boxId && r.status !== 'QUARANTINED'), (r) => r.receivedAt)[0];
      if (prior) conflict = { code: 'already_received', boxId, priorReceiptId: prior.id, incomingReceiptId: receipt.id };
    }

    if (conflict) {
      receipt.status = 'QUARANTINED';
      receipt.conflict = conflict;
      state.receipts.push(receipt);
      const exception = addException(state, {
        id: `exc_${op.id}`,
        type: 'receipt_conflict',
        severity: 'RECONCILE',
        status: 'OPEN',
        message: 'receipt quantity or box identity differs; both versions retained',
        opId: op.id,
        at,
        subjects: [`manifest:${op.manifestId}`, `box:${boxId}`],
        manifestId: op.manifestId,
        boxId,
        versions: {
          receivedRecord: structuredClone(receipt),
          serverBox: box ? structuredClone(box) : null
        },
        conflict
      });
      return this.#finish(state, op, {
        ok: false,
        status: 'blocked',
        receiptId: receipt.id,
        handoverCountDelta: 0,
        exceptions: [exception.id],
        conflicts: [conflict]
      });
    }

    state.receipts.push(receipt);
    state.boxes[boxId] = { ...box, received: true, receivedAt, receiver, receiptId: receipt.id };
    const receivedBoxes = new Set(state.receipts.filter((r) => r.status === 'ACCEPTED' && r.manifestId === manifest.id).map((r) => r.boxId));
    const allReceived = manifest.actualBoxCount > 0 && receivedBoxes.size >= manifest.actualBoxCount;
    state.manifests[manifest.id] = {
      ...manifest,
      status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
      officialHandoverCount: countOfficialHandovers(state, manifest.id),
      receivedBoxIds: [...receivedBoxes],
      lastConfirmed: { status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED', at, opId: op.id, boxId },
      updatedAt: at
    };
    this.#resolveOpenBySubjects(state, [`box:${boxId}`], op.id, at);
    return this.#finish(state, op, { ok: true, status: 'applied', receiptId: receipt.id, handoverCountDelta: 1 });
  }

  #resolveException(state, op, at) {
    const exception = state.exceptions.find((item) => item.id === op.exceptionId && item.status === 'OPEN');
    if (!exception) throw new Error(`open exception ${op.exceptionId} not found`);
    exception.status = 'RESOLVED_MANUAL';
    exception.resolvedAt = at;
    exception.resolution = op.resolution || 'manual reconciliation';
    exception.resolvedBy = op.nodeId;
    return this.#finish(state, op, { ok: true, status: 'applied', exceptionId: exception.id });
  }

  #resolveOpenBySubjects(state, subjects, resolvedBy, at) {
    const set = new Set(subjects);
    for (const exception of state.exceptions) {
      if (exception.status !== 'OPEN') continue;
      if ((exception.subjects || []).some((subject) => set.has(subject))) {
        exception.status = 'RESOLVED_AUTO';
        exception.resolvedAt = at;
        exception.resolvedBy = resolvedBy;
        exception.resolution = 'blocking condition cleared by idempotent retry';
      }
    }
  }
}

function normalizeOp(op) {
  if (!op || typeof op !== 'object') throw new Error('operation must be an object');
  const normalized = { ...op, id: op.id || op.opId || randomId('op'), at: op.at, nodeId: op.nodeId || 'unknown-node' };
  if (!normalized.id) throw new Error('operation id is required');
  if (!normalized.type) throw new Error('operation type is required');
  return normalized;
}

function selectFields(input, allowed, options = {}) {
  const source = input || {};
  const output = {};
  if (source.fieldVersions && typeof source.fieldVersions === 'object') output.fieldVersions = source.fieldVersions;
  for (const key of allowed) {
    if (source[key] !== undefined) {
      if (options.integer?.includes(key)) output[key] = integer(source[key], { name: key });
      else if (options.boolean?.includes(key)) output[key] = Boolean(source[key]);
      else output[key] = source[key];
    }
  }
  return output;
}

function existingOrHas(fields, key) {
  return Object.prototype.hasOwnProperty.call(fields, key);
}

function mergeVersionedFields(existing, incomingFields, entityType, entityId, state, opId, at) {
  const out = structuredClone(existing);
  delete out._changed;
  delete out._exceptionRefs;
  out.fieldVersions = { ...(existing.fieldVersions || {}) };
  let changed = false;
  const exceptionRefs = [];
  for (const [key, value] of Object.entries(incomingFields)) {
    if (key === 'fieldVersions') continue;
    const incomingVersion = Number(incomingFields.fieldVersions?.[key] ?? incomingFields[`${key}Version`] ?? existing.fieldVersions[key] ?? 1);
    const currentVersion = Number(out.fieldVersions[key] || 0);
    if (incomingVersion < currentVersion) continue;
    if (incomingVersion === currentVersion && currentVersion !== 0 && Object.prototype.hasOwnProperty.call(out, key) && out[key] !== undefined && JSON.stringify(out[key]) !== JSON.stringify(value)) {
      const ref = addException(state, {
        id: `exc_${opId}_${key}`,
        type: 'field_version_conflict',
        severity: 'RECONCILE',
        status: 'OPEN',
        message: `${entityType} ${entityId}.${key} changed at the same field version`,
        opId,
        at,
        subjects: [`${entityType.toLowerCase().replace('upsert_', '')}:${entityId}`],
        field: key,
        fieldVersion: incomingVersion,
        versions: { server: out[key], incoming: value }
      });
      exceptionRefs.push(ref);
      changed = true;
      continue;
    }
    if (JSON.stringify(out[key]) !== JSON.stringify(value) || currentVersion === 0) changed = true;
    out[key] = value;
    out.fieldVersions[key] = incomingVersion;
  }
  out._changed = changed;
  out._exceptionRefs = exceptionRefs;
  return out;
}

function addException(state, exception) {
  const id = exception.id;
  const existing = state.exceptions.find((item) => item.id === id);
  if (existing) return existing;
  state.exceptions.push({ ...exception, id });
  return state.exceptions[state.exceptions.length - 1];
}

function normalizePackedBox(box, op, at) {
  const id = requireString(box.boxId || box.id, 'box.boxId');
  const deviceSerial = requireString(box.deviceSerial, 'box.deviceSerial');
  const sampleCount = integer(box.sampleCount, { name: 'box.sampleCount' });
  return {
    id,
    deviceSerial,
    manifestId: op.manifestId,
    groupId: op.groupId,
    sampleCount,
    sampleType: box.sampleType || '',
    fieldVersion: integer(box.fieldVersion ?? 1, { name: 'box.fieldVersion' }),
    nodeId: op.nodeId,
    packedAt: box.packedAt || op.occurredAt || at,
    received: false
  };
}

function detectBoxConflicts(state, manifestId, incoming) {
  const conflicts = [];
  const localSeen = new Map();
  for (const box of incoming) {
    if (localSeen.has(box.id)) {
      conflicts.push({ code: 'duplicate_box_in_group', boxId: box.id, versions: [localSeen.get(box.id), box] });
    } else {
      localSeen.set(box.id, box);
    }
    const existing = state.boxes[box.id];
    if (existing) {
      if (existing.manifestId !== manifestId) {
        conflicts.push({ code: 'box_assigned_to_other_manifest', boxId: box.id, serverManifestId: existing.manifestId, incomingManifestId: manifestId });
      } else if (existing.sampleCount !== box.sampleCount || existing.deviceSerial !== box.deviceSerial || compareVersion(existing.fieldVersion, box.fieldVersion) > 0) {
        conflicts.push({
          code: 'box_record_diverges',
          boxId: box.id,
          serverVersion: structuredClone(existing),
          incomingVersion: structuredClone(box)
        });
      }
    }
  }
  return conflicts;
}

function plannedManifestIds(state) {
  return Object.values(state.manifests)
    .filter((manifest) => ['PLANNED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(manifest.status))
    .map((manifest) => manifest.id);
}

function officialManifestIds(state, includeId = null) {
  return [...new Set([...plannedManifestIds(state), includeId].filter(Boolean))];
}

function billableBoxCount(state, manifestId) {
  const manifest = state.manifests[manifestId];
  const actual = countOfficialBoxes(state, manifestId);
  return Math.max(Number(manifest?.plannedBoxCount || 0), actual);
}

function billableSampleCount(state, manifestId) {
  const manifest = state.manifests[manifestId];
  const actual = sumOfficialBoxSamples(state, manifestId);
  return Math.max(Number(manifest?.plannedSampleCount || 0), actual);
}

function countOfficialBoxes(state, manifestId) {
  return new Set(Object.values(state.boxes).filter((box) => box.manifestId === manifestId).map((box) => box.id)).size;
}

function sumOfficialBoxSamples(state, manifestId) {
  return Object.values(state.boxes).filter((box) => box.manifestId === manifestId).reduce((sum, box) => sum + box.sampleCount, 0);
}

function countOfficialHandovers(state, manifestId) {
  return state.receipts.filter((receipt) => receipt.manifestId === manifestId && receipt.status === 'ACCEPTED').length;
}

function usageProjection(state, { manifestId, vehicleId, appointmentId, vehicleDelta = null, appointmentDelta = null, incomingGroup = null, at = now() }) {
  const ids = new Set(officialManifestIds(state, manifestId));
  ids.add(manifestId);
  let vehicleBoxes = 0;
  let vehicleSamples = 0;
  let appointmentSamples = 0;
  const vehicleContributors = [];
  const appointmentContributors = [];

  for (const id of ids) {
    const manifest = id === manifestId && vehicleDelta ? vehicleDelta : state.manifests[id];
    let boxes = billableBoxCount(state, id);
    let samples = billableSampleCount(state, id);
    if (id === manifestId && incomingGroup) {
      const addedBoxes = incomingGroup.boxIds.filter((boxId) => !state.boxes[boxId]).length;
      const addedSamples = incomingGroup.boxes
        .filter((box) => !state.boxes[box.id])
        .reduce((sum, box) => sum + box.sampleCount, 0);
      boxes += addedBoxes;
      samples += addedSamples;
    }
    if (manifest?.vehicleId === vehicleId && vehicleId) {
      vehicleBoxes += boxes;
      vehicleSamples += samples;
      vehicleContributors.push({ manifestId: id, manifestStatus: manifest.status, plannedAt: manifest.plannedAt || manifest.createdAt || at, boxes, samples });
    }
    const appointmentManifest = id === manifestId && appointmentDelta ? appointmentDelta : manifest;
    if (appointmentManifest?.appointmentId === appointmentId && appointmentId) {
      appointmentSamples += samples;
      appointmentContributors.push({ manifestId: id, manifestStatus: appointmentManifest.status, plannedAt: appointmentManifest.plannedAt || appointmentManifest.createdAt || at, samples });
    }
  }

  const vehicle = state.vehicles[vehicleId];
  const appointment = state.appointments[appointmentId];
  let vehicleOverflow = null;
  let appointmentOverflow = null;
  if (vehicleId && vehicle) {
    const overBoxes = vehicleBoxes > vehicle.boxCapacity;
    const overSamples = vehicleSamples > vehicle.sampleCapacity;
    if (overBoxes || overSamples) {
      vehicleOverflow = {
        capacity: { boxes: vehicle.boxCapacity, samples: vehicle.sampleCapacity },
        used: { boxes: vehicleBoxes, samples: vehicleSamples },
        earliest: earliestContributor(vehicleContributors, manifestId)
      };
    }
  }
  if (appointmentId && appointment && appointmentSamples > appointment.sampleCapacity) {
    appointmentOverflow = {
      capacity: appointment.sampleCapacity,
      used: appointmentSamples,
      earliest: earliestContributor(appointmentContributors, manifestId)
    };
  }
  return { vehicleOverflow, appointmentOverflow, vehicleBoxes, vehicleSamples, appointmentSamples };
}

function earliestContributor(contributors, currentManifestId) {
  const others = contributors.filter((item) => item.manifestId !== currentManifestId);
  const sorted = stableSortBy(others.length ? others : contributors, (item) => item.plannedAt || '');
  return sorted[0]?.manifestId || null;
}

function latestConfirmedResult(state, manifestId, groupId) {
  const manifest = state.manifests[manifestId];
  const group = state.groups[groupId];
  return structuredClone(manifest?.lastConfirmed || group || null);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export const __test = {
  usageProjection,
  normalizePackedBox,
  detectBoxConflicts,
  countOfficialHandovers
};
