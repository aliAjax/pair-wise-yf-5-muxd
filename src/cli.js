#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { LocalStation, SyncServer, initialState } from './index.js';

const ROOT = process.env.COLD_CHAIN_HOME || path.join(process.cwd(), '.cold-chain');
const SERVER_FILE = path.join(ROOT, 'server.json');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function serverStore() {
  fs.mkdirSync(ROOT, { recursive: true });
  return new JsonStore(SERVER_FILE);
}

function station(nodeId) {
  fs.mkdirSync(ROOT, { recursive: true });
  return new LocalStation(nodeId, new JsonStore(path.join(ROOT, `${nodeId}.json`)));
}

function json(value) {
  return JSON.parse(value);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function summary(state) {
  const openExceptions = state.exceptions.filter((item) => item.status === 'OPEN');
  return {
    vehicles: Object.keys(state.vehicles).length,
    appointments: Object.keys(state.appointments).length,
    manifests: Object.keys(state.manifests).length,
    officialBoxes: Object.keys(state.boxes).length,
    quarantinedGroups: Object.keys(state.quarantined).length,
    events: state.events.length,
    acceptedReceipts: state.receipts.filter((r) => r.status === 'ACCEPTED').length,
    quarantinedReceipts: state.receipts.filter((r) => r.status === 'QUARANTINED').length,
    openExceptions: openExceptions.length,
    exceptionBoard: openExceptions.map((e) => ({
      id: e.id,
      type: e.type,
      manifestId: e.manifestId,
      groupId: e.groupId,
      boxId: e.boxId,
      earliestBlockingManifest: e.earliestBlockingManifest,
      message: e.message
    }))
  };
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  switch (command) {
    case 'init': {
      fs.mkdirSync(ROOT, { recursive: true });
      if (!fs.existsSync(SERVER_FILE)) new JsonStore(SERVER_FILE).write(initialState());
      print({ ok: true, home: ROOT });
      break;
    }
    case 'vehicle': {
      const node = station(flags.node || 'dispatch-1');
      node.upsertVehicle(rest[0], {
        name: flags.name || rest[0],
        boxCapacity: Number(flags.boxes || flags.boxCapacity || 0),
        sampleCapacity: Number(flags.samples || flags.sampleCapacity || 0),
        active: true
      });
      print({ ok: true, queued: true, hint: 'run sync --node dispatch-1' });
      break;
    }
    case 'appointment': {
      const node = station(flags.node || 'dispatch-1');
      node.upsertAppointment(rest[0], {
        labId: flags.lab,
        sampleCapacity: Number(flags.samples || flags.sampleCapacity || 0),
        windowStart: flags.start,
        windowEnd: flags.end,
        active: true
      });
      print({ ok: true, queued: true });
      break;
    }
    case 'manifest': {
      const node = station(flags.node || 'dispatch-1');
      node.upsertManifest(rest[0], {
        origin: flags.origin,
        destination: flags.destination || flags.lab,
        plannedBoxCount: Number(flags.boxes || 0),
        plannedSampleCount: Number(flags.samples || 0),
        vehicleId: flags.vehicle,
        appointmentId: flags.appointment,
        scheduledAt: flags.at,
        status: 'DRAFT'
      });
      print({ ok: true, queued: true });
      break;
    }
    case 'plan': {
      const node = station(flags.node || 'dispatch-1');
      const op = node.planManifest(rest[0], {
        vehicleId: flags.vehicle,
        appointmentId: flags.appointment,
        plannedBoxCount: flags.boxes === undefined ? undefined : Number(flags.boxes),
        plannedSampleCount: flags.samples === undefined ? undefined : Number(flags.samples)
      });
      print({ ok: true, queued: true, opId: op.id });
      break;
    }
    case 'pack': {
      const node = station(flags.node || `vehicle-${rest[0]}`);
      const op = node.packBoxGroup(rest[0], flags.group || `grp_${rest[0]}`, json(flags.boxes), {
        vehicleId: flags.vehicle,
        appointmentId: flags.appointment
      });
      print({ ok: true, queuedOffline: true, opId: op.id });
      break;
    }
    case 'event': {
      const node = station(flags.node || `vehicle-${rest[0]}`);
      const payload = flags.payload ? json(flags.payload) : {};
      const op = node.addEvents(rest[0], [{
        id: flags.eventId,
        boxId: flags.box,
        deviceSerial: flags.serial,
        type: flags.kind,
        at: flags.at,
        payload
      }]);
      print({ ok: true, queuedOffline: true, opId: op.id });
      break;
    }
    case 'receive': {
      const node = station(flags.node || 'lab-1');
      const op = node.confirmReceipt(rest[0], flags.box, Number(flags.quantity), flags.receiver, {
        handoverId: flags.handover,
        note: flags.note
      });
      print({ ok: true, queued: true, opId: op.id });
      break;
    }
    case 'resolve': {
      const node = station(flags.node || 'dispatch-1');
      const op = node.resolveException(rest[0], flags.note || 'manual reconciliation');
      print({ ok: true, queued: true, opId: op.id });
      break;
    }
    case 'sync': {
      const node = station(flags.node || 'dispatch-1');
      const result = node.sync(new SyncServer(serverStore()));
      print({ ok: true, node: flags.node || 'dispatch-1', results: result, remainingOutbox: node.localSnapshot().outbox.length });
      break;
    }
    case 'pull': {
      const node = station(flags.node || 'vehicle-1');
      const state = node.pull(new SyncServer(serverStore()));
      print(summary(state));
      break;
    }
    case 'outbox': {
      const node = station(flags.node || 'dispatch-1');
      print(node.localSnapshot().outbox);
      break;
    }
    case 'status': {
      const id = rest[0];
      const state = new SyncServer(serverStore()).snapshot();
      if (!id) print(summary(state));
      else print({
        manifest: state.manifests[id] || null,
        groups: Object.fromEntries(Object.entries(state.groups).filter(([, g]) => g.manifestId === id)),
        quarantined: Object.fromEntries(Object.entries(state.quarantined).filter(([, g]) => g.manifestId === id)),
        boxes: Object.fromEntries(Object.entries(state.boxes).filter(([, b]) => b.manifestId === id)),
        events: state.events.filter((e) => e.manifestId === id),
        receipts: state.receipts.filter((r) => r.manifestId === id),
        exceptions: state.exceptions.filter((e) => e.manifestId === id || e.subjects?.includes(`manifest:${id}`))
      });
      break;
    }
    default:
      process.stdout.write(`离线冷链交接台\n\n用法: cold-chain <command> [id] [--flags]\n\n命令:\n  init\n  vehicle V1 --name 冷链1 --boxes 40 --samples 400\n  appointment A1 --lab L1 --samples 200 --start ... --end ...\n  manifest M1 --origin 站点 --destination 山区 --boxes 10 --samples 100 --vehicle V1 --appointment A1\n  plan M1 --vehicle V1 --appointment A1 --boxes 10 --samples 100\n  pack M1 --group G1 --boxes '[{"boxId":"B1","deviceSerial":"D1","sampleCount":10}]'\n  event M1 --box B1 --kind ICE_REPLENISHED\n  event M1 --box B1 --kind TEMP_ABNORMAL --payload '{"minTemperature":-1,"maxTemperature":9}'\n  receive M1 --box B1 --quantity 10 --receiver 李医生\n  sync --node dispatch-1\n  outbox --node vehicle-1\n  status [M1]\n  resolve EXC_ID --note 已人工核对\n`);
  }
}

main();
