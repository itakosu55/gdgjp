import type { LintContext } from "./diagnostics";
import type { NodePort, SetupDoc } from "./schema";
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
    expandable: spec.expandable ?? false,
    sourceKey: spec.sourceKey ?? null,
    origin: spec.origin ?? false,
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
  // `source_key` says which jacks are one thing. It groups per direction, so
  // the share we send and the share we receive are two sources — and `cam` has
  // no audio half by design, because a camera and a microphone are chosen
  // separately (§12.4).
  const share = { sourceKey: "share" } as const;
  const cam = { sourceKey: "cam" } as const;
  return [
    port({ key: "mic_in", direction: "in", signal: "audio_digital", ...send }),
    port({ key: "cam_video_in", direction: "in", signal: "video", ...send, ...cam }),
    port({ key: "share_audio_in", direction: "in", signal: "audio_digital", ...send, ...share }),
    port({ key: "share_video_in", direction: "in", signal: "video", ...send, ...share }),
    port({ key: "spk_out", direction: "out", signal: "audio_digital", ...receive }),
    port({ key: "cam_video_out", direction: "out", signal: "video", ...receive, ...cam }),
    port({
      key: "share_audio_out",
      label: "リモート画面共有の音声",
      direction: "out",
      signal: "audio_digital",
      ...receive,
      ...share,
    }),
    port({
      key: "share_video_out",
      label: "リモート画面共有の映像",
      direction: "out",
      signal: "video",
      ...receive,
      ...share,
    }),
  ];
}

function model(spec: {
  id: string;
  name: string;
  category: DeviceCategory;
  internalRouting: InternalRouting;
  echoCancels: boolean;
  ports: DeviceModelPort[];
  buses?: DeviceModelBus[];
  defaultRoutes?: DeviceModel["defaultRoutes"];
}): DeviceModel {
  return {
    id: spec.id,
    maker: null,
    name: spec.name,
    category: spec.category,
    internalRouting: spec.internalRouting,
    echoCancels: spec.echoCancels,
    buses: spec.buses ?? [],
    ports: spec.ports,
    defaultRoutes: spec.defaultRoutes ?? [],
  };
}

