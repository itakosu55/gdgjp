import { EMPTY_SETUP_DOC, type SetupDoc, safeParseSetupDoc } from "~/lib/av/schema";
import type {
  Device,
  DeviceCategory,
  DeviceModel,
  DeviceModelBus,
  DeviceModelPort,
} from "~/lib/av/types";
import { newId } from "~/lib/id";

/**
 * No ORM, same shape as the other RPs: snake_case `*Row` types, `to*` mappers,
 * and column-list constants reused across queries. Keep new queries here.
 */

// ─── Catalog: 型番カタログ ─────────────────────────────────────────────────────

type ModelRow = {
  id: string;
  maker: string | null;
  name: string;
  category: string;
  internal_routing: string;
  echo_cancels: number;
  notes: string | null;
};

type BusRow = {
  id: string;
  model_id: string;
  key: string;
  label: string;
  kind: string;
  sort_order: number;
};

type PortRow = {
  id: string;
  model_id: string;
  key: string;
  label: string;
  direction: string;
  signal: string;
  connector: string;
  level: string | null;
  channels: number;
  phantom: string;
  bus_key: string | null;
  couples: string | null;
  expandable: number;
  source_key: string | null;
  origin: number;
  sort_order: number;
};

type RouteRow = { model_id: string; in_port: string; bus: string };

const MODEL_COLS = "id, maker, name, category, internal_routing, echo_cancels, notes";
const BUS_COLS = "id, model_id, key, label, kind, sort_order";
const PORT_SELECT = `SELECT p.id, p.model_id, p.key, p.label, p.direction, p.signal, p.connector,
         p.level, p.channels, p.phantom, p.couples, p.expandable, p.source_key, p.origin,
         p.sort_order, b.key AS bus_key
  FROM device_model_ports p
  LEFT JOIN device_model_buses b ON b.id = p.bus_id`;
const ROUTE_SELECT = `SELECT r.model_id, p.key AS in_port, b.key AS bus
  FROM device_model_default_routes r
  JOIN device_model_ports p ON p.id = r.in_port_id
  JOIN device_model_buses b ON b.id = r.bus_id`;

function toBus(row: BusRow): DeviceModelBus {
  return { key: row.key, label: row.label, kind: row.kind as DeviceModelBus["kind"] };
}

function toPort(row: PortRow): DeviceModelPort {
  return {
    key: row.key,
    label: row.label,
    direction: row.direction as DeviceModelPort["direction"],
    signal: row.signal as DeviceModelPort["signal"],
    connector: row.connector as DeviceModelPort["connector"],
    level: row.level as DeviceModelPort["level"],
    channels: row.channels,
    phantom: row.phantom as DeviceModelPort["phantom"],
    busKey: row.bus_key,
    couples: row.couples as DeviceModelPort["couples"],
    expandable: row.expandable === 1,
    sourceKey: row.source_key,
    origin: row.origin === 1,
  };
}

function assemble(
  models: ModelRow[],
  buses: BusRow[],
  ports: PortRow[],
  routes: RouteRow[],
): DeviceModel[] {
  const byModel = <T extends { model_id: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const list = map.get(row.model_id);
      if (list) list.push(row);
      else map.set(row.model_id, [row]);
    }
    return map;
  };
  const busesBy = byModel(buses);
  const portsBy = byModel(ports);
  const routesBy = byModel(routes);

  return models.map((row) => ({
    id: row.id,
    maker: row.maker,
    name: row.name,
    category: row.category as DeviceCategory,
    internalRouting: row.internal_routing as DeviceModel["internalRouting"],
    echoCancels: row.echo_cancels === 1,
    buses: (busesBy.get(row.id) ?? []).map(toBus),
    ports: (portsBy.get(row.id) ?? []).map(toPort),
    defaultRoutes: (routesBy.get(row.id) ?? []).map((r) => ({ inPort: r.in_port, bus: r.bus })),
  }));
}

export async function listModels(db: D1Database): Promise<DeviceModel[]> {
  const [models, buses, ports, routes] = await db.batch<never>([
    db.prepare(`SELECT ${MODEL_COLS} FROM device_models WHERE deleted_at IS NULL ORDER BY name`),
    db.prepare(`SELECT ${BUS_COLS} FROM device_model_buses ORDER BY sort_order, key`),
    db.prepare(`${PORT_SELECT} ORDER BY p.sort_order, p.key`),
    db.prepare(ROUTE_SELECT),
  ]);
  return assemble(
    models.results as ModelRow[],
    buses.results as BusRow[],
    ports.results as PortRow[],
    routes.results as RouteRow[],
  );
}

