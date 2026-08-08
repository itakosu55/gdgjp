/**
 * Device catalog types — the TypeScript view of `device_models`, its ports and
 * buses, and `devices` (the shared 機材台帳).
 *
 * These are plain data. Nothing here touches D1; the loader that maps rows onto
 * these types lives with the routes.
 */

export type PortDirection = "in" | "out";

/** `av` is HDMI/SDI, which carries audio and video down one cable. */
export type SignalKind = "audio_analog" | "audio_digital" | "video" | "av";

export type ConnectorKind =
  | "xlr"
  | "trs"
  | "ts"
  | "trs_mini"
  | "rca"
  | "hdmi"
  | "sdi"
  | "usb_b"
  | "usb_c"
  | "speakon"
  | "none";

export type LevelKind = "mic" | "line" | "instrument" | "speaker";

/** `damaged_by` marks ribbon mics and similar gear that +48V can destroy. */
export type PhantomRole = "provides" | "requires" | "damaged_by" | "none";

export type BusKind = "main" | "aux" | "usb" | "monitor" | "sub";

/**
 * How signal moves between a device's own ports.
 *
 * - `matrix` — the (input × bus) matrix stored on the setup decides. Mixers.
 * - `passthrough` — every input reaches every same-medium output. DI boxes,
 *   wireless receivers, and 会場常設 PA whose internals nobody can see.
 * - `none` — inputs and outputs are unrelated. Endpoints (mics, speakers) and
 *   conferencing apps, where the local mic is emphatically NOT routed to the
 *   local speaker.
 */
export type InternalRouting = "matrix" | "passthrough" | "none";

export type DeviceCategory =
  | "mic"
  | "headphone"
  | "speaker"
  | "mixer"
  | "audio_interface"
  | "di"
  | "wireless_rx"
  | "recorder"
  | "camera"
  | "switcher"
  | "capture"
  | "display"
  | "computer"
  | "software_broadcast"
  | "software_conferencing"
  | "blackbox"
  | "generic";

export type DeviceModelBus = {
  key: string;
  label: string;
  kind: BusKind;
};

export type DeviceModelPort = {
  key: string;
  label: string;
  direction: PortDirection;
  signal: SignalKind;
  connector: ConnectorKind;
  level: LevelKind | null;
  channels: number;
  phantom: PhantomRole;
  /** Output ports belong to a bus; input ports carry `null`. */
  busKey: string | null;
};

export type DeviceModel = {
  id: string;
  maker: string | null;
  name: string;
  category: DeviceCategory;
  internalRouting: InternalRouting;
  buses: DeviceModelBus[];
  ports: DeviceModelPort[];
  /** Template rows copied into a setup's routing matrix when a node is added. */
  defaultRoutes: { inPort: string; bus: string }[];
};

/** One physical unit in the shared 機材台帳. */
export type Device = {
  id: string;
  modelId: string;
  name: string;
  identifier?: string | null;
};

export type Medium = "audio" | "video";

export function portMedia(signal: SignalKind): Medium[] {
  switch (signal) {
    case "audio_analog":
    case "audio_digital":
      return ["audio"];
    case "video":
      return ["video"];
    case "av":
      return ["audio", "video"];
  }
}

export function isAnalogAudio(signal: SignalKind): boolean {
  return signal === "audio_analog";
}

/**
 * The three things a signal can cross that is not a cable.
 *
 * `transport` is an online meeting (Meet, VDO.Ninja). Treating it as a space
 * rather than a device is what makes a loop through two joins of the same
 * meeting reachable by the one cycle search — a presenter's laptop sharing
 * their screen from inside the room closes a loop AEC cannot cancel, because
 * the sound came back through *another* join's speaker and has no reference
 * signal. See docs/260805_stream_av_designer.md §9.
 */
export const SPACE_KINDS = ["acoustic", "visual", "transport"] as const;
export type SpaceKind = (typeof SPACE_KINDS)[number];

/**
 * `from_space` — the device picks the medium up out of the space, so the space
 * feeds its outputs (mics, cameras, and a join receiving the meeting).
 * `to_space` — the device emits into the space, so its inputs feed the space
 * (speakers, displays, and a join sending into the meeting).
 */
export type CouplingDirection = "from_space" | "to_space";

export type SpaceCoupling = {
  spaceKind: SpaceKind;
  /** A join both sends into its meeting and receives from it, so it has two. */
  directions: readonly CouplingDirection[];
  /**
   * Whether leaving the space blank is worth a warning.
   *
   * A mic with no room makes howling undetectable, so it is. A join with no
   * meeting is the ordinary case — one online speaker, far side not modelled —
   * and charging the commonest setup extra data entry for nothing is exactly
   * what §9.3 forbids.
   */
  spaceRequired: boolean;
};

/**
 * The implicit edges that make howling and the infinite-mirror detectable.
 * Headphones and in-ear monitors are deliberately absent: they never couple.
 */
export const CATEGORY_SPACE_COUPLING: Partial<Record<DeviceCategory, SpaceCoupling>> = {
  mic: { spaceKind: "acoustic", directions: ["from_space"], spaceRequired: true },
  speaker: { spaceKind: "acoustic", directions: ["to_space"], spaceRequired: true },
  camera: { spaceKind: "visual", directions: ["from_space"], spaceRequired: true },
  display: { spaceKind: "visual", directions: ["to_space"], spaceRequired: true },
  software_conferencing: {
    spaceKind: "transport",
    directions: ["to_space", "from_space"],
    spaceRequired: false,
  },
};

/**
 * What a space can carry. Air carries sound and sight carries pictures, but a
 * meeting carries both, so the single medium the older code derived from the
 * space kind is not enough — a port's own signal has to narrow it.
 */
export const SPACE_MEDIA: Record<SpaceKind, readonly Medium[]> = {
  acoustic: ["audio"],
  visual: ["video"],
  transport: ["audio", "video"],
};

/** Connectors that mate without an adapter. */
const CONNECTOR_FAMILIES: ConnectorKind[][] = [
  ["xlr"],
  ["trs", "ts", "trs_mini"],
  ["rca"],
  ["hdmi"],
  ["sdi"],
  ["usb_b", "usb_c"],
  ["speakon"],
];

export function connectorFamily(connector: ConnectorKind): number | null {
  if (connector === "none") return null;
  const index = CONNECTOR_FAMILIES.findIndex((family) => family.includes(connector));
  return index === -1 ? null : index;
}

export function describeDevice(model: DeviceModel): string {
  return model.maker ? `${model.maker} ${model.name}` : model.name;
}
