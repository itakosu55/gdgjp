import {
  AudioWaveform,
  Box,
  ChevronDown,
  Circle,
  Headphones,
  Laptop,
  Mic,
  Monitor,
  MonitorPlay,
  Package,
  Radio,
  RadioReceiver,
  Shuffle,
  SlidersHorizontal,
  Users,
  Video,
  Volume2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import type { Severity } from "~/lib/av/diagnostics";
import { SPACE_KIND_SHORT_LABELS } from "~/lib/av/labels";
import type { SetupDoc, Space } from "~/lib/av/schema";
import type { DeviceCategory } from "~/lib/av/types";
import type { NodeInfo, Place } from "~/lib/setup-view";
import { collectPlaces, meetingOfNode, placeOfNode } from "~/lib/setup-view";
import { cn } from "~/lib/utils";

/**
 * What the setup contains, as 所在 → 機械 → アプリ.
 *
 * The nesting mirrors the diagram's box-inside-box exactly, so the two screens
 * describe the same document the same way. A join is the one thing that is in
 * two places at once — inside its host computer, and in a meeting — and a tree
 * can only express one of them as nesting. The machine wins, because "where the
 * laptop is" is how someone on site thinks about it and a meeting is not a place
 * you can walk into; the meeting rides along as a chip on the row, and the
 * transport spaces get their own section at the bottom.
 */

const CATEGORY_ICON: Record<DeviceCategory, typeof Mic> = {
  mic: Mic,
  headphone: Headphones,
  speaker: Volume2,
  mixer: SlidersHorizontal,
  audio_interface: AudioWaveform,
  di: Box,
  wireless_rx: RadioReceiver,
  recorder: Circle,
  camera: Video,
  switcher: Shuffle,
  capture: MonitorPlay,
  display: Monitor,
  computer: Laptop,
  software_broadcast: Radio,
  software_conferencing: Users,
  blackbox: Package,
  generic: Circle,
};

export type TreeSeverities = {
  byNode: Map<string, Severity>;
  bySpace: Map<string, Severity>;
};

export function SetupTree({
  doc,
  nodeInfo,
  severities,
  selection,
  hrefFor,
  onSelect,
}: {
  doc: SetupDoc;
  nodeInfo: NodeInfo[];
  severities: TreeSeverities;
  /** `<nodeId>`, `space:<spaceId>` or `null`. */
  selection: string | null;
  hrefFor: (selection: string) => string;
  /** Fired on every row, so a narrow screen can put the drawer away. */
  onSelect?: () => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const places = collectPlaces(doc);
  const byId = new Map(nodeInfo.map((info) => [info.node.id, info]));
  const childrenOf = new Map<string, NodeInfo[]>();
  for (const info of nodeInfo) {
    const host = info.node.hostNodeId;
    // An app whose host was deleted is not inside anything, so it stands on its
    // own rather than disappearing from the only list that can remove it.
    if (!host || !byId.has(host)) continue;
    childrenOf.set(host, [...(childrenOf.get(host) ?? []), info]);
  }
  const roots = nodeInfo.filter((info) => !info.node.hostNodeId || !byId.has(info.node.hostNodeId));
  // An app's 所在 is its meeting, so it follows the machine it runs on.
  const placeOf = (info: NodeInfo) => placeOfNode(doc, info.node);
  const meetings = doc.spaces.filter((space) => space.kind === "transport");
  const unplaced = roots.filter((info) => placeOf(info) === null);

  if (nodeInfo.length === 0 && doc.spaces.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        ＋ から機材と空間を追加してください。
      </p>
    );
  }

  return (
    <div className="py-1.5 pb-4">
      {places.map((place) => (
        <PlaceGroup
          key={place.key}
          place={place}
          open={!collapsed.has(place.key)}
          onToggle={() => toggle(place.key)}
          href={hrefFor(`space:${place.spaceIds[0]}`)}
          selected={place.spaceIds.some((id) => selection === `space:${id}`)}
          severity={worstOf(place.spaceIds.map((id) => severities.bySpace.get(id)))}
          onSelect={onSelect}
        >
          {roots
            .filter((info) => placeOf(info) === place.key)
            .map((info) => (
              <NodeRows
                key={info.node.id}
                doc={doc}
                info={info}
                apps={childrenOf.get(info.node.id) ?? []}
                severities={severities}
                selection={selection}
                hrefFor={hrefFor}
                onSelect={onSelect}
              />
            ))}
        </PlaceGroup>
      ))}

      {unplaced.length > 0 ? (
        <PlaceGroup
          place={{ key: "unplaced", label: "所在未設定", kinds: [], spaceIds: [] }}
          open={!collapsed.has("unplaced")}
          onToggle={() => toggle("unplaced")}
          href={null}
          selected={false}
          severity={undefined}
        >
          {unplaced.map((info) => (
            <NodeRows
              key={info.node.id}
              doc={doc}
              info={info}
              apps={childrenOf.get(info.node.id) ?? []}
              severities={severities}
              selection={selection}
              hrefFor={hrefFor}
              onSelect={onSelect}
            />
          ))}
        </PlaceGroup>
      ) : null}

      {meetings.length > 0 ? (
        <>
          <p className="mx-3 mt-2.5 border-t border-border pt-2 text-[10px] tracking-wider text-muted-foreground uppercase">
            ミーティング（伝送空間）
          </p>
          {meetings.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              joins={nodeInfo.filter((info) => info.node.spaceId === meeting.id).length}
              href={hrefFor(`space:${meeting.id}`)}
              selected={selection === `space:${meeting.id}`}
              severity={severities.bySpace.get(meeting.id)}
              onSelect={onSelect}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function PlaceGroup({
  place,
  open,
  onToggle,
  href,
  selected,
  severity,
  onSelect,
  children,
}: {
  place: Place;
  open: boolean;
  onToggle: () => void;
  href: string | null;
  selected: boolean;
  severity: Severity | undefined;
  onSelect?: () => void;
  children: ReactNode;
}) {
  const kinds = place.kinds.map((kind) => SPACE_KIND_SHORT_LABELS[kind]).join("・");
  return (
    <div>
      <div className="flex items-center gap-1 px-2 pt-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${place.label} を${open ? "折りたたむ" : "展開する"}`}
          className="rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />
        </button>
        <GroupName href={href} selected={selected} label={place.label} onSelect={onSelect} />
        {severity ? <SeverityDot severity={severity} /> : null}
        {kinds ? <span className="text-[10px] text-muted-foreground">{kinds}</span> : null}
      </div>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

function GroupName({
  href,
  selected,
  label,
  onSelect,
}: {
  href: string | null;
  selected: boolean;
  label: string;
  onSelect?: () => void;
}) {
  const className = cn(
    "min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left text-xs font-semibold tracking-wide",
    selected && "bg-primary/10 text-primary",
  );
  if (!href) return <span className={cn(className, "text-muted-foreground")}>{label}</span>;
  return (
    <Link to={href} replace onClick={onSelect} className={cn(className, "hover:bg-secondary")}>
      {label}
    </Link>
  );
}

function NodeRows({
  doc,
  info,
  apps,
  severities,
  selection,
  hrefFor,
  onSelect,
}: {
  doc: SetupDoc;
  info: NodeInfo;
  apps: NodeInfo[];
  severities: TreeSeverities;
  selection: string | null;
  hrefFor: (selection: string) => string;
  onSelect?: () => void;
}) {
  return (
    <>
      <NodeRow
        doc={doc}
        info={info}
        nested={false}
        severity={severities.byNode.get(info.node.id)}
        selected={selection === info.node.id}
        href={hrefFor(info.node.id)}
        onSelect={onSelect}
      />
      {apps.map((child) => (
        <NodeRow
          key={child.node.id}
          doc={doc}
          info={child}
          nested={true}
          severity={severities.byNode.get(child.node.id)}
          selected={selection === child.node.id}
          href={hrefFor(child.node.id)}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function NodeRow({
  doc,
  info,
  nested,
  severity,
  selected,
  href,
  onSelect,
}: {
  doc: SetupDoc;
  info: NodeInfo;
  nested: boolean;
  severity: Severity | undefined;
  selected: boolean;
  href: string;
  onSelect?: () => void;
}) {
  const Icon = info.model ? CATEGORY_ICON[info.model.category] : Circle;
  const meeting = meetingOfNode(doc, info.node);
  const subtitle = [info.model?.name, info.device?.name === info.label ? null : info.device?.name]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link
      to={href}
      replace
      onClick={onSelect}
      data-node-id={info.node.id}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 border-transparent py-1 pr-2.5 text-sm hover:bg-secondary",
        nested ? "pl-10" : "pl-6",
        selected && "border-l-primary bg-primary/10",
      )}
    >
      <Icon
        className={cn("size-3.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{info.label}</span>
        {subtitle ? (
          <span className="truncate text-[10px] text-muted-foreground">{subtitle}</span>
        ) : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {meeting ? (
          <span className="rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
            {meeting.label}
          </span>
        ) : null}
        {severity ? <SeverityDot severity={severity} /> : null}
      </span>
    </Link>
  );
}

function MeetingRow({
  meeting,
  joins,
  href,
  selected,
  severity,
  onSelect,
}: {
  meeting: Space;
  joins: number;
  href: string;
  selected: boolean;
  severity: Severity | undefined;
  onSelect?: () => void;
}) {
  return (
    <Link
      to={href}
      replace
      onClick={onSelect}
      data-space-id={meeting.id}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 border-l-2 border-transparent py-1 pr-2.5 pl-3 text-sm hover:bg-secondary",
        selected && "border-l-primary bg-primary/10",
      )}
    >
      <Users
        className={cn("size-3.5 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{meeting.label}</span>
        <span className="truncate text-[10px] text-muted-foreground">
          join {joins} 件{meeting.meetingKey ? ` · ${meeting.meetingKey}` : ""}
        </span>
      </span>
      {severity ? (
        <span className="ml-auto shrink-0">
          <SeverityDot severity={severity} />
        </span>
      ) : null}
    </Link>
  );
}

const DOT_STYLE: Record<Severity, string> = {
  critical: "bg-destructive",
  error: "bg-destructive/70",
  warn: "bg-amber-500",
  info: "bg-muted-foreground/50",
};

const DOT_LABEL: Record<Severity, string> = {
  critical: "重大",
  error: "エラー",
  warn: "警告",
  info: "情報",
};

function SeverityDot({ severity }: { severity: Severity }) {
  return (
    <span
      title={DOT_LABEL[severity]}
      aria-label={DOT_LABEL[severity]}
      className={cn("size-1.5 shrink-0 rounded-full", DOT_STYLE[severity])}
    />
  );
}

function worstOf(severities: (Severity | undefined)[]): Severity | undefined {
  const order: Severity[] = ["critical", "error", "warn", "info"];
  return order.find((severity) => severities.includes(severity));
}