export async function getModel(db: D1Database, id: string): Promise<DeviceModel | null> {
  const model = await db
    .prepare(`SELECT ${MODEL_COLS} FROM device_models WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<ModelRow>();
  if (!model) return null;
  const [buses, ports, routes] = await db.batch<never>([
    db
      .prepare(
        `SELECT ${BUS_COLS} FROM device_model_buses WHERE model_id = ? ORDER BY sort_order, key`,
      )
      .bind(id),
    db.prepare(`${PORT_SELECT} WHERE p.model_id = ? ORDER BY p.sort_order, p.key`).bind(id),
    db.prepare(`${ROUTE_SELECT} WHERE r.model_id = ?`).bind(id),
  ]);
  return (
    assemble(
      [model],
      buses.results as BusRow[],
      ports.results as PortRow[],
      routes.results as RouteRow[],
    )[0] ?? null
  );
}

export type ModelInput = {
  maker: string | null;
  name: string;
  category: DeviceCategory;
  internalRouting: DeviceModel["internalRouting"];
  echoCancels: boolean;
  notes: string | null;
};

export async function createModel(
  db: D1Database,
  input: ModelInput,
  userId: string,
): Promise<string> {
  const id = newId("model");
  await db
    .prepare(
      `INSERT INTO device_models (id, maker, name, category, internal_routing, echo_cancels, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.maker,
      input.name,
      input.category,
      input.internalRouting,
      input.echoCancels ? 1 : 0,
      input.notes,
      userId,
    )
    .run();
  return id;
}

export async function updateModel(db: D1Database, id: string, input: ModelInput): Promise<void> {
  await db
    .prepare(
      `UPDATE device_models
       SET maker = ?, name = ?, category = ?, internal_routing = ?, echo_cancels = ?, notes = ?,
           updated_at = unixepoch()
       WHERE id = ?`,
    )
    .bind(
      input.maker,
      input.name,
      input.category,
      input.internalRouting,
      input.echoCancels ? 1 : 0,
      input.notes,
      id,
    )
    .run();
}

export async function softDeleteModel(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE device_models SET deleted_at = unixepoch() WHERE id = ?").bind(id).run();
}

export type PortInput = Omit<DeviceModelPort, "busKey"> & { busKey: string | null };

export async function createPort(db: D1Database, modelId: string, input: PortInput): Promise<void> {
  const busId = input.busKey
    ? ((
        await db
          .prepare("SELECT id FROM device_model_buses WHERE model_id = ? AND key = ?")
          .bind(modelId, input.busKey)
          .first<{ id: string }>()
      )?.id ?? null)
    : null;
  await db
    .prepare(
      `INSERT INTO device_model_ports
       (id, model_id, key, label, direction, signal, connector, level, channels, phantom, bus_id, couples,
        expandable, source_key, origin, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM device_model_ports WHERE model_id = ?))`,
    )
    .bind(
      newId("port"),
      modelId,
      input.key,
      input.label,
      input.direction,
      input.signal,
      input.connector,
      input.level,
      input.channels,
      input.phantom,
      busId,
      input.couples,
      input.expandable ? 1 : 0,
      input.sourceKey,
      input.origin ? 1 : 0,
      modelId,
    )
    .run();
}

export async function deletePort(db: D1Database, modelId: string, key: string): Promise<void> {
  await db
    .prepare("DELETE FROM device_model_ports WHERE model_id = ? AND key = ?")
    .bind(modelId, key)
    .run();
}

export async function createBus(
  db: D1Database,
  modelId: string,
  input: DeviceModelBus,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO device_model_buses (id, model_id, key, label, kind, sort_order)
       VALUES (?, ?, ?, ?, ?,
               (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM device_model_buses WHERE model_id = ?))`,
    )
    .bind(newId("bus"), modelId, input.key, input.label, input.kind, modelId)
    .run();
}

export async function deleteBus(db: D1Database, modelId: string, key: string): Promise<void> {
  await db
    .prepare("DELETE FROM device_model_buses WHERE model_id = ? AND key = ?")
    .bind(modelId, key)
    .run();
}

/** Flips one cell of the model's default routing template. */
export async function toggleDefaultRoute(
  db: D1Database,
  modelId: string,
  inPortKey: string,
  busKey: string,
): Promise<void> {
  const ids = await db
    .prepare(
      `SELECT
         (SELECT id FROM device_model_ports WHERE model_id = ?1 AND key = ?2) AS port_id,
         (SELECT id FROM device_model_buses WHERE model_id = ?1 AND key = ?3) AS bus_id`,
    )
    .bind(modelId, inPortKey, busKey)
    .first<{ port_id: string | null; bus_id: string | null }>();
  if (!ids?.port_id || !ids.bus_id) return;

  const existing = await db
    .prepare(
      "SELECT 1 AS hit FROM device_model_default_routes WHERE model_id = ? AND in_port_id = ? AND bus_id = ?",
    )
    .bind(modelId, ids.port_id, ids.bus_id)
    .first<{ hit: number }>();

  await db
    .prepare(
      existing
        ? "DELETE FROM device_model_default_routes WHERE model_id = ? AND in_port_id = ? AND bus_id = ?"
        : "INSERT INTO device_model_default_routes (model_id, in_port_id, bus_id) VALUES (?, ?, ?)",
    )
    .bind(modelId, ids.port_id, ids.bus_id)
    .run();
}

// ─── Ledger: 機材台帳 ─────────────────────────────────────────────────────────

type DeviceRow = {
  id: string;
  model_id: string;
  name: string;
  identifier: string | null;
  owner_note: string | null;
};

export type LedgerDevice = Device & {
  ownerNote: string | null;
  modelName: string;
  modelMaker: string | null;
  category: DeviceCategory;
};

const DEVICE_COLS = "id, model_id, name, identifier, owner_note";

function toDevice(row: DeviceRow): Device {
  return { id: row.id, modelId: row.model_id, name: row.name, identifier: row.identifier };
}

export async function listLedger(db: D1Database): Promise<LedgerDevice[]> {
  const { results } = await db
    .prepare(
      `SELECT d.id, d.model_id, d.name, d.identifier, d.owner_note,
              m.name AS model_name, m.maker AS model_maker, m.category
       FROM devices d
       JOIN device_models m ON m.id = d.model_id
       WHERE d.deleted_at IS NULL
       ORDER BY m.category, d.name`,
    )
    .all<DeviceRow & { model_name: string; model_maker: string | null; category: string }>();
  return results.map((row) => ({
    ...toDevice(row),
    ownerNote: row.owner_note,
    modelName: row.model_name,
    modelMaker: row.model_maker,
    category: row.category as DeviceCategory,
  }));
}

export async function loadDevices(db: D1Database): Promise<Map<string, Device>> {
  const { results } = await db
    .prepare(`SELECT ${DEVICE_COLS} FROM devices WHERE deleted_at IS NULL`)
    .all<DeviceRow>();
  return new Map(results.map((row) => [row.id, toDevice(row)]));
}

export type DeviceInput = {
  modelId: string;
  name: string;
  identifier: string | null;
  ownerNote: string | null;
};

export async function createDevice(
  db: D1Database,
  input: DeviceInput,
  userId: string,
): Promise<string> {
  const id = newId("device");
  await db
    .prepare(
      `INSERT INTO devices (id, model_id, name, identifier, owner_note, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.modelId, input.name, input.identifier, input.ownerNote, userId)
    .run();
  return id;
}

export async function updateDevice(db: D1Database, id: string, input: DeviceInput): Promise<void> {
  await db
    .prepare(
      `UPDATE devices SET model_id = ?, name = ?, identifier = ?, owner_note = ?,
              updated_at = unixepoch()
       WHERE id = ?`,
    )
    .bind(input.modelId, input.name, input.identifier, input.ownerNote, id)
    .run();
}

export async function softDeleteDevice(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE devices SET deleted_at = unixepoch() WHERE id = ?").bind(id).run();
}

// ─── Events ───────────────────────────────────────────────────────────────────

type EventRow = {
  id: string;
  title: string;
  starts_at: number | null;
  venue: string | null;
  external_url: string | null;
};

export type EventRecord = {
  id: string;
  title: string;
  startsAt: number | null;
  venue: string | null;
  externalUrl: string | null;
};

const EVENT_COLS = "id, title, starts_at, venue, external_url";

function toEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    venue: row.venue,
    externalUrl: row.external_url,
  };
}

