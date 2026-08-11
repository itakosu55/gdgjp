import type { ReactNode } from "react";
import { Link } from "react-router";
import { Field, selectClassName } from "~/components/page";
import { RoutingMatrix, hasMatrix } from "~/components/routing-matrix";
import { SetupForm } from "~/components/setup-form";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import {
  COUPLING_LABELS,
  SPACE_KIND_LABELS,
  SPACE_KIND_SHORT_LABELS,
  entries,
} from "~/lib/av/labels";
import type { SetupDoc, SetupLink, Space } from "~/lib/av/schema";
import type { NodeInfo } from "~/lib/setup-view";
import { collectPlaces, describePort, placeOfNode, portLabel, spacesFor } from "~/lib/setup-view";

/**
 * The right panel: everything about whatever is selected.
 *
 * This is where the per-node form from the old 機材 tab went, plus the routing
 * matrix and the links touching that node. Putting them together is the point of
 * the redesign: a finding that says "MG10XU の CH 2" used to need a tab switch
 * before anyone could act on it.
 */

export function SetupInspector({
  doc,
  nodeInfo,
  selection,
  computers,
  enabled,
  setupName,
  hrefFor,
  matrixInCenter,
}: {
  doc: SetupDoc;
  nodeInfo: NodeInfo[];
  /** `<nodeId>`, `space:<spaceId>`, `setup`, or `null`. */
  selection: string | null;
  computers: NodeInfo[];
  enabled: ReadonlySet<string>;
  setupName: string;
  hrefFor: (selection: string, view?: string) => string;
  /**
   * True while the centre pane is already showing every matrix. Rendering the
   * selected node's matrix here as well would put two live copies of the same
   * cells on screen, and two identical `CH1 → MAIN` buttons.
   */
  matrixInCenter: boolean;
}) {
  if (selection === "setup") return <SetupSettings doc={doc} setupName={setupName} />;

  if (selection?.startsWith("space:")) {
    const space = doc.spaces.find((entry) => entry.id === selection.slice("space:".length));
    if (space) {
      return <SpaceInspector doc={doc} space={space} nodeInfo={nodeInfo} hrefFor={hrefFor} />;
    }
  }

  const info = nodeInfo.find((entry) => entry.node.id === selection);
  if (!info) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
        左の一覧から機材を選ぶと、ここに詳細が出ます。
      </p>
    );
  }

  const isJoin = info.model?.category === "software_conferencing";
  const links = doc.links.filter(
    (link) => link.from[0] === info.node.id || link.to[0] === info.node.id,
  );
  const hostNodeId = info.node.hostNodeId;
  const assignments = info.node.assignments ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold tracking-tight">{info.label}</h2>
        <p className="text-xs text-muted-foreground">
          {[info.model?.name ?? "型番不明", info.device?.name].filter(Boolean).join(" · ")}
        </p>
      </div>

      <SetupForm className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="update-node" />
        <input type="hidden" name="nodeId" value={info.node.id} />
        <Field label="表示名" htmlFor={`label-${info.node.id}`}>
          <Input
            id={`label-${info.node.id}`}
            name="label"
            defaultValue={info.node.label ?? ""}
            placeholder={info.device?.name ?? ""}
            maxLength={120}
          />
        </Field>
        <Field
          label="所在"
          htmlFor={`space-${info.node.id}`}
          hint={
            isJoin
              ? "参加しているミーティング。"
              : "この機材が置かれている部屋。マイクとスピーカーはここで空間と結合します。"
          }
        >
          <select
            id={`space-${info.node.id}`}
            name="spaceId"
            defaultValue={info.node.spaceId ?? ""}
            className={selectClassName}
          >
            <option value="">（割り当てなし）</option>
            {spacesFor(doc, info.model).map((space) => (
              <option key={space.id} value={space.id}>
                {space.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="空間との結合" htmlFor={`coupling-${info.node.id}`}>
          <select
            id={`coupling-${info.node.id}`}
            name="coupling"
            defaultValue={info.node.coupling ?? "open"}
            className={selectClassName}
          >
            {entries(COUPLING_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <MutedPorts info={info} />
        <Field
          label="ホスト PC"
          htmlFor={`host-${info.node.id}`}
          hint="OBS や Meet はここで動く PC を指定します。"
        >
          <select
            id={`host-${info.node.id}`}
            name="hostNodeId"
            defaultValue={info.node.hostNodeId ?? ""}
            className={selectClassName}
          >
            <option value="">（なし）</option>
            {computers
              .filter((computer) => computer.node.id !== info.node.id)
              .map((computer) => (
                <option key={computer.node.id} value={computer.node.id}>
                  {computer.label}
                </option>
              ))}
          </select>
        </Field>
        <div>
          <Button type="submit" variant="secondary" size="sm">
            保存
          </Button>
        </div>
      </SetupForm>

      <Sources info={info} />

      {hasMatrix(info) && info.model ? (
        <section>
          <SectionHead title="ルーティング行列">
            <Link
              to={hrefFor(info.node.id, "routing")}
              replace
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              拡大
            </Link>
          </SectionHead>
          {matrixInCenter ? (
            <p className="text-xs text-muted-foreground">中央のルーティング面に表示しています。</p>
          ) : (
            <RoutingMatrix info={info} model={info.model} enabled={enabled} />
          )}
        </section>
      ) : null}

      <section>
        <SectionHead title="この機材の結線">
          <Link
            to={hrefFor(info.node.id, "cables")}
            replace
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            結線表へ
          </Link>
        </SectionHead>
        {links.length === 0 && assignments.length === 0 ? (
          <p className="text-xs text-muted-foreground">まだ結線されていません。</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.id}>
                <Wire nodeInfo={nodeInfo} link={link} info={info} />
              </li>
            ))}
            {hostNodeId
              ? assignments.map((assignment) => (
                  <li key={`assign:${assignment.port}`}>
                    <Assignment
                      nodeInfo={nodeInfo}
                      info={info}
                      hostNodeId={hostNodeId}
                      assignment={assignment}
                    />
                  </li>
                ))
              : null}
          </ul>
        )}
      </section>

      <SetupForm>
        <input type="hidden" name="intent" value="remove-node" />
        <input type="hidden" name="nodeId" value={info.node.id} />
        <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
          構成から外す
        </button>
      </SetupForm>
    </div>
  );
}

