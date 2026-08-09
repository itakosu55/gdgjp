import type { LintContext } from "./diagnostics";
import type { SetupDoc } from "./schema";
import type {
  Device,
  DeviceCategory,
  DeviceModel,
  DeviceModelBus,
  DeviceModelPort,
  InternalRouting,
} from "./types";

/**
 * A small catalog used by the unit tests. It is deliberately close to the gear
 * a GDG chapter actually carries: a couple of mics, a compact USB mixer, a
 * laptop running OBS and Meet, a powered speaker, and a house PA nobody can
 * see inside.
 */

type PortSpec = Partial<DeviceModelPort> & Pick<DeviceModelPort, "key" | "direction" | "signal">;

function port(spec: PortSpec): DeviceModelPort {
  return {
    key: spec.key,
    label: spec.label ?? spec.key,
    direction: spec.direction,
    signal: spec.signal,
    connector: spec.connector ?? "none",
    level: spec.level ?? null,
    channels: spec.channels ?? 1,
    phantom: spec.phantom ?? "none",
    busKey: spec.busKey ?? null,
    couples: spec.couples ?? null,
  };
}

function bus(key: string, kind: DeviceModelBus["kind"]): DeviceModelBus {
  return { key, label: key, kind };
}

/**
 * The eight ports a meeting join exposes.
 *
 * `mic_in` / `spk_out` alone cannot express a screen share, and screen-share
 * audio is split from its video for the same reason USB audio is two ports:
 * "the video's sound is in the room but not on the stream" is exactly that
 * asymmetry, and one combined port hides it. Unwired ports emit no edges, so
 * a one-way feed costs no extra data entry.
 */
function joinPorts(): DeviceModelPort[] {
  // What a join sends is what its meeting hears, so every input faces the
  // transport space and every output is the meeting talking back.
  const send = { couples: "to_space" } as const;
  const receive = { couples: "from_space" } as const;
  return [
    port({ key: "mic_in", direction: "in", signal: "audio_digital", ...send }),
    port({ key: "cam_video_in", direction: "in", signal: "video", ...send }),
    port({ key: "share_audio_in", direction: "in", signal: "audio_digital", ...send }),
    port({ key: "share_video_in", direction: "in", signal: "video", ...send }),
    port({ key: "spk_out", direction: "out", signal: "audio_digital", ...receive }),
    port({ key: "cam_video_out", direction: "out", signal: "video", ...receive }),
    port({ key: "share_audio_out", direction: "out", signal: "audio_digital", ...receive }),
    port({ key: "share_video_out", direction: "out", signal: "video", ...receive }),
  ];
}

function model(spec: {
  id: string;
  name: string;
  category: DeviceCategory;
  internalRouting: InternalRouting;
  ports: DeviceModelPort[];
  buses?: DeviceModelBus[];
}): DeviceModel {
  return {
    id: spec.id,
    maker: null,
    name: spec.name,
    category: spec.category,
    internalRouting: spec.internalRouting,
    buses: spec.buses ?? [],
    ports: spec.ports,
    defaultRoutes: [],
  };
}

