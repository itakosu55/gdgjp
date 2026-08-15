import { EmptyState, Field, selectClassName } from "~/components/page";
import { RoutingMatrix, hasMatrix } from "~/components/routing-matrix";
import { SetupForm } from "~/components/setup-form";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { PLACE_MEDIA_LABELS } from "~/lib/av/labels";
import { PLACE_KINDS } from "~/lib/av/places";
import type { SetupDoc, SetupLink } from "~/lib/av/schema";
import type { DeviceModel } from "~/lib/av/types";
import type { NodeInfo } from "~/lib/setup-view";
import { describePort } from "~/lib/setup-view";

/**
 * The work surface's three faces, plus the JSON parked in the status bar.
 *
 * These used to be page-level tabs. They are now views of the centre pane only,
 * so the tree and the inspector stay put while you move between them — which is
 * what makes a finding actionable without navigating away from it.
 */

/**
 * Every cable in the setup, as one table.
 *
 * The inspector shows the links of one node, which is what you want while
 * wiring. This is the other thing people do with the same data: read it aloud
 * on the day while plugging cables in. Neither replaces the other.
 */
export function CablesView({
  doc,
  nodeInfo,
}: {
  doc: SetupDoc;
  nodeInfo: NodeInfo[];
}) {
  // Every link is a cable now. A device selection lives on the node that made
  // it, and the two tables no longer have to be sieved apart by a predicate.
  const cables = doc.links;
  const assignments = doc.nodes.flatMap((node) => {
    const hostNodeId = node.hostNodeId;
    if (!hostNodeId) return [];
    return (node.assignments ?? []).map((assignment) => ({
      nodeId: node.id,
      hostNodeId,
      ...assignment,
    }));
  });

  const portOptions = (filter: (port: DeviceModel["ports"][number]) => boolean) =>
    nodeInfo.flatMap((info) =>
      info.ports.filter(filter).map((port) => ({
        value: `${info.node.id}::${port.key}`,
        label: `${info.label} / ${port.label}`,
      })),
    );
  const outputs = portOptions((port) => port.direction === "out");
  const inputs = portOptions((port) => port.direction === "in");

  const hosted = nodeInfo.filter((info) => info.node.hostNodeId);
  const appPorts = hosted.flatMap((info) =>
    info.ports.map((port) => ({
      value: `${info.node.id}::${port.key}`,
      label: `${info.label} / ${port.label} (${port.direction === "out" ? "出力" : "入力"})`,
    })),
  );
  const hostIds = new Set(hosted.map((info) => info.node.hostNodeId));
  const hostPorts = nodeInfo
    .filter((info) => hostIds.has(info.node.id))
    .map((info) => ({
      label: info.label,
      ports: info.ports.map((port) => ({
        value: `${info.node.id}::${port.key}`,
        label: `${port.label} (${port.direction === "out" ? "出力" : "入力"})`,
      })),
    }));

  return (
    <div className="flex max-w-4xl flex-col gap-8 p-4">
      <section>
        <h2 className="mb-1 text-sm font-semibold">ケーブル</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          当日ケーブルを挿すときに読み上げる一覧。出力から入力へ流れます。
        </p>
        {cables.length === 0 ? (
          <EmptyState>ケーブルがまだありません。</EmptyState>
        ) : (
          <LinkTable
            links={cables}
            headings={["接続元 (出力)", "接続先 (入力)"]}
            cells={(link) => [describePort(nodeInfo, link.from), describePort(nodeInfo, link.to)]}
          />
        )}
        {outputs.length > 0 && inputs.length > 0 ? (
          <SetupForm className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border p-3">
            <input type="hidden" name="intent" value="add-link" />
            <div className="min-w-56 flex-1">
              <Field label="接続元 (出力)" htmlFor="linkFrom">
                <select id="linkFrom" name="from" required className={selectClassName}>
                  {outputs.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="min-w-56 flex-1">
              <Field label="接続先 (入力)" htmlFor="linkTo">
                <select id="linkTo" name="to" required className={selectClassName}>
                  {inputs.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Button type="submit">追加</Button>
          </SetupForm>
        ) : null}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold">アプリの入出力割り当て</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          ケーブルではなく、アプリがホスト PC のどのデバイスを使うかの設定です。
        </p>
        {assignments.length === 0 ? (
          <EmptyState>割り当てがまだありません。</EmptyState>
        ) : (
          <AssignmentTable assignments={assignments} nodeInfo={nodeInfo} />
        )}
        {appPorts.length > 0 ? (
          <SetupForm className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border p-3">
            <input type="hidden" name="intent" value="add-assignment" />
            <div className="min-w-56 flex-1">
              <Field label="アプリ側のポート" htmlFor="assignApp">
                <select id="assignApp" name="app" required className={selectClassName}>
                  {appPorts.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="min-w-56 flex-1">
              <Field
                label="PC 側のデバイス"
                htmlFor="assignHost"
                hint="入力には入力を、出力には出力を選びます。向きは自動で決まります。"
              >
                <select id="assignHost" name="host" required className={selectClassName}>
                  {hostPorts.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.ports.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
            </div>
            <Button type="submit">割り当てを追加</Button>
          </SetupForm>
        ) : null}
      </section>
    </div>
  );
}

type AssignmentRow = {
  nodeId: string;
  hostNodeId: string;
  port: string;
  hostPort: string;
};

/**
 * The device selections, one row each.
 *
 * No id column and no direction: an assignment is identified by the app port it
 * is made on — one app input reads from one device — and which way the signal
 * runs is derived from the two jacks rather than stored (§12.4.1).
 */
function AssignmentTable({
  assignments,
  nodeInfo,
}: {
  assignments: AssignmentRow[];
  nodeInfo: NodeInfo[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2">アプリ側</th>
            <th className="px-3 py-2">PC 側</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {assignments.map((assignment) => (
            <tr key={`${assignment.nodeId}::${assignment.port}`} className="border-t">
              <td className="px-3 py-2">
                {describePort(nodeInfo, [assignment.nodeId, assignment.port])}
              </td>
              <td className="px-3 py-2">
                {describePort(nodeInfo, [assignment.hostNodeId, assignment.hostPort])}
              </td>
              <td className="px-3 py-2 text-right">
                <SetupForm>
                  <input type="hidden" name="intent" value="remove-assignment" />
                  <input type="hidden" name="nodeId" value={assignment.nodeId} />
                  <input type="hidden" name="port" value={assignment.port} />
                  <button
                    type="submit"
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    削除
                  </button>
                </SetupForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinkTable({
  links,
  headings,
  cells,
}: {
  links: SetupLink[];
  headings: [string, string];
  cells: (link: SetupLink) => [string, string];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2">ID</th>
            <th className="px-3 py-2">{headings[0]}</th>
            <th className="px-3 py-2">{headings[1]}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {links.map((link) => {
            const [left, right] = cells(link);
            return (
              <tr key={link.id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{link.id}</td>
                <td className="px-3 py-2">{left}</td>
                <td className="px-3 py-2">{right}</td>
                <td className="px-3 py-2 text-right">
                  <SetupForm>
                    <input type="hidden" name="intent" value="remove-link" />
                    <input type="hidden" name="linkId" value={link.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      削除
                    </button>
                  </SetupForm>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Every matrix at once, at full width.
 *
 * The inspector carries the selected node's matrix, which is enough for a small
 * mixer in a 320px panel. A 16-channel console is not, and this is the escape.
 */
export function RoutingView({
  nodeInfo,
  enabled,
}: {
  nodeInfo: NodeInfo[];
  enabled: ReadonlySet<string>;
}) {
  const matrixNodes = nodeInfo.filter(hasMatrix);

  if (matrixNodes.length === 0) {
    return (
      <div className="p-4">
        <EmptyState>
          ルーティング行列を持つ機材がありません。ミキサーやオーディオインターフェイス、配信ソフトを
          追加すると表示されます。
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-4">
      <p className="max-w-4xl text-xs text-muted-foreground">
        チェックは「その入力がそのバスに乗るか」だけを表します。レベルやゲインは持ちません。
        リモート登壇者へのエコーは、会議ソフトの音声が送出バスに乗っていることが原因です。
      </p>
      {matrixNodes.map((info) =>
        info.model ? (
          <section key={info.node.id}>
            <h2 className="mb-3 text-sm font-semibold">{info.label}</h2>
            <div className="max-w-4xl">
              <RoutingMatrix info={info} model={info.model} enabled={enabled} />
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

/**
 * The document itself.
 *
 * Not deleted along with the tabs: it is the interchange format — copy a setup
 * between events, hand-edit, and later read and write what the AI phase emits.
 */
export function JsonView({ doc }: { doc: SetupDoc }) {
  const json = JSON.stringify(doc, null, 2);
  return (
    <div className="flex max-w-4xl flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">
        座標を持たない自己完結の JSON です。イベント間のコピーや、将来の AI 提案の入出力が
        この形式になります。
      </p>
      <SetupForm className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="replace-doc" />
        {/* Keyed on the text so an edit made elsewhere — a fix applied from the
            dock, which is now on screen at the same time — reloads the box
            instead of leaving a stale document sitting in it that 置き換える
            would then write back. An unchanged document keeps the same key, so
            typing survives a failed submit. */}
        <Textarea
          key={json}
          name="doc"
          rows={24}
          defaultValue={json}
          className="font-mono text-xs"
          spellCheck={false}
        />
        <div>
          <Button type="submit" variant="secondary">
            この内容で置き換える
          </Button>
        </div>
      </SetupForm>
    </div>
  );
}

/** The "+" in the left panel: what a setup can be given more of. */
export function AddPanel({
  available,
  softwareModels,
}: {
  available: { id: string; name: string }[];
  softwareModels: DeviceModel[];
}) {
  return (
    <div className="flex flex-col gap-5 border-b border-border p-3">
      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          機材を追加
        </h2>
        {available.length === 0 && softwareModels.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            イベント側で利用可能機材を選んでください。
          </p>
        ) : (
          <SetupForm className="flex flex-col gap-2">
            <input type="hidden" name="intent" value="add-node" />
            <select id="addDevice" name="deviceId" required className={selectClassName}>
              <optgroup label="イベントの利用可能機材">
                {available.map((device) => (
                  <option key={device.id} value={`d:${device.id}`}>
                    {device.name}
                  </option>
                ))}
              </optgroup>
              {/* Software comes from the catalog, not the ledger: it is not a
                  physical unit, and two joins into one meeting are two nodes of
                  one model. */}
              <optgroup label="ソフトウェア">
                {softwareModels.map((model) => (
                  <option key={model.id} value={`m:${model.id}`}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            </select>
            <p className="text-[11px] text-muted-foreground">
              ソフトウェアを追加したら、ホスト PC を指定してください。
            </p>
            <Button type="submit" size="sm">
              追加
            </Button>
          </SetupForm>
        )}
      </section>

      {/*
       * A room, not a space. The document keeps a hall's air and its sightline
       * apart because the graph needs them apart, but nobody setting up an
       * event thinks of a hall as two things — and asking for them one at a
       * time meant hand-typing the key that says they are the same room, which
       * is the one field where a typo draws the room twice.
       */}
      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          部屋を追加
        </h2>
        <SetupForm className="flex flex-col gap-2">
          <input type="hidden" name="intent" value="add-place" />
          <Field label="名前" htmlFor="placeLabel">
            <Input
              id="placeLabel"
              name="label"
              required
              placeholder="メインホール"
              maxLength={120}
            />
          </Field>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">この部屋にあるもの</legend>
            {PLACE_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  id={`place-${kind}`}
                  name="media"
                  value={kind}
                  defaultChecked
                  className="size-3.5 accent-primary"
                />
                <span>{PLACE_MEDIA_LABELS[kind]}</span>
              </label>
            ))}
          </fieldset>
          <p className="text-[11px] text-muted-foreground">
            音はスピーカーとマイクが、画はスクリーンとカメラがつながる空間になります。両方あっても 1
            つの部屋です。
          </p>
          <Field
            label="物理空間キー"
            htmlFor="venueKey"
            hint="将来トラックを分けたとき、別の設定の同じ部屋と突き合わせるための任意の識別子です。空欄で構いません。"
          >
            <Input id="venueKey" name="venueKey" placeholder="hall-a" maxLength={64} />
          </Field>
          <Button type="submit" size="sm">
            追加
          </Button>
        </SetupForm>
      </section>

      {/* A meeting is not a place, so it is not something a room has. */}
      <section>
        <h2 className="mb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          ミーティングを追加
        </h2>
        <SetupForm className="flex flex-col gap-2">
          <input type="hidden" name="intent" value="add-space" />
          <input type="hidden" name="kind" value="transport" />
          <Field label="名前" htmlFor="meetingLabel">
            <Input
              id="meetingLabel"
              name="label"
              required
              placeholder="Google Meet"
              maxLength={120}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            会議ソフトの join が参加する場所です。機材の所在にはならず、join だけがここに入ります。
          </p>
          <Field
            label="ミーティングキー"
            htmlFor="meetingKey"
            hint="将来トラックを分けたとき、同じミーティングだと判定するための任意の識別子です。"
          >
            <Input id="meetingKey" name="meetingKey" placeholder="meet-abc" maxLength={64} />
          </Field>
          <Button type="submit" size="sm">
            追加
          </Button>
        </SetupForm>
      </section>
    </div>
  );
}
