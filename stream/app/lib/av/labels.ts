import type { PlaceKind } from "./places";
import type {
  ConnectorKind,
  CouplingDirection,
  DeviceCategory,
  InternalRouting,
  LevelKind,
  PhantomRole,
  SignalKind,
} from "./types";
import type { BusKind, SpaceKind } from "./types";

/** Japanese labels for the enums, used by every form in the app. */

export const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  mic: "マイク",
  headphone: "ヘッドホン・イヤモニ",
  speaker: "スピーカー",
  mixer: "ミキサー",
  audio_interface: "オーディオインターフェイス",
  di: "DI ボックス",
  wireless_rx: "ワイヤレス受信機",
  recorder: "レコーダー",
  camera: "カメラ",
  switcher: "スイッチャー",
  capture: "キャプチャ",
  display: "ディスプレイ・プロジェクタ",
  computer: "PC",
  software_broadcast: "配信ソフト",
  software_conferencing: "会議ソフト",
  blackbox: "内部不明 (会場常設など)",
  generic: "その他",
};

export const INTERNAL_ROUTING_LABELS: Record<InternalRouting, string> = {
  matrix: "matrix — 入力 × バスの行列に従う",
  passthrough: "passthrough — 全入力が全出力へ流れる",
  none: "none — 入力と出力は無関係",
};

export const SIGNAL_LABELS: Record<SignalKind, string> = {
  audio_analog: "音声 (アナログ)",
  audio_digital: "音声 (デジタル)",
  video: "映像",
  av: "映像＋音声 (HDMI/SDI)",
};

export const CONNECTOR_LABELS: Record<ConnectorKind, string> = {
  xlr: "XLR",
  trs: "TRS (6.3mm)",
  ts: "TS (6.3mm)",
  trs_mini: "3.5mm ミニ",
  rca: "RCA",
  hdmi: "HDMI",
  sdi: "SDI",
  usb_b: "USB-B",
  usb_c: "USB-C",
  speakon: "Speakon",
  none: "なし (ソフトウェア内部)",
};

export const LEVEL_LABELS: Record<LevelKind, string> = {
  mic: "マイクレベル",
  line: "ラインレベル",
  instrument: "楽器レベル",
  speaker: "スピーカーレベル",
};

export const PHANTOM_LABELS: Record<PhantomRole, string> = {
  none: "関係なし",
  provides: "+48V を供給できる",
  requires: "+48V が必要",
  damaged_by: "+48V で破損する (リボン等)",
};

export const BUS_KIND_LABELS: Record<BusKind, string> = {
  main: "MAIN",
  aux: "AUX",
  usb: "USB",
  monitor: "MONITOR",
  sub: "SUB",
};

export const SPACE_KIND_LABELS: Record<SpaceKind, string> = {
  acoustic: "音響空間 (スピーカー → 空気 → マイク)",
  visual: "視覚空間 (スクリーン → 視界 → カメラ)",
  transport: "伝送空間 (join → ミーティング → 他の join)",
};

/**
 * What a *room* has, for the form that creates one.
 *
 * Not `SPACE_KIND_LABELS` with the parenthetical dropped: that one names the
 * spaces from the graph's side, and a space is a modelling detail. Someone
 * registering a hall knows whether there is sound in it and whether there is a
 * picture; that the two are separate vertices is the app's business.
 */
export const PLACE_MEDIA_LABELS: Record<PlaceKind, string> = {
  acoustic: "音がある",
  visual: "画がある",
};

/** The one-word form used in lists, where the parenthetical would not fit. */
export const SPACE_KIND_SHORT_LABELS: Record<SpaceKind, string> = {
  acoustic: "音響",
  visual: "視覚",
  transport: "伝送",
};

/**
 * What the space physically is, for the diagram.
 *
 * A space drawn inside the frame of the room it belongs to must not repeat the
 * room's name — the frame already says it. What is left to say is which of the
 * room's media this box carries.
 */
export const SPACE_MEDIUM_LABELS: Record<SpaceKind, string> = {
  acoustic: "空気",
  visual: "視界",
  transport: "ミーティング",
};

/**
 * A jack's own relationship with the room, which is not its direction: a mic's
 * OUT and a speaker's IN both face the room and point opposite ways.
 */
export const COUPLES_LABELS: Record<CouplingDirection, string> = {
  from_space: "from_space — 空間から拾う (マイク・カメラ)",
  to_space: "to_space — 空間へ出す (スピーカー・ディスプレイ)",
};

/** For the ports table, where the parenthetical would not fit. */
export const COUPLES_SHORT_LABELS: Record<CouplingDirection, string> = {
  from_space: "空間から拾う",
  to_space: "空間へ出す",
};

export const COUPLING_LABELS = {
  open: "open — 空間と結合する",
  isolated: "isolated — 結合しない (ヘッドセット・配信専用など)",
} as const;

export function entries<T extends Record<string, string>>(map: T): [keyof T & string, string][] {
  return Object.entries(map) as [keyof T & string, string][];
}