export const MODELS: DeviceModel[] = [
  model({
    id: "m_mic_dynamic",
    name: "Dynamic Mic",
    category: "mic",
    internalRouting: "none",
    ports: [
      port({
        key: "out",
        direction: "out",
        signal: "audio_analog",
        connector: "xlr",
        level: "mic",
        couples: "from_space",
      }),
    ],
  }),
  model({
    id: "m_mic_condenser",
    name: "Condenser Mic",
    category: "mic",
    internalRouting: "none",
    ports: [
      port({
        key: "out",
        direction: "out",
        signal: "audio_analog",
        connector: "xlr",
        level: "mic",
        phantom: "requires",
        couples: "from_space",
      }),
    ],
  }),
  model({
    id: "m_mixer",
    name: "Compact USB Mixer",
    category: "mixer",
    internalRouting: "matrix",
    buses: [bus("main", "main"), bus("aux1", "aux"), bus("usb", "usb")],
    ports: [
      port({
        key: "ch1",
        direction: "in",
        signal: "audio_analog",
        connector: "xlr",
        level: "mic",
        phantom: "provides",
      }),
      port({
        key: "ch2",
        direction: "in",
        signal: "audio_analog",
        connector: "xlr",
        level: "mic",
        phantom: "provides",
      }),
      port({ key: "usb_in", direction: "in", signal: "audio_digital", connector: "usb_b" }),
      port({
        key: "main_out",
        direction: "out",
        signal: "audio_analog",
        connector: "trs",
        level: "line",
        busKey: "main",
      }),
      port({
        key: "aux1_out",
        direction: "out",
        signal: "audio_analog",
        connector: "trs",
        level: "line",
        busKey: "aux1",
      }),
      port({
        key: "usb_send",
        direction: "out",
        signal: "audio_digital",
        connector: "usb_b",
        busKey: "usb",
      }),
    ],
  }),
  model({
    id: "m_speaker",
    name: "Powered Speaker",
    category: "speaker",
    internalRouting: "none",
    ports: [
      port({
        key: "in",
        direction: "in",
        signal: "audio_analog",
        connector: "trs",
        level: "line",
        couples: "to_space",
      }),
    ],
  }),
  model({
    id: "m_pc",
    name: "Streaming Laptop",
    category: "computer",
    internalRouting: "none",
    ports: [
      port({ key: "usb_in", direction: "in", signal: "audio_digital", connector: "usb_b" }),
      port({ key: "usb_out", direction: "out", signal: "audio_digital", connector: "usb_b" }),
      port({
        key: "line_in",
        direction: "in",
        signal: "audio_analog",
        connector: "trs_mini",
        level: "line",
      }),
      port({
        key: "headphone_out",
        direction: "out",
        signal: "audio_analog",
        connector: "trs_mini",
        level: "line",
      }),
      port({ key: "capture_in", direction: "in", signal: "video", connector: "usb_c" }),
      port({ key: "hdmi_out", direction: "out", signal: "video", connector: "hdmi" }),
    ],
  }),
  model({
    id: "m_obs",
    name: "OBS Studio",
    category: "software_broadcast",
    internalRouting: "matrix",
    buses: [bus("program", "main"), bus("monitor", "monitor")],
    ports: [
      port({ key: "audio_in", direction: "in", signal: "audio_digital" }),
      port({ key: "video_in", direction: "in", signal: "video" }),
      port({ key: "stream_out", direction: "out", signal: "audio_digital", busKey: "program" }),
      port({ key: "program_video", direction: "out", signal: "video", busKey: "program" }),
      port({ key: "monitor_out", direction: "out", signal: "audio_digital", busKey: "monitor" }),
    ],
  }),
  model({
    id: "m_meet",
    name: "Google Meet",
    category: "software_conferencing",
    // Never `passthrough`: a conferencing app does not route the local mic to
    // the local speaker, and pretending it does invents an echo loop. What a
    // join reaches is its *meeting*, which is a transport space, not an
    // internal route.
    internalRouting: "none",
    ports: joinPorts(),
  }),
  model({
    id: "m_vdo",
    name: "VDO.Ninja",
    category: "software_conferencing",
    internalRouting: "none",
    ports: joinPorts(),
  }),
  // A laptop's built-in transducers are separate nodes, because `computer` has
  // no space coupling and so cannot touch a room by itself. Modelling them is
  // what makes a presenter's own machine visible on the patch sheet at all.
  // No connector and no level: there is no jack to mismatch.
  model({
    id: "m_builtin_mic",
    name: "PC 内蔵マイク",
    category: "mic",
    internalRouting: "none",
    ports: [port({ key: "out", direction: "out", signal: "audio_analog", couples: "from_space" })],
  }),
  model({
    id: "m_builtin_spk",
    name: "PC 内蔵スピーカー",
    category: "speaker",
    internalRouting: "none",
    ports: [port({ key: "in", direction: "in", signal: "audio_analog", couples: "to_space" })],
  }),
  /**
   * One unit that is both a mic and a speaker — §11.3's case, and the commonest
   * piece of conferencing gear there is. Until coupling lived on the port this
   * could only be written as two nodes, because a category picks one side.
   *
   * The two faces read backwards from a standalone mic and speaker on purpose:
   * what leaves the speakerphone over USB is the room, and what arrives over
   * USB is what it will play into the room.
   */
  model({
    id: "m_speakerphone",
    name: "USB Speakerphone",
    category: "audio_interface",
    internalRouting: "none",
    ports: [
      port({
        key: "usb_out",
        direction: "out",
        signal: "audio_digital",
        connector: "usb_c",
        couples: "from_space",
      }),
      port({
        key: "usb_in",
        direction: "in",
        signal: "audio_digital",
        connector: "usb_c",
        couples: "to_space",
      }),
    ],
  }),
  model({
    id: "m_camera",
    name: "Camcorder",
    category: "camera",
    internalRouting: "none",
    ports: [
      port({
        key: "hdmi_out",
        direction: "out",
        signal: "video",
        connector: "hdmi",
        couples: "from_space",
      }),
    ],
  }),
  model({
    id: "m_capture",
    name: "HDMI Capture",
    category: "capture",
    internalRouting: "passthrough",
    ports: [
      port({ key: "hdmi_in", direction: "in", signal: "video", connector: "hdmi" }),
      port({ key: "usb_out", direction: "out", signal: "video", connector: "usb_c" }),
    ],
  }),
  model({
    id: "m_projector",
    name: "Projector",
    category: "display",
    internalRouting: "none",
    ports: [
      port({
        key: "hdmi_in",
        direction: "in",
        signal: "video",
        connector: "hdmi",
        couples: "to_space",
      }),
    ],
  }),
  model({
    id: "m_house_pa",
    name: "House PA (internals unknown)",
    category: "blackbox",
    internalRouting: "passthrough",
    ports: [
      port({
        key: "line_in",
        direction: "in",
        signal: "audio_analog",
        connector: "trs",
        level: "line",
      }),
      port({
        key: "line_out",
        direction: "out",
        signal: "audio_analog",
        connector: "trs",
        level: "line",
      }),
    ],
  }),
  model({
    id: "m_recorder",
    name: "Field Recorder",
    category: "recorder",
    internalRouting: "none",
    ports: [
      port({ key: "in", direction: "in", signal: "audio_analog", connector: "trs", level: "line" }),
    ],
  }),
];