export const MODELS: DeviceModel[] = [
  model({
    id: "m_mic_dynamic",
    name: "Dynamic Mic",
    category: "mic",
    internalRouting: "none",
    echoCancels: false,
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
    echoCancels: false,
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
    echoCancels: false,
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
  /**
   * A room DSP — the same matrix a mixer is, plus the one fact that changes how
   * a loop through it reads.
   *
   * It owns neither the mics nor the speakers, so it stands exactly where
   * `m_mixer` stands and no shape of the path tells them apart. `echoCancels`
   * is the only difference, and it is a claim about the box, not the room
   * (§13.7).
   */
  model({
    id: "m_dsp",
    name: "Room DSP",
    category: "mixer",
    internalRouting: "matrix",
    echoCancels: true,
    buses: [bus("main", "main"), bus("usb", "usb")],
    ports: [
      port({
        key: "ch1",
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
    echoCancels: false,
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
  // A laptop's built-in transducers are ports of the laptop, not nodes beside
  // it: they cannot be carried out of the building on their own (§11.7), and
  // the cables that used to join them did not physically exist. No connector
  // and no level — there is no jack to mismatch. `internalRouting` stays `none`
  // so the machine never routes its own mic into its own speaker.
  model({
    id: "m_pc",
    name: "Streaming Laptop",
    category: "computer",
    internalRouting: "none",
    echoCancels: false,
    ports: [
      port({
        key: "builtin_mic",
        direction: "in",
        signal: "audio_analog",
        couples: "from_space",
      }),
      port({ key: "builtin_spk", direction: "out", signal: "audio_analog", couples: "to_space" }),
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
  // The inputs are templates: OBS's mixer has one strip per source, and the
  // sources are chosen on the day, not by the model (§12.2). The browser pair
  // is one source with a picture and a sound — two ports, one `sourceKey`, so
  // "the video is on the stream but its audio is not" stays expressible.
  model({
    id: "m_obs",
    name: "OBS Studio",
    category: "software_broadcast",
    internalRouting: "matrix",
    echoCancels: false,
    buses: [bus("program", "main"), bus("monitor", "monitor")],
    ports: [
      port({
        key: "audio_src",
        label: "音声ソース",
        direction: "in",
        signal: "audio_digital",
        expandable: true,
      }),
      port({
        key: "video_src",
        label: "映像ソース",
        direction: "in",
        signal: "video",
        expandable: true,
      }),
      port({
        key: "browser_audio",
        label: "ブラウザ音声",
        direction: "in",
        signal: "audio_digital",
        expandable: true,
        sourceKey: "browser",
      }),
      port({
        key: "browser_video",
        label: "ブラウザ映像",
        direction: "in",
        signal: "video",
        expandable: true,
        sourceKey: "browser",
      }),
      // A video file has no upstream — it is where the signal starts (§12.5).
      // Until a port could say that, playback was not an awkward thing to write
      // down but a kind of thing the graph did not have.
      port({
        key: "media_audio",
        label: "メディア音声",
        direction: "in",
        signal: "audio_digital",
        expandable: true,
        sourceKey: "media",
        origin: true,
      }),
      port({
        key: "media_video",
        label: "メディア映像",
        direction: "in",
        signal: "video",
        expandable: true,
        sourceKey: "media",
        origin: true,
      }),
      port({ key: "stream_out", direction: "out", signal: "audio_digital", busKey: "program" }),
      port({ key: "program_video", direction: "out", signal: "video", busKey: "program" }),
      port({ key: "monitor_out", direction: "out", signal: "audio_digital", busKey: "monitor" }),
    ],
    // A default naming a template follows every instance of it, so a source
    // arrives already on PROGRAM and nothing else does.
    defaultRoutes: [
      { inPort: "audio_src", bus: "program" },
      { inPort: "video_src", bus: "program" },
      { inPort: "browser_audio", bus: "program" },
      { inPort: "browser_video", bus: "program" },
      { inPort: "media_audio", bus: "program" },
      { inPort: "media_video", bus: "program" },
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
    echoCancels: false,
    ports: joinPorts(),
  }),
  model({
    id: "m_vdo",
    name: "VDO.Ninja",
    category: "software_conferencing",
    internalRouting: "none",
    echoCancels: false,
    ports: joinPorts(),
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
    echoCancels: false,
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
    echoCancels: false,
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
    echoCancels: false,
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
    echoCancels: false,
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
    echoCancels: false,
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
    echoCancels: false,
    ports: [
      port({ key: "in", direction: "in", signal: "audio_analog", connector: "trs", level: "line" }),
    ],
  }),
];

/**
 * The sources an OBS node starts with — what `add-node` puts on it (§12.8).
 *
 * Spelled out rather than derived, because a test that builds a document by
 * hand should show the instance keys its links and routing then reference.
 */
export const OBS_SOURCES: NodePort[] = [
  { key: "audio_src:1", template: "audio_src" },
  { key: "video_src:1", template: "video_src" },
];

export const DEVICES: Device[] = [
  { id: "d_mic1", modelId: "m_mic_dynamic", name: "ハンドマイク1" },
  { id: "d_mic2", modelId: "m_mic_dynamic", name: "ハンドマイク2" },
  { id: "d_condenser", modelId: "m_mic_condenser", name: "コンデンサーマイク" },
  { id: "d_mixer", modelId: "m_mixer", name: "ミキサー" },
  { id: "d_mixer2", modelId: "m_mixer", name: "別室ミキサー" },
  { id: "d_dsp", modelId: "m_dsp", name: "会議室DSP" },
  { id: "d_speaker", modelId: "m_speaker", name: "会場スピーカー" },
  { id: "d_speaker2", modelId: "m_speaker", name: "別室スピーカー" },
  { id: "d_pc", modelId: "m_pc", name: "配信PC" },
  { id: "d_laptop", modelId: "m_pc", name: "登壇者ノートPC" },
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
      {
        id: "n_join_stream",
        modelId: "m_meet",
        hostNodeId: "n_pc",
        spaceId: "sp_mtg",
        assignments: [{ port: "spk_out", hostPort: "usb_out" }],
      },
      { id: "n_laptop", deviceId: "d_laptop", spaceId: "sp_hall" },
      // One entry, not three: the built-in mic is a port of the laptop, so all
      // that is left to write down is which jack the presenter's Meet listens
      // on (§11.1).
      {
        id: "n_join_laptop",
        modelId: "m_meet",
        hostNodeId: "n_laptop",
        spaceId: "sp_mtg",
        assignments: [{ port: "mic_in", hostPort: "builtin_mic" }],
      },
    ],
    links: [
      { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
      { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
      { id: "l4", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
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
        assignments: [
          { port: "mic_in", hostPort: "usb_in" },
          { port: "spk_out", hostPort: "usb_out" },
        ],
      },
    ],
    links: [
      { id: `l${suffix}1`, from: [`n_mic_${suffix}`, "out"], to: [`n_mixer_${suffix}`, "ch1"] },
      {
        id: `l${suffix}2`,
        from: [`n_mixer_${suffix}`, "usb_send"],
        to: [`n_pc_${suffix}`, "usb_in"],
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
 * `twoJoinsInOneHall` with the guest moved home, which is the ordinary case and
 * a different finding.
 *
 * The loop is the same loop and it crosses the same meeting, but its return
 * into the guest's microphone now comes out of the speaker their own join is
 * playing to, with nothing in between — so their canceller holds both ends of
 * the reference (§9.7.4) and the hop it covers is enough to open the loop. The
 * hall mic is not routed to MAIN, so the transport cycle is again the only one
 * here and nothing can pass on plain howling.
 */
export function remoteGuestOnBuiltins(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_hall", kind: "acoustic", label: "メインホール" },
      { id: "sp_home", kind: "acoustic", label: "登壇者の自宅" },
      { id: "sp_mtg", kind: "transport", label: "登壇 Meet", meetingKey: "meet-abc" },
    ],
    nodes: [
      { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
      { id: "n_mixer", deviceId: "d_mixer", spaceId: "sp_hall" },
      { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
      { id: "n_pc", deviceId: "d_pc", spaceId: "sp_hall" },
      {
        id: "n_join_stream",
        modelId: "m_meet",
        hostNodeId: "n_pc",
        spaceId: "sp_mtg",
        assignments: [
          { port: "mic_in", hostPort: "usb_in" },
          { port: "spk_out", hostPort: "usb_out" },
        ],
      },
      { id: "n_laptop", deviceId: "d_laptop", spaceId: "sp_home" },
      // Both jacks, where `twoJoinsInOneHall` has only the microphone. That one
      // line is the whole difference between a loop AEC can help with and a loop
      // it cannot: there, the sound arrived through the hall PA, which this join
      // never played to.
      {
        id: "n_join_guest",
        modelId: "m_meet",
        hostNodeId: "n_laptop",
        spaceId: "sp_mtg",
        assignments: [
          { port: "mic_in", hostPort: "builtin_mic" },
          { port: "spk_out", hostPort: "builtin_spk" },
        ],
      },
    ],
    links: [
      { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
      { id: "l2", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
      { id: "l3", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
      { id: "l4", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
    ],
    // Mix-Minus, correctly: what came back from the meeting reaches the room and
    // not the send. The loop survives it, because it closes through the air.
    routing: [
      { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
      { nodeId: "n_mixer", inPort: "usb_in", bus: "main" },
    ],
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
      { id: "n_laptop", deviceId: "d_laptop", spaceId: "sp_hall" },
      // §11.1's table, after the built-in transducers became ports and the
      // selections left `links`: two ledger rows and two non-existent cables
      // are gone, and what is left is the two device selections — which is the
      // only part anybody actually chose. The document now has no cables at
      // all, which is the truth about a laptop sitting on its own.
      {
        id: "n_join",
        modelId: "m_meet",
        hostNodeId: "n_laptop",
        assignments: [
          { port: "spk_out", hostPort: "builtin_spk" },
          { port: "mic_in", hostPort: "builtin_mic" },
        ],
      },
    ],
    links: [],
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
      {
        id: "n_join",
        modelId: "m_meet",
        hostNodeId: "n_pc",
        spaceId: "sp_mtg",
        assignments: [
          { port: "mic_in", hostPort: "usb_in" },
          { port: "spk_out", hostPort: "usb_out" },
        ],
      },
    ],
    links: [
      { id: "l1", from: ["n_phone", "usb_out"], to: ["n_pc", "usb_in"] },
      { id: "l4", from: ["n_pc", "usb_out"], to: ["n_phone", "usb_in"] },
    ],
    routing: [],
  };
}

/**
 * The standard hybrid layout — §12.1's table, and §12's acceptance condition.
 *
 * The hall mic and the meeting are two rows of OBS's mixer, so the meeting can
 * be monitored into the room while the hall mic is not. With one 音声ソース row
 * this was unwritable: turning MONITOR on dragged the hall mic along with it,
 * `stream-monitor-loop` fired critical, and the fix the linter offered was to
 * take the remote participants out of the room — the opposite of the operation
 * anyone wanted (§4.3).
 *
 * One critical does remain, and it is a true one: the meeting comes out of the
 * PA, the hall mic hears the room, and that return goes back into the meeting
 * through the air. No routing change removes it — mix-minus works on buses, not
 * on rooms — which is why it is `remote-echo-acoustic` and not a monitor loop.
 */
export function hybridMonitorMix(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_hall", kind: "acoustic", label: "メインホール" },
      { id: "sp_mtg", kind: "transport", label: "登壇 Meet", meetingKey: "meet-hybrid" },
    ],
    nodes: [
      { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
      { id: "n_mixer", deviceId: "d_mixer", spaceId: "sp_hall" },
      { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
      { id: "n_pc", deviceId: "d_pc", spaceId: "sp_hall" },
      {
        id: "n_obs",
        modelId: "m_obs",
        hostNodeId: "n_pc",
        ports: [
          { key: "audio_src:1", template: "audio_src", label: "登壇者マイク" },
          { key: "browser_audio:1", template: "browser_audio", label: "Meet", sourceId: "s1" },
          { key: "browser_video:1", template: "browser_video", label: "Meet", sourceId: "s1" },
        ],
        // Both apps capture from the same USB input of the PC. Device
        // selections, not cables — nobody plugs anything in to make these true.
        assignments: [
          { port: "audio_src:1", hostPort: "usb_in" },
          { port: "monitor_out", hostPort: "usb_out" },
        ],
      },
      {
        id: "n_join",
        modelId: "m_meet",
        hostNodeId: "n_pc",
        spaceId: "sp_mtg",
        assignments: [{ port: "mic_in", hostPort: "usb_in" }],
      },
    ],
    links: [
      { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
      { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
      // OBS grabbing the Meet window never leaves the machine, so no OS audio
      // device is involved. Two apps on one host, so the graph reads these as
      // `capture` — the legitimate bypass §12.4.1 asked for a name for.
      { id: "l5", from: ["n_join", "spk_out"], to: ["n_obs", "browser_audio:1"] },
      { id: "l6", from: ["n_join", "cam_video_out"], to: ["n_obs", "browser_video:1"] },
      { id: "l8", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
      { id: "l9", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
    ],
    routing: [
      // Mix-Minus: the hall mic goes out over USB, and what comes back over USB
      // goes to the PA. Neither bus carries the other.
      { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
      { nodeId: "n_mixer", inPort: "usb_in", bus: "main" },
      { nodeId: "n_obs", inPort: "audio_src:1", bus: "program" },
      { nodeId: "n_obs", inPort: "browser_audio:1", bus: "program" },
      { nodeId: "n_obs", inPort: "browser_video:1", bus: "program" },
      // The cell that used to be impossible: the meeting is monitored into the
      // room and the hall mic is not.
      { nodeId: "n_obs", inPort: "browser_audio:1", bus: "monitor" },
    ],
  };
}

/**
 * The opening video plays, and only the remote participants hear silence.
 *
 * §12.6 calls this one of the commonest hybrid accidents there is, and until a
 * source could have no upstream the linter could not see the video at all: the
 * graph knew signals that began at a cable and signals that began in a room,
 * and playback is neither.
 *
 * Everything else here is a correct setup. Mix-Minus is intact — the hall mic
 * leaves over USB and what comes back goes to the PA — and the hall mic is
 * deliberately kept out of the PA, which is how howling is avoided and which
 * draws exactly the `source-not-reaching-room` info the rule is kept at info
 * for. The only thing actually wrong is which buses the video is on: PROGRAM
 * and nothing else.
 *
 * The meeting's own audio is not brought into the room, which keeps this
 * fixture about one finding. That is a relay, not a conversation.
 */
export function mediaSourceOnStream(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_hall", kind: "acoustic", label: "メインホール" },
      { id: "sp_mtg", kind: "transport", label: "登壇 Meet", meetingKey: "meet-media" },
    ],
    nodes: [
      { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
      { id: "n_mixer", deviceId: "d_mixer", spaceId: "sp_hall" },
      { id: "n_speaker", deviceId: "d_speaker", spaceId: "sp_hall" },
      { id: "n_pc", deviceId: "d_pc", spaceId: "sp_hall" },
      {
        id: "n_obs",
        modelId: "m_obs",
        hostNodeId: "n_pc",
        ports: [
          { key: "audio_src:1", template: "audio_src", label: "登壇者マイク" },
          {
            key: "media_audio:1",
            template: "media_audio",
            label: "オープニング動画",
            sourceId: "s1",
          },
          {
            key: "media_video:1",
            template: "media_video",
            label: "オープニング動画",
            sourceId: "s1",
          },
        ],
        assignments: [
          { port: "audio_src:1", hostPort: "usb_in" },
          { port: "monitor_out", hostPort: "usb_out" },
        ],
      },
      {
        id: "n_join",
        modelId: "m_meet",
        hostNodeId: "n_pc",
        spaceId: "sp_mtg",
        assignments: [{ port: "mic_in", hostPort: "usb_in" }],
      },
    ],
    links: [
      { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
      { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
      { id: "l6", from: ["n_pc", "usb_out"], to: ["n_mixer", "usb_in"] },
      { id: "l7", from: ["n_mixer", "main_out"], to: ["n_speaker", "in"] },
    ],
    routing: [
      { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
      { nodeId: "n_mixer", inPort: "usb_in", bus: "main" },
      { nodeId: "n_obs", inPort: "audio_src:1", bus: "program" },
      { nodeId: "n_obs", inPort: "media_audio:1", bus: "program" },
      { nodeId: "n_obs", inPort: "media_video:1", bus: "program" },
    ],
  };
}

/**
 * A remote participant shares their screen, and the stream gets the picture
 * without the sound — §12.4's headline, and unwritable as a finding until the
 * model could say that two ports are one share.
 *
 * The mistake is upstream of OBS, which is why the finding names the meeting:
 * both of OBS's browser rows are on PROGRAM and perfectly correct. Only the
 * share's video half was ever captured.
 */
export function halfSharedScreen(): SetupDoc {
  return {
    schemaVersion: 1,
    spaces: [
      { id: "sp_hall", kind: "acoustic", label: "メインホール" },
      { id: "sp_mtg", kind: "transport", label: "登壇 Meet", meetingKey: "meet-share" },
    ],
    nodes: [
      { id: "n_mic", deviceId: "d_mic1", spaceId: "sp_hall" },
      { id: "n_mixer", deviceId: "d_mixer", spaceId: "sp_hall" },
      { id: "n_pc", deviceId: "d_pc", spaceId: "sp_hall" },
      {
        id: "n_obs",
        modelId: "m_obs",
        hostNodeId: "n_pc",
        ports: [
          { key: "audio_src:1", template: "audio_src", label: "登壇者マイク" },
          {
            key: "browser_audio:1",
            template: "browser_audio",
            label: "リモート画面共有",
            sourceId: "s1",
          },
          {
            key: "browser_video:1",
            template: "browser_video",
            label: "リモート画面共有",
            sourceId: "s1",
          },
        ],
        assignments: [{ port: "audio_src:1", hostPort: "usb_in" }],
      },
      {
        id: "n_join",
        modelId: "m_meet",
        hostNodeId: "n_pc",
        spaceId: "sp_mtg",
        assignments: [{ port: "mic_in", hostPort: "usb_in" }],
      },
    ],
    links: [
      { id: "l1", from: ["n_mic", "out"], to: ["n_mixer", "ch1"] },
      { id: "l2", from: ["n_mixer", "usb_send"], to: ["n_pc", "usb_in"] },
      // The share's picture was captured and its sound was not.
      { id: "l5", from: ["n_join", "share_video_out"], to: ["n_obs", "browser_video:1"] },
    ],
    routing: [
      { nodeId: "n_mixer", inPort: "ch1", bus: "usb" },
      { nodeId: "n_obs", inPort: "audio_src:1", bus: "program" },
      { nodeId: "n_obs", inPort: "browser_audio:1", bus: "program" },
      { nodeId: "n_obs", inPort: "browser_video:1", bus: "program" },
    ],
  };
}

export function testContext(overrides: Partial<LintContext> = {}): LintContext {
  return {
    models: new Map(MODELS.map((entry) => [entry.id, entry])),
    devices: new Map(DEVICES.map((entry) => [entry.id, entry])),
    ...overrides,
  };
}
