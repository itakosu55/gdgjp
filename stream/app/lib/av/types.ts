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
  /**
   * Which face of a space this jack is, or `null` for one that touches no
   * space.
   *
   * What couples to a room is not the device but the transducer, and a
   * transducer is a port: a laptop is a mic *and* a speaker *and* six jacks
   * that are neither, and a USB speakerphone is one unit with both faces. The
   * direction cannot be derived — a mic's OUT and a speaker's IN are both "the
   * jack facing the room" and point opposite ways — so it is stated. See
   * docs/260805_stream_av_designer.md §11.
   */
  couples: CouplingDirection | null;
  /**
   * A template rather than a jack: the setup decides how many there are.
   *
   * A physical mixer's channel count is a property of the model. OBS's is not —
   * its audio mixer has one strip per source, and the sources are chosen on the
   * day. So the model declares *what kinds* of input exist and the document
   * declares how many and what each one is (§12.2). Everything but `key` and
   * `label` is inherited by the instances, which is what keeps the catalog the
   * authority on what an OBS is.
   */
  expandable: boolean;
  /**
   * Names the source that this port is one half of, or `null`.
   *
   * A browser source and a screen share are one thing with a picture and a
   * sound, and staying two ports is what keeps "the video is on the stream but
   * its audio is not" expressible (§9.7.2). What was missing is not fewer ports
   * but the *name of the relationship*, so the two can be added in one
   * operation and asked one question. Ports of one model sharing a `sourceKey`
   * are the halves of one source.
   */
  sourceKey: string | null;
  /**
   * An input that needs nothing upstream: BGM, a video file, a title card.
   *
   * Media playback is where a signal starts, and until now the only starting
   * points in the graph were the far end of a cable and a space vertex. An
   * origin port is a row in the mixer that no cable reaches and that
   * reachability searches may start from (§12.5).
   */
  origin: boolean;
};

export type DeviceModel = {
  id: string;
  maker: string | null;
  name: string;
  category: DeviceCategory;
  internalRouting: InternalRouting;
  /**
   * This unit subtracts what it played out of what it picked up: it carries an
   * acoustic echo canceller. A spec-sheet fact about the model, like `couples`
   * or `phantom`, and not a claim about any particular room — whether it can
   * actually cancel depends on the wiring, which is §9.7.4's job to check.
   */
  echoCancels: boolean;
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

/**
 * When leaving 所在 blank is worth a warning.
 *
 * - `always` — the device *is* a transducer, so not knowing its room makes
 *   howling undetectable from the moment it is added.
 * - `when-wired` — the transducer is incidental to the device: a laptop's
 *   built-in mic, a USB speakerphone's two faces. Charging every streaming PC a
 *   warning for a jack nobody selected is what §9.3 forbids, but once something
 *   is plugged into that jack the missing room is a real hole — that is §9.1's
 *   accident, the presenter's own machine picking the room up.
 * - `never` — a meeting nobody wrote down is an ordinary, finished document.
 *   One online speaker with the far side unmodelled is the commonest setup
 *   there is.
 *
 * This is §11.6's open question ("`spaceRequired` 相当の逃げ道をポート側に持たせるかは
 * 実装時に決める") answered: the escape stays on the category, because what
 * differs is not the jack but whether being this kind of device is itself the
 * reason to know the room.
 */
export type SpaceNeed = "always" | "when-wired" | "never";

export type CategoryCoupling = {
  /**
   * What a new port of this direction couples to when the catalog does not
   * say. Choosing 「マイク」 in the catalog should fill the jack in for you;
   * that is all the category decides now.
   */
  defaults: Partial<Record<PortDirection, CouplingDirection>>;
  spaceNeed: SpaceNeed;
};

/**
 * The category's opinion about space coupling — a default and a warning
 * policy, and nothing the graph reads.
 *
 * Coupling itself moved onto the port (§11.2). Headphones and in-ear monitors
 * are still deliberately absent: they never couple, so a new headphone model's
 * jacks start uncoupled.
 */
export const CATEGORY_COUPLING: Partial<Record<DeviceCategory, CategoryCoupling>> = {
  mic: { defaults: { out: "from_space" }, spaceNeed: "always" },
  speaker: { defaults: { in: "to_space" }, spaceNeed: "always" },
  camera: { defaults: { out: "from_space" }, spaceNeed: "always" },
  display: { defaults: { in: "to_space" }, spaceNeed: "always" },
  software_conferencing: {
    defaults: { in: "to_space", out: "from_space" },
    spaceNeed: "never",
  },
};

/**
 * `when-wired` is the default because a coupling port on a category that is not
 * wholly a transducer — a computer, an audio interface — is exactly the case
 * §11.6 called the heaviest price of moving coupling onto ports.
 */
export function spaceNeedOf(category: DeviceCategory): SpaceNeed {
  return CATEGORY_COUPLING[category]?.spaceNeed ?? "when-wired";
}

/** The coupling a new catalog port gets when the form leaves it on 自動. */
export function defaultCoupling(
  category: DeviceCategory,
  direction: PortDirection,
): CouplingDirection | null {
  return CATEGORY_COUPLING[category]?.defaults[direction] ?? null;
}

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