export const DEVICES: Device[] = [
  { id: "d_mic1", modelId: "m_mic_dynamic", name: "ハンドマイク1" },
  { id: "d_mic2", modelId: "m_mic_dynamic", name: "ハンドマイク2" },
  { id: "d_condenser", modelId: "m_mic_condenser", name: "コンデンサーマイク" },
  { id: "d_mixer", modelId: "m_mixer", name: "ミキサー" },
  { id: "d_mixer2", modelId: "m_mixer", name: "別室ミキサー" },
  { id: "d_speaker", modelId: "m_speaker", name: "会場スピーカー" },
  { id: "d_speaker2", modelId: "m_speaker", name: "別室スピーカー" },
  { id: "d_pc", modelId: "m_pc", name: "配信PC" },
  { id: "d_laptop", modelId: "m_pc", name: "登壇者ノートPC" },
  { id: "d_builtin_mic", modelId: "m_builtin_mic", name: "ノートPC内蔵マイク" },
  { id: "d_builtin_spk", modelId: "m_builtin_spk", name: "ノートPC内蔵スピーカー" },
  { id: "d_speakerphone", modelId: "m_speakerphone", name: "USBスピーカーフォン" },
  { id: "d_obs", modelId: "m_obs", name: "OBS" },
  // Software is referenced by `modelId` now. This row stays so one test still
  // proves a `deviceId`-referencing software node keeps resolving.
  { id: "d_meet", modelId: "m_meet", name: "Meet" },
  { id: "d_camera", modelId: "m_camera", name: "カメラ" },
  { id: "d_capture", modelId: "m_capture", name: "キャプチャ" },
  { id: "d_projector", modelId: "m_projector", name: "プロジェクタ" },
  { id: "d_house_pa", modelId: "m_house_pa", name: "会場PA" },
  { id: "d_recorder", modelId: "m_recorder", name: "レコーダー" },
];