export async function listEvents(db: D1Database): Promise<EventRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${EVENT_COLS} FROM events WHERE deleted_at IS NULL
       ORDER BY COALESCE(starts_at, created_at) DESC`,
    )
    .all<EventRow>();
  return results.map(toEvent);
}

export async function getEvent(db: D1Database, id: string): Promise<EventRecord | null> {
  const row = await db
    .prepare(`SELECT ${EVENT_COLS} FROM events WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<EventRow>();
  return row ? toEvent(row) : null;
}

export type EventInput = {
  title: string;
  startsAt: number | null;
  venue: string | null;
  externalUrl: string | null;
};

export async function createEvent(
  db: D1Database,
  input: EventInput,
  userId: string,
): Promise<string> {
  const id = newId("event");
  await db
    .prepare(
      `INSERT INTO events (id, title, starts_at, venue, external_url, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.title, input.startsAt, input.venue, input.externalUrl, userId)
    .run();
  return id;
}

export async function updateEvent(db: D1Database, id: string, input: EventInput): Promise<void> {
  await db
    .prepare(
      `UPDATE events SET title = ?, starts_at = ?, venue = ?, external_url = ?,
              updated_at = unixepoch()
       WHERE id = ?`,
    )
    .bind(input.title, input.startsAt, input.venue, input.externalUrl, id)
    .run();
}

export async function softDeleteEvent(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE events SET deleted_at = unixepoch() WHERE id = ?").bind(id).run();
}

/** The gear actually brought to this event — the only devices a setup may use. */
export async function listEventDeviceIds(db: D1Database, eventId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT device_id FROM event_devices WHERE event_id = ?")
    .bind(eventId)
    .all<{ device_id: string }>();
  return new Set(results.map((row) => row.device_id));
}

export async function toggleEventDevice(
  db: D1Database,
  eventId: string,
  deviceId: string,
): Promise<void> {
  const existing = await db
    .prepare("SELECT 1 AS hit FROM event_devices WHERE event_id = ? AND device_id = ?")
    .bind(eventId, deviceId)
    .first<{ hit: number }>();
  await db
    .prepare(
      existing
        ? "DELETE FROM event_devices WHERE event_id = ? AND device_id = ?"
        : "INSERT INTO event_devices (event_id, device_id) VALUES (?, ?)",
    )
    .bind(eventId, deviceId)
    .run();
}

// ─── Setups ───────────────────────────────────────────────────────────────────

type SetupRow = { id: string; event_id: string; name: string; doc: string; updated_at: number };

export type SetupRecord = {
  id: string;
  eventId: string;
  name: string;
  doc: SetupDoc;
  /** Set when the stored JSON no longer validates; the editor still opens. */
  docError: string | null;
  updatedAt: number;
};

const SETUP_COLS = "id, event_id, name, doc, updated_at";

function toSetup(row: SetupRow): SetupRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.doc);
  } catch {
    return {
      id: row.id,
      eventId: row.event_id,
      name: row.name,
      doc: EMPTY_SETUP_DOC,
      docError: "保存されている構成が JSON として壊れています。",
      updatedAt: row.updated_at,
    };
  }
  const result = safeParseSetupDoc(parsed);
  return {
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    doc: result.success ? result.data : EMPTY_SETUP_DOC,
    docError: result.success ? null : "保存されている構成がスキーマに適合しません。",
    updatedAt: row.updated_at,
  };
}

export async function listSetups(db: D1Database, eventId: string): Promise<SetupRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT ${SETUP_COLS} FROM setups WHERE event_id = ? AND deleted_at IS NULL
       ORDER BY created_at`,
    )
    .bind(eventId)
    .all<SetupRow>();
  return results.map(toSetup);
}

