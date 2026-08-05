/**
 * Fixtures shared by `global-setup.ts` and the specs.
 *
 * Everything is referenced by a stable id so a run can wipe and recreate it,
 * and so specs navigate straight to a URL instead of clicking their way in.
 * Rows a spec creates itself are named with `E2E_PREFIX` so setup clears those
 * too — otherwise a second run trips over the first one's leftovers.
 *
 * Fixtures are split by who mutates them. The suite runs fully parallel, so a
 * spec that changes an event's gear list or a setup's routing must not share
 * that row with a spec that reads it.
 */

/** Anything a spec creates must be named with this so setup can wipe it. */
export const E2E_PREFIX = "E2E ";

export const USER = {
  id: "e2e-stream-user",
  name: "E2E ユーザー",
  email: "e2e@test.local",
};

/** Model ids come from migration 0003, so the catalog is never empty. */
const MODELS = {
  mic: "mdl_seed_sm58",
  mixer: "mdl_seed_mg10xu",
  speaker: "mdl_seed_speaker",
  pc: "mdl_seed_pc",
  obs: "mdl_seed_obs",
  meet: "mdl_seed_meet",
} as const;

export const DEVICES = [
  { id: "e2e_dev_mic", modelId: MODELS.mic, name: "E2E ハンドマイク" },
  { id: "e2e_dev_mixer", modelId: MODELS.mixer, name: "E2E ミキサー" },
  { id: "e2e_dev_speaker", modelId: MODELS.speaker, name: "E2E 会場スピーカー" },
  { id: "e2e_dev_pc", modelId: MODELS.pc, name: "E2E 配信PC" },
  { id: "e2e_dev_obs", modelId: MODELS.obs, name: "E2E OBS" },
  { id: "e2e_dev_meet", modelId: MODELS.meet, name: "E2E Meet" },
] as const;

/** Read-only gear list. linter.spec.ts depends on every device staying on it. */
export const EVENT = {
  id: "e2e_event",
  title: "E2E 配信イベント",
  venue: "E2E ホール",
};

/** event.spec.ts toggles gear here, so nothing else may read this one. */
export const GEAR_EVENT = {
  id: "e2e_event_gear",
  title: "E2E 機材選択イベント",
  venue: "E2E 別会場",
};

export const EVENTS = [EVENT, GEAR_EVENT] as const;

const HALL = { id: "sp1", kind: "acoustic", label: "メインホール", venueKey: "e2e-hall" };

/** Mic → mixer MAIN → speaker → room → mic. The canonical howl. */
function howlingDoc() {
  return {
    schemaVersion: 1,
    spaces: [HALL],
    nodes: [
      { id: "n1", deviceId: "e2e_dev_mic", spaceId: "sp1" },
      { id: "n2", deviceId: "e2e_dev_mixer" },
      { id: "n3", deviceId: "e2e_dev_speaker", spaceId: "sp1" },
      { id: "n4", deviceId: "e2e_dev_pc" },
      { id: "n5", deviceId: "e2e_dev_obs", hostNodeId: "n4" },
    ],
    links: [
      { id: "l1", from: ["n1", "out"], to: ["n2", "ch1"] },
      { id: "l2", from: ["n2", "main_out"], to: ["n3", "in"] },
      { id: "l3", from: ["n2", "usb_send"], to: ["n4", "usb_in"] },
      { id: "l4", from: ["n4", "usb_in"], to: ["n5", "audio_in"] },
    ],
    // ch1 also goes to USB, so cutting MAIN must silence the room without
    // silencing the stream.
    routing: [
      { nodeId: "n2", inPort: "ch1", bus: "main" },
      { nodeId: "n2", inPort: "ch1", bus: "usb" },
    ],
  };
}

/** Meet's received audio returns down the mixer's USB send: a Mix-Minus violation. */
function mixMinusDoc() {
  return {
    schemaVersion: 1,
    spaces: [],
    nodes: [
      { id: "n1", deviceId: "e2e_dev_mixer" },
      { id: "n2", deviceId: "e2e_dev_pc" },
      { id: "n3", deviceId: "e2e_dev_meet", hostNodeId: "n2" },
    ],
    links: [
      { id: "l1", from: ["n1", "usb_send"], to: ["n2", "usb_in"] },
      { id: "l2", from: ["n2", "usb_in"], to: ["n3", "mic_in"] },
      { id: "l3", from: ["n3", "spk_out"], to: ["n2", "usb_out"] },
      { id: "l4", from: ["n2", "usb_out"], to: ["n1", "usb_in"] },
    ],
    routing: [{ nodeId: "n1", inPort: "usb_in", bus: "usb" }],
  };
}

/** A mic and OBS that were never wired together. */
function silentDoc() {
  return {
    schemaVersion: 1,
    spaces: [HALL],
    nodes: [
      { id: "n1", deviceId: "e2e_dev_mic", spaceId: "sp1" },
      { id: "n2", deviceId: "e2e_dev_pc" },
      { id: "n3", deviceId: "e2e_dev_obs", hostNodeId: "n2" },
    ],
    links: [],
    routing: [],
  };
}

const EMPTY_DOC = { schemaVersion: 1, spaces: [], nodes: [], links: [], routing: [] };

export const SETUPS = [
  { id: "e2e_setup_howling", eventId: EVENT.id, name: "E2E ハウリング", doc: howlingDoc() },
  {
    id: "e2e_setup_howling_fix",
    eventId: EVENT.id,
    name: "E2E ハウリング (修正用)",
    doc: howlingDoc(),
  },
  { id: "e2e_setup_mixminus", eventId: EVENT.id, name: "E2E Mix-Minus", doc: mixMinusDoc() },
  {
    id: "e2e_setup_mixminus_fix",
    eventId: EVENT.id,
    name: "E2E Mix-Minus (修正用)",
    doc: mixMinusDoc(),
  },
  { id: "e2e_setup_silent", eventId: EVENT.id, name: "E2E 無音配信", doc: silentDoc() },
  // The Mix-Minus rig with the offending matrix cell already cleared: no room,
  // no endpoint gear and nothing streaming, so it reports nothing at all.
  {
    id: "e2e_setup_clean",
    eventId: EVENT.id,
    name: "E2E 問題なし",
    doc: { ...mixMinusDoc(), routing: [] },
  },
  // Built up from nothing by editor.spec.ts.
  { id: "e2e_setup_editing", eventId: EVENT.id, name: "E2E 編集用", doc: EMPTY_DOC },
  { id: "e2e_setup_json", eventId: EVENT.id, name: "E2E JSON 編集用", doc: silentDoc() },
  // Lives on the event whose gear list event.spec.ts is allowed to change.
  {
    id: "e2e_setup_gear",
    eventId: GEAR_EVENT.id,
    name: "E2E 機材選択確認",
    doc: howlingDoc(),
  },
] as const;

export function setupUrl(setupId: string, tab?: string): string {
  const setup = SETUPS.find((entry) => entry.id === setupId);
  if (!setup) throw new Error(`unknown seeded setup: ${setupId}`);
  const base = `/events/${setup.eventId}/setups/${setup.id}`;
  return tab ? `${base}?tab=${tab}` : base;
}