/**
 * A presenter shares a video from their own laptop, joined to the same meeting
 * as the streaming PC and sitting in the same room. Their machine appears on no
 * patch sheet, and the loop it closes cannot be cancelled: the sound came back
 * through *another* join's speaker, so the canceller has no reference for it.
 *
 * The hall mic is deliberately not routed to MAIN, so the only cycle in this
 * document is the transport one and the test cannot pass on plain howling.
 */
export function twoJoinsInOneHall(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_hall", kind: "acoustic", label: "メインホール" },
      { id: "sp_mtg", kind: "transport", label: "登壇 Meet", meetingKey: "meet-abc" },
    ],
    nodes: [
      // The mixer and the two computers couple to nothing, so `spaceId` buys the
      // graph nothing here — it says where they are standing, which is what the
      // diagram frames them by. The laptop being in the hall is the whole point
      // of this fixture.
      { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
      { id: "n_mixer", deviceId: "d_mixer", spaceId: "sp_hall" },
      { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
      { id: "n_pc", deviceId: "d_pc", spaceId: "sp_hall" },
      { id: "n_join_stream", modelId: "m_meet", hostNodeId: "n_pc", spaceId: "sp_mtg" },
      { id: "n_laptop", deviceId: "d_laptop", spaceId: "sp_hall" },
      { id: "n_laptop_mic", deviceId: "d_builtin_mic", spaceId: "sp_hall" },
      { id: "n_join_laptop", modelId: "m_meet", hostNodeId: "n_laptop", spaceId: "sp_mtg" },
    ],
    links: [
      { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
      { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
      { id: "l3", from: ["n_join_stream", "spk_out"], to: ["n_pc", "usb_out"] },
      { id: "l4", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
      { id: "l5", from: ["n_laptop_mic", "out"], to: ["n_laptop", "line_in"] },
      { id: "l6", from: ["n_laptop", "line_in"], to: ["n_join_laptop", "mic_in"] },
    ],
    routing: [{ nodeId: "n_mixer", inPort: "usb_in", bus: "main" }],
  };
}

/**
 * The hall is relayed to a satellite room over the same meeting, and both ends
 * reinforce what they receive. Two acoustic spaces nothing physically connects
 * are coupled through the transport space, and the single cycle crosses the
 * meeting twice — once per sender vertex.
 */
export function satelliteRooms(): SetupDoc {
  const room = (
    suffix: string,
    spaceId: string,
    mic: string,
    mixer: string,
    speaker: string,
    pc: string,
  ) => ({
    nodes: [
      { id: `n_mic_${suffix}`, deviceId: mic, spaceId },
      { id: `n_mixer_${suffix}`, deviceId: mixer, spaceId },
      { id: `n_speaker_${suffix}`, deviceId: speaker, spaceId },
      { id: `n_pc_${suffix}`, deviceId: pc, spaceId },
      {
        id: `n_join_${suffix}`,
        modelId: "m_meet",
        hostNodeId: `n_pc_${suffix}`,
        spaceId: "sp_mtg",
      },
    ],
    links: [
      { id: `l${suffix}1`, from: [`n_mic_${suffix}`, "out"], to: [`n_mixer_${suffix}`, "ch1"] },
      {
        id: `l${suffix}2`,
        from: [`n_mixer_${suffix}`, "usb_send"],
        to: [`n_pc_${suffix}`, "usb_in"],
      },
      { id: `l${suffix}3`, from: [`n_pc_${suffix}`, "usb_in"], to: [`n_join_${suffix}`, "mic_in"] },
      {
        id: `l${suffix}4`,
        from: [`n_join_${suffix}`, "spk_out"],
        to: [`n_pc_${suffix}`, "usb_out"],
      },
      {
        id: `l${suffix}5`,
        from: [`n_pc_${suffix}`, "usb_out"],
        to: [`n_mixer_${suffix}`, "usb_in"],
      },
      {
        id: `l${suffix}6`,
        from: [`n_mixer_${suffix}`, "main_out"],
        to: [`n_speaker_${suffix}`, "in"],
      },
    ],
    routing: [
      { nodeId: `n_mixer_${suffix}`, inPort: "ch1", bus: "usb" },
      { nodeId: `n_mixer_${suffix}`, inPort: "usb_in", bus: "main" },
    ],
  });

  const a = room("a", "sp_hall", "d_mic1", "d_mixer", "d_speaker", "d_pc");
  const b = room("b", "sp_satellite", "d_mic2", "d_mixer2", "d_speaker2", "d_laptop");

  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_hall", kind: "acoustic", label: "メインホール" },
      { id: "sp_satellite", kind: "acoustic", label: "別室サテライト" },
      { id: "sp_mtg", kind: "transport", label: "サテライト中継", meetingKey: "meet-sat" },
    ],
    nodes: [...a.nodes, ...b.nodes],
    links: [...a.links, ...b.links] as SetupDoc["links"],
    routing: [...a.routing, ...b.routing],
  };
}

/**
 * One laptop, its own built-in mic and speaker, and nothing else in the path.
 * This is the return trip a conferencing app's own canceller removes, so it
 * must not be reported as critical (§9.7.4).
 */
export function laptopOnlyMeeting(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [{ id: "sp_hall", kind: "acoustic", label: "メインホール" }],
    nodes: [
      { id: "n_laptop", deviceId: "d_laptop" },
      { id: "n_laptop_mic", deviceId: "d_builtin_mic", spaceId: "sp_hall" },
      { id: "n_laptop_spk", deviceId: "d_builtin_spk", spaceId: "sp_hall" },
      { id: "n_join", modelId: "m_meet", hostNodeId: "n_laptop" },
    ],
    links: [
      { id: "l1", from: ["n_join", "spk_out"], to: ["n_laptop", "headphone_out"] },
      { id: "l2", from: ["n_laptop", "headphone_out"], to: ["n_laptop_spk", "in"] },
      { id: "l3", from: ["n_laptop_mic", "out"], to: ["n_laptop", "line_in"] },
      { id: "l4", from: ["n_laptop", "line_in"], to: ["n_join", "mic_in"] },
    ],
    routing: [],
  };
}