export async function getSetup(db: D1Database, id: string): Promise<SetupRecord | null> {
  const row = await db
    .prepare(`SELECT ${SETUP_COLS} FROM setups WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<SetupRow>();
  return row ? toSetup(row) : null;
}

export async function createSetup(
  db: D1Database,
  eventId: string,
  name: string,
  userId: string,
): Promise<string> {
  const id = newId("setup");
  await db
    .prepare("INSERT INTO setups (id, event_id, name, doc, created_by) VALUES (?, ?, ?, ?, ?)")
    .bind(id, eventId, name, JSON.stringify(EMPTY_SETUP_DOC), userId)
    .run();
  return id;
}

/** Writes the document and keeps the previous one as a revision. */
export async function saveSetupDoc(
  db: D1Database,
  setupId: string,
  doc: SetupDoc,
  userId: string,
): Promise<void> {
  const previous = await db
    .prepare("SELECT doc FROM setups WHERE id = ?")
    .bind(setupId)
    .first<{ doc: string }>();
  const statements = [
    db
      .prepare("UPDATE setups SET doc = ?, updated_at = unixepoch() WHERE id = ?")
      .bind(JSON.stringify(doc), setupId),
  ];
  if (previous) {
    statements.push(
      db
        .prepare("INSERT INTO setup_revisions (id, setup_id, doc, author_id) VALUES (?, ?, ?, ?)")
        .bind(newId("revision"), setupId, previous.doc, userId),
    );
  }
  await db.batch(statements);
}

export async function renameSetup(db: D1Database, id: string, name: string): Promise<void> {
  await db
    .prepare("UPDATE setups SET name = ?, updated_at = unixepoch() WHERE id = ?")
    .bind(name, id)
    .run();
}

export async function softDeleteSetup(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE setups SET deleted_at = unixepoch() WHERE id = ?").bind(id).run();
}