/**
 * Per-jack mutes, for the devices that have more than one face.
 *
 * A laptop is a mic and a speaker on one node, and so is a speakerphone, so the
 * node-wide `isolated` above cannot express what actually happens on the day:
 * mute the presenter's mic and let them keep hearing (§11.6). Only jacks that
 * face a space are listed — the rest have nothing to mute.
 */
function MutedPorts({ info }: { info: NodeInfo }) {
  const facing = info.ports.filter((port) => port.couples !== null);
  if (facing.length === 0) return null;
  const muted = new Set(info.node.isolatedPorts ?? []);

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium">端子ごとのミュート</legend>
      {/* Tells the action that this form carried the list at all; see applyIntent. */}
      <input type="hidden" name="isolatedPortsForm" value="1" />
      {facing.map((port) => (
        <label key={port.key} className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            name="isolatedPorts"
            value={port.key}
            defaultChecked={muted.has(port.key)}
            className="size-3.5 accent-primary"
          />
          <span>{port.label}</span>
          <span className="text-muted-foreground">
            {port.couples === "from_space" ? "空間から拾う" : "空間へ出す"}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The sources of a broadcast app — the rows of its mixer.
 *
 * OBS's channel count is not a property of OBS: it has one strip per source and
 * the sources are chosen on the day. Until this list existed the hall mics and
 * the meeting shared one strip, so the standard hybrid layout could not be
 * written down and the fix the linter offered for the resulting critical was to
 * cut the remote participants out of the room (§12.1).
 *
 * A browser source is one row here and two ports underneath: the picture and
 * the sound stay separate so "the video is on the stream but its audio is not"
 * is still expressible, but nobody adds them one at a time (§12.4).
 */
function Sources({ info }: { info: NodeInfo }) {
  const templates = (info.model?.ports ?? []).filter((port) => port.expandable);
  if (templates.length === 0) return null;

  const instances = info.node.ports ?? [];
  const groups = new Map<string, { key: string; label: string; parts: string[] }>();
  for (const instance of instances) {
    const id = instance.sourceId ?? instance.key;
    const template = templates.find((port) => port.key === instance.template);
    const existing = groups.get(id);
    if (existing) {
      existing.parts.push(template?.label ?? instance.template);
      continue;
    }
    groups.set(id, {
      key: instance.key,
      label: instance.label ?? "",
      parts: [template?.label ?? instance.template],
    });
  }

  // Paired templates are one choice, not two: adding "ブラウザ音声" alone is
  // never what anyone means.
  const options: { value: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const template of templates) {
    const group = template.sourceKey ?? template.key;
    if (seen.has(group)) continue;
    seen.add(group);
    const label = template.sourceKey
      ? templates
          .filter((port) => port.sourceKey === template.sourceKey)
          .map((port) => port.label)
          .join(" + ")
      : template.label;
    options.push({ value: template.key, label });
  }

  return (
    <section>
      <SectionHead title="ソース" />
      <p className="mb-2 text-xs text-muted-foreground">
        1 ソースがルーティング行列の 1 行になります。会場マイクと会議アプリを別の行に
        すれば、会議の音だけをモニターへ回せます。
      </p>
      {groups.size === 0 ? (
        <p className="text-xs text-muted-foreground">ソースがまだありません。</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-1">
          {[...groups.values()].map((group) => (
            <li
              key={group.key}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
            >
              <SetupForm className="flex min-w-0 flex-1 items-center gap-2">
                <input type="hidden" name="intent" value="rename-source" />
                <input type="hidden" name="nodeId" value={info.node.id} />
                <input type="hidden" name="portKey" value={group.key} />
                <Input
                  name="label"
                  defaultValue={group.label}
                  placeholder={group.parts.join(" + ")}
                  maxLength={120}
                  className="h-7 min-w-0 flex-1 text-xs"
                  aria-label={`${group.parts.join(" + ")} の名前`}
                />
                <button
                  type="submit"
                  className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                >
                  改名
                </button>
              </SetupForm>
              <SetupForm className="shrink-0">
                <input type="hidden" name="intent" value="remove-source" />
                <input type="hidden" name="nodeId" value={info.node.id} />
                <input type="hidden" name="portKey" value={group.key} />
                <button
                  type="submit"
                  className="text-xs text-muted-foreground hover:text-destructive"
                >
                  削除
                </button>
              </SetupForm>
            </li>
          ))}
        </ul>
      )}
      <SetupForm className="flex items-end gap-2">
        <input type="hidden" name="intent" value="add-source" />
        <input type="hidden" name="nodeId" value={info.node.id} />
        <div className="min-w-0 flex-1">
          <Field label="ソースを追加" htmlFor={`source-${info.node.id}`}>
            <select id={`source-${info.node.id}`} name="template" className={selectClassName}>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Button type="submit" variant="secondary" size="sm">
          追加
        </Button>
      </SetupForm>
    </section>
  );
}

/**
 * One cable, read from the selected node's point of view.
 *
 * Every link is a cable now — a device selection is `Assignment` below — so the
 * badge says only which way the signal runs.
 */
function Wire({
  nodeInfo,
  link,
  info,
}: {
  nodeInfo: NodeInfo[];
  link: SetupLink;
  info: NodeInfo;
}) {
  const outgoing = link.from[0] === info.node.id;
  const own = outgoing ? link.from : link.to;
  const peer = outgoing ? link.to : link.from;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
      <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
        {outgoing ? "出力" : "入力"}
      </span>
      <span className="shrink-0 text-muted-foreground">{portLabel(info, own[1])}</span>
      <span className="shrink-0 text-muted-foreground">{outgoing ? "→" : "←"}</span>
      <span className="min-w-0 truncate">{describePort(nodeInfo, peer)}</span>
      <SetupForm className="ml-auto shrink-0">
        <input type="hidden" name="intent" value="remove-link" />
        <input type="hidden" name="linkId" value={link.id} />
        <button type="submit" className="text-muted-foreground hover:text-destructive">
          削除
        </button>
      </SetupForm>
    </div>
  );
}

/**
 * One device selection, which this node made on the machine it runs on.
 *
 * No arrow: the direction is derived from the two jacks and is not the app's to
 * choose, so drawing one would invite somebody to try to reverse it.
 */
function Assignment({
  nodeInfo,
  info,
  hostNodeId,
  assignment,
}: {
  nodeInfo: NodeInfo[];
  info: NodeInfo;
  hostNodeId: string;
  assignment: { port: string; hostPort: string };
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
      <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
        割当
      </span>
      <span className="shrink-0 text-muted-foreground">{portLabel(info, assignment.port)}</span>
      <span className="min-w-0 truncate">
        {describePort(nodeInfo, [hostNodeId, assignment.hostPort])}
      </span>
      <SetupForm className="ml-auto shrink-0">
        <input type="hidden" name="intent" value="remove-assignment" />
        <input type="hidden" name="nodeId" value={info.node.id} />
        <input type="hidden" name="port" value={assignment.port} />
        <button type="submit" className="text-muted-foreground hover:text-destructive">
          削除
        </button>
      </SetupForm>
    </div>
  );
}

/**
 * A place, or a meeting.
 *
 * Several spaces can be one place — a hall's acoustic and visual space share a
 * `venueKey` — so this lists every space the place covers rather than only the
 * one the tree row happened to name; otherwise the second one could never be
 * deleted.
 */
function SpaceInspector({
  doc,
  space,
  nodeInfo,
  hrefFor,
}: {
  doc: SetupDoc;
  space: Space;
  nodeInfo: NodeInfo[];
  hrefFor: (selection: string) => string;
}) {
  const place = collectPlaces(doc).find((entry) => entry.spaceIds.includes(space.id));
  const spaces = place ? doc.spaces.filter((entry) => place.spaceIds.includes(entry.id)) : [space];
  const spaceIds = new Set(spaces.map((entry) => entry.id));
  const members =
    space.kind === "transport"
      ? nodeInfo.filter((info) => info.node.spaceId === space.id)
      : nodeInfo.filter(
          (info) => placeOfNode(doc, info.node) === place?.key && info.node.spaceId !== undefined,
        );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold tracking-tight">{space.label}</h2>
        <p className="text-xs text-muted-foreground">
          {space.kind === "transport" ? "ミーティング" : "所在"}
        </p>
      </div>

      {space.kind === "transport" ? (
        <p className="text-xs text-muted-foreground">
          ミーティングを 1 つの空間として置くと、2 つ以上の join
          の間で音が回るループを検出できます。
        </p>
      ) : null}

      <section>
        <SectionHead title="空間" />
        <ul className="flex flex-col gap-1">
          {spaces.map((entry) => (
            <li
              key={entry.id}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            >
              <span className="shrink-0 rounded border border-border px-1 py-px text-[10px] text-muted-foreground">
                {SPACE_KIND_SHORT_LABELS[entry.kind]}
              </span>
              <span className="min-w-0 truncate">{SPACE_KIND_LABELS[entry.kind]}</span>
              <SetupForm className="ml-auto shrink-0">
                <input type="hidden" name="intent" value="remove-space" />
                <input type="hidden" name="spaceId" value={entry.id} />
                <button type="submit" className="text-muted-foreground hover:text-destructive">
                  削除
                </button>
              </SetupForm>
            </li>
          ))}
        </ul>
        {space.venueKey || space.meetingKey ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {space.venueKey ? `物理空間キー ${space.venueKey}` : null}
            {space.venueKey && space.meetingKey ? " · " : null}
            {space.meetingKey ? `ミーティングキー ${space.meetingKey}` : null}
          </p>
        ) : null}
      </section>

      <section>
        <SectionHead title={space.kind === "transport" ? "参加している join" : "ここにある機材"} />
        {members.length === 0 ? (
          <p className="text-xs text-muted-foreground">まだ何もありません。</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {members
              .filter((info) => spaceIds.has(info.node.spaceId ?? ""))
              .map((info) => (
                <li key={info.node.id}>
                  <Link
                    to={hrefFor(info.node.id)}
                    replace
                    className="block truncate rounded-md border border-border px-2 py-1.5 text-xs hover:bg-secondary"
                  >
                    {info.label}
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SetupSettings({ doc, setupName }: { doc: SetupDoc; setupName: string }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold tracking-tight">構成の設定</h2>
        <p className="text-xs text-muted-foreground">この構成そのものについての設定です。</p>
      </div>

      <SetupForm className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="rename-setup" />
        <Field label="構成名" htmlFor="setup-name">
          <Input id="setup-name" name="name" defaultValue={setupName} maxLength={120} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" size="sm">
            変更
          </Button>
        </div>
      </SetupForm>

      <SetupForm className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="set-notes" />
        <Field label="メモ" htmlFor="setup-notes">
          <Textarea id="setup-notes" name="notes" rows={6} defaultValue={doc.notes ?? ""} />
        </Field>
        <div>
          <Button type="submit" variant="secondary" size="sm">
            保存
          </Button>
        </div>
      </SetupForm>

      <SetupForm>
        <input type="hidden" name="intent" value="delete-setup" />
        <button type="submit" className="text-xs text-muted-foreground hover:text-destructive">
          この構成を削除
        </button>
      </SetupForm>
    </div>
  );
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </div>
  );
}