/**
 * A meeting room joined by one USB speakerphone — §11.3's headline case.
 *
 * One physical unit is both faces of the room: what leaves it over USB is the
 * room's sound, what arrives over USB it plays back into the room. Before
 * coupling moved onto the port this had to be split into a mic node and a
 * speaker node that no one could unplug from each other, and the ledger then
 * held two rows for a thing you carry in one hand (§11.7).
 */
export function speakerphoneMeeting(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_room", kind: "acoustic", label: "会議室" },
      { id: "sp_mtg", kind: "transport", label: "定例 Meet", meetingKey: "meet-weekly" },
    ],
    nodes: [
      { id: "n_phone", deviceId: "d_speakerphone", spaceId: "sp_room" },
      { id: "n_pc", deviceId: "d_pc", spaceId: "sp_room" },
      { id: "n_join", modelId: "m_meet", hostNodeId: "n_pc", spaceId: "sp_mtg" },
    ],
    links: [
      { id: "l1", from: ["n_phone", "usb_out"], to: ["n_pc", "usb_in"] },
      { id: "l2", from: ["n_pc", "usb_in"], to: ["n_join", "mic_in"] },
      { id: "l3", from: ["n_join", "spk_out"], to: ["n_pc", "usb_out"] },
      { id: "l4", from: ["n_pc", "usb_out"], to: ["n_phone", "usb_in"] },
    ],
    routing: [],
  };
}

export function testContext(overrides: Partial<LintContext> = {}): LintContext {
  return {
    models: new Map(MODELS.map((entry) => [entry.id, entry])),
    devices: new Map(DEVICES.map((entry) => [entry.id, entry])),
    ...overrides,
  };
}
