// SQLite 数据层：车辆、实验室、预约、转运单、箱组、字段版本、事件流水、待核异常
const Database = require('better-sqlite3');

function initDb(file = ':memory:') {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
  CREATE TABLE IF NOT EXISTS vehicles (
    vehicle_id   TEXT PRIMARY KEY,
    plate        TEXT NOT NULL,
    capacity     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS labs (
    lab_id   TEXT PRIMARY KEY,
    name     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS appointments (
    appointment_id TEXT PRIMARY KEY,
    lab_id         TEXT NOT NULL REFERENCES labs(lab_id),
    slot           TEXT NOT NULL,
    capacity       INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    order_no       TEXT PRIMARY KEY,
    route          TEXT,
    vehicle_id     TEXT REFERENCES vehicles(vehicle_id),
    appointment_id TEXT REFERENCES appointments(appointment_id),
    planned_qty    INTEGER,
    planned_boxes  INTEGER,
    status         TEXT NOT NULL DEFAULT 'open',
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS boxes (
    box_no         TEXT PRIMARY KEY,
    order_no       TEXT NOT NULL REFERENCES orders(order_no),
    device_serial  TEXT,
    status         TEXT NOT NULL DEFAULT 'packed',
    qty            INTEGER,
    handover_qty   INTEGER,
    ice_qty        INTEGER,
    temp           REAL,
    handover_count INTEGER NOT NULL DEFAULT 0,
    isolated       INTEGER NOT NULL DEFAULT 0,
    updated_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS box_fields (
    box_no     TEXT NOT NULL REFERENCES boxes(box_no),
    field      TEXT NOT NULL,
    value      TEXT,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (box_no, field)
  );
  CREATE TABLE IF NOT EXISTS events (
    event_id      TEXT PRIMARY KEY,
    order_no      TEXT,
    box_no        TEXT,
    device_serial TEXT,
    type          TEXT,
    payload       TEXT,
    occurred_at   INTEGER,
    received_at   INTEGER,
    status        TEXT,            -- applied | conflict | isolated | rejected
    reason        TEXT,
    anomaly_id    TEXT
  );
  CREATE TABLE IF NOT EXISTS anomalies (
    anomaly_id        TEXT PRIMARY KEY,
    order_no          TEXT,
    box_no            TEXT,
    type              TEXT NOT NULL,  -- box_mismatch | qty_mismatch | field_conflict | capacity | appointment | temp
    severity          TEXT NOT NULL DEFAULT 'warning',
    title             TEXT NOT NULL,
    dispatch_version  TEXT,
    vehicle_version   TEXT,
    blocking_order_no TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending | resolved
    resolution        TEXT,
    resolved_at       INTEGER,
    created_at        INTEGER NOT NULL
  );
  `);
  return db;
}

module.exports = { initDb };
