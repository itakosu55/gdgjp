import type { LintContext } from "./diagnostics";
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
  };
}

function bus(key: string, kind: DeviceModelBus["kind"]): DeviceModelBus {
  return { key, label: key, kind };
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
      port({ key: "in", direction: "in", signal: "audio_analog", connector: "trs", level: "line" }),
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
    // the local speaker, and pretending it does invents an echo loop.
    internalRouting: "none",
    ports: [
      port({ key: "mic_in", direction: "in", signal: "audio_digital" }),
      port({ key: "spk_out", direction: "out", signal: "audio_digital" }),
    ],
  }),
  model({
    id: "m_camera",
    name: "Camcorder",
    category: "camera",
    internalRouting: "none",
    ports: [port({ key: "hdmi_out", direction: "out", signal: "video", connector: "hdmi" })],
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
    ports: [port({ key: "hdmi_in", direction: "in", signal: "video", connector: "hdmi" })],
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
  { id: "d_speaker", modelId: "m_speaker", name: "会場スピーカー" },
  { id: "d_pc", modelId: "m_pc", name: "配信PC" },
  { id: "d_obs", modelId: "m_obs", name: "OBS" },
  { id: "d_meet", modelId: "m_meet", name: "Meet" },
  { id: "d_camera", modelId: "m_camera", name: "カメラ" },
  { id: "d_capture", modelId: "m_capture", name: "キャプチャ" },
  { id: "d_projector", modelId: "m_projector", name: "プロジェクタ" },
  { id: "d_house_pa", modelId: "m_house_pa", name: "会場PA" },
  { id: "d_recorder", modelId: "m_recorder", name: "レコーダー" },
];

export function testContext(overrides: Partial<LintContext> = {}): LintContext {
  return {
    models: new Map(MODELS.map((entry) => [entry.id, entry])),
    devices: new Map(DEVICES.map((entry) => [entry.id, entry])),
    ...overrides,
  };
}
