import { Form, Link, redirect, useSearchParams } from "react-router";
import { LintPanel, severityCounts } from "~/components/lint-panel";
import { EmptyState, Field, Page, selectClassName } from "~/components/page";
import { SignalFlowDiagram } from "~/components/signal-flow-diagram";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { requireUser } from "~/lib/auth-redirect.server";
import type { Fix } from "~/lib/av/diagnostics";
import { describeNode } from "~/lib/av/diagnostics";
import { buildGraph, isHostAssignment, orientHostAssignment } from "~/lib/av/graph";
import {
  COUPLING_LABELS,
  SPACE_KIND_LABELS,
  SPACE_KIND_SHORT_LABELS,
  entries,
} from "~/lib/av/labels";
import { layoutGraph } from "~/lib/av/layout";
import { lint } from "~/lib/av/lint";
import { applyFix, applyOperation, defaultRoutesFor } from "~/lib/av/mutations";
import { safeParseSetupDoc } from "~/lib/av/schema";
import type { PortRef, SetupDoc } from "~/lib/av/schema";
import type { DeviceModel, SpaceKind } from "~/lib/av/types";
import { SPACE_KINDS } from "~/lib/av/types";
import {
  getEvent,
  getSetup,
  listEventDeviceIds,
  listLedger,
  listModels,
  loadDevices,
  renameSetup,
  saveSetupDoc,
} from "~/lib/db";
import { emptyToNull, text } from "~/lib/form";
import { newDocId } from "~/lib/id";
import type { Route } from "./+types/events.$eventId.setups.$setupId";

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data ? `${data.setup.name} — ${data.event.title}` : "構成 — Stream" }];
}

export async function loader(args: Route.LoaderArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);

  const setup = await getSetup(env.DB, args.params.setupId);
  if (!setup || setup.eventId !== args.params.eventId) {
    throw new Response("Not found", { status: 404 });
  }
  const event = await getEvent(env.DB, setup.eventId);
  if (!event) throw new Response("Not found", { status: 404 });

  const [modelList, devices, eventDeviceIds, ledger] = await Promise.all([
    listModels(env.DB),
    // Every device, not just this event's: a node pointing at gear that was not
    // brought must surface as `device-not-in-event`, not `unknown-reference`.
    loadDevices(env.DB),
    listEventDeviceIds(env.DB, setup.eventId),
    listLedger(env.DB),
  ]);

  const models = new Map(modelList.map((model) => [model.id, model]));
  const diagnostics = lint(setup.doc, { models, devices, eventDeviceIds });
  const graph = buildGraph(setup.doc, { devices, models });
  const layout = layoutGraph(graph);
  // Same naming the diagnostics use, so a fix button and the message it sits
  // under call the same machine the same thing.
  const nodeNames = Object.fromEntries(
    [...graph.nodes.keys()].map((id) => [id, describeNode(graph, id)]),
  );

  return {
    user: { name: user.name, email: user.email, image: user.image },
    event: { id: event.id, title: event.title },
    setup: { id: setup.id, name: setup.name, docError: setup.docError },
    doc: setup.doc,
    diagnostics,
    nodeNames,
    layout,
    models: modelList,
    available: ledger.filter((device) => eventDeviceIds.has(device.id)),
  };
}

export async function action(args: Route.ActionArgs) {
  const env = args.context.cloudflare.env;
  const user = await requireUser(env, args.request);
  const setup = await getSetup(env.DB, args.params.setupId);
  if (!setup || setup.eventId !== args.params.eventId) {
    throw new Response("Not found", { status: 404 });
  }

  const form = await args.request.formData();
  const intent = text(form.get("intent"));
  const doc = setup.doc;

  const save = async (next: SetupDoc) => {
    await saveSetupDoc(env.DB, setup.id, next, user.id);
    return null;
  };

  switch (intent) {
    case "rename-setup":
      await renameSetup(env.DB, setup.id, text(form.get("name")) || "(無題)");
      return null;

    case "add-space": {
      const label = text(form.get("label"));
      if (!label) return { error: "空間の名前は必須です。" };
      const requested = text(form.get("kind"));
      const kind: SpaceKind = SPACE_KINDS.includes(requested as SpaceKind)
        ? (requested as SpaceKind)
        : "acoustic";
      return save(
        applyOperation(doc, {
          kind: "add-space",
          space: {
            id: newDocId(
              "sp",
              doc.spaces.map((space) => space.id),
            ),
            kind,
            label,
            ...(emptyToNull(form.get("venueKey")) ? { venueKey: text(form.get("venueKey")) } : {}),
            ...(emptyToNull(form.get("meetingKey"))
              ? { meetingKey: text(form.get("meetingKey")) }
              : {}),
          },
        }),
      );
    }

    case "remove-space":
      return save(
        applyOperation(doc, { kind: "remove-space", spaceId: text(form.get("spaceId")) }),
      );

    case "add-node": {
      // One select, two option groups. `d:` is a unit from the ledger, `m:` is
      // a model referenced directly — software has no physical unit (§9.6).
      const choice = text(form.get("deviceId"));
      if (!choice) return { error: "機材を選んでください。" };
      const models = await listModels(env.DB);

      let reference: { deviceId: string } | { modelId: string };
      let model: DeviceModel | undefined;
      if (choice.startsWith("m:")) {
        const modelId = choice.slice(2);
        model = models.find((entry) => entry.id === modelId);
        if (!model) return { error: "型番が見つかりません。" };
        reference = { modelId };
      } else {
        const deviceId = choice.startsWith("d:") ? choice.slice(2) : choice;
        const device = (await loadDevices(env.DB)).get(deviceId);
        if (!device) return { error: "機材が見つかりません。" };
        model = models.find((entry) => entry.id === device.modelId);
        reference = { deviceId };
      }

      const nodeId = newDocId(
        "n",
        doc.nodes.map((node) => node.id),
      );
      const hostNodeId = emptyToNull(form.get("hostNodeId"));
      return save(
        applyOperation(doc, {
          kind: "add-node",
          node: { id: nodeId, ...reference, ...(hostNodeId ? { hostNodeId } : {}) },
          routes: model ? defaultRoutesFor(nodeId, model) : [],
        }),
      );
    }

    case "update-node": {
      const spaceId = emptyToNull(form.get("spaceId"));
      const coupling = text(form.get("coupling"));
      const hostNodeId = emptyToNull(form.get("hostNodeId"));
      return save(
        applyOperation(doc, {
          kind: "update-node",
          nodeId: text(form.get("nodeId")),
          patch: {
            label: emptyToNull(form.get("label")) ?? undefined,
            spaceId: spaceId ?? undefined,
            coupling: coupling === "isolated" ? "isolated" : undefined,
            hostNodeId: hostNodeId ?? undefined,
          },
        }),
      );
    }

    case "remove-node":
      return save(applyOperation(doc, { kind: "remove-node", nodeId: text(form.get("nodeId")) }));

    case "add-link": {
      const from = splitPortRef(form.get("from"));
      const to = splitPortRef(form.get("to"));
      if (!from || !to) return { error: "接続元と接続先を選んでください。" };
      return save(
        applyOperation(doc, {
          kind: "add-link",
          link: {
            id: newDocId(
              "l",
              doc.links.map((link) => link.id),
            ),
            from,
            to,
          },
        }),
      );
    }

    // Kept apart from `add-link` on purpose: a device selection is not a cable,
    // and its direction follows from the two ports rather than from the user.
    case "add-assignment": {
      const app = splitPortRef(form.get("app"));
      const host = splitPortRef(form.get("host"));
      if (!app || !host) return { error: "アプリ側と PC 側のポートを選んでください。" };

      const appNode = doc.nodes.find((node) => node.id === app[0]);
      if (!appNode || appNode.hostNodeId !== host[0]) {
        return { error: "選んだ PC は、このアプリのホストではありません。" };
      }

      const [devices, models] = await Promise.all([loadDevices(env.DB), listModels(env.DB)]);
      const directionOf = (ref: PortRef) => {
        const node = doc.nodes.find((entry) => entry.id === ref[0]);
        if (!node) return undefined;
        const modelId = node.deviceId ? devices.get(node.deviceId)?.modelId : node.modelId;
        const model = modelId ? models.find((entry) => entry.id === modelId) : undefined;
        return model?.ports.find((port) => port.key === ref[1])?.direction;
      };

      const appDirection = directionOf(app);
      const hostDirection = directionOf(host);
      if (!appDirection || !hostDirection) return { error: "ポートが見つかりません。" };

      const oriented = orientHostAssignment(
        { ref: app, direction: appDirection },
        { ref: host, direction: hostDirection },
      );
      if (!oriented) {
        return {
          error:
            "入出力の向きが揃っていません。アプリの入力には PC の入力を、アプリの出力には PC の出力を選んでください。",
        };
      }

      return save(
        applyOperation(doc, {
          kind: "add-link",
          link: {
            id: newDocId(
              "l",
              doc.links.map((link) => link.id),
            ),
            ...oriented,
          },
        }),
      );
    }

    case "remove-link":
      return save(applyOperation(doc, { kind: "remove-link", linkId: text(form.get("linkId")) }));

    case "toggle-route":
      return save(
        applyOperation(doc, {
          kind: "toggle-route",
          nodeId: text(form.get("nodeId")),
          inPort: text(form.get("inPort")),
          bus: text(form.get("bus")),
        }),
      );

    case "set-notes":
      return save(applyOperation(doc, { kind: "set-notes", notes: text(form.get("notes")) }));

    case "apply-fix": {
      let fix: Fix;
      try {
        fix = JSON.parse(text(form.get("fix"))) as Fix;
      } catch {
        return { error: "修正内容を読み取れませんでした。" };
      }
      return save(applyFix(doc, fix));
    }

    case "replace-doc": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text(form.get("doc")));
      } catch {
        return { error: "JSON として読み取れません。" };
      }
      const result = safeParseSetupDoc(parsed);
      if (!result.success) {
        return { error: `スキーマに適合しません: ${result.error.issues[0]?.message ?? ""}` };
      }
      return save(result.data);
    }

    case "delete-setup":
      return redirect(`/events/${setup.eventId}`);

    default:
      return { error: `不明な操作です: ${intent}` };
  }
}

function splitPortRef(value: FormDataEntryValue | null): [string, string] | null {
  const [nodeId, portKey] = text(value).split("::");
  return nodeId && portKey ? [nodeId, portKey] : null;
}

const TABS = [
  { id: "devices", label: "機材" },
  { id: "links", label: "結線" },
  { id: "routing", label: "ルーティング" },
  { id: "diagram", label: "図" },
  { id: "json", label: "JSON" },
] as const;

export default function SetupEditorPage({ loaderData, actionData }: Route.ComponentProps) {
  const { doc, models, available, diagnostics, nodeNames, layout, event, setup } = loaderData;
  const [params] = useSearchParams();
  const tab = params.get("tab") ?? "devices";

  const modelById = new Map(models.map((model) => [model.id, model]));
  const deviceById = new Map(available.map((device) => [device.id, device]));
  const counts = severityCounts(diagnostics);
  // The only thing the diagram draws in the danger colour. Routing facts — a
  // return path under the picture — are not faults and must not borrow red.
  const alerts = new Set(
    diagnostics.flatMap((diagnostic) => (diagnostic.cycle ?? []).map((edge) => edge.id)),
  );

  const nodeInfo = doc.nodes.map((node) => {
    // A software node names a model directly; everything else goes through the
    // ledger. `deviceById` holds only this event's gear, so a node pointing at
    // kit that was not brought still has to render — as its raw id if need be.
    const device = node.deviceId ? deviceById.get(node.deviceId) : undefined;
    const model = device
      ? modelById.get(device.modelId)
      : node.modelId
        ? modelById.get(node.modelId)
        : undefined;
    return {
      node,
      device,
      model,
      label: node.label ?? device?.name ?? model?.name ?? node.deviceId ?? node.modelId ?? node.id,
    };
  });
  const computers = nodeInfo.filter((info) => info.model?.category === "computer");
  const softwareModels = models.filter(
    (model) =>
      model.category === "software_broadcast" || model.category === "software_conferencing",
  );

  return (
    <Page
      user={loaderData.user}
      title={setup.name}
      description={
        <>
          機材・結線・ルーティングを登録すると下の検査結果が更新されます。ゲインや EQ
          は意図的に持ちません。
        </>
      }
      breadcrumb={
        <Link to={`/events/${event.id}`} className="hover:underline">
          ← {event.title}
        </Link>
      }
      wide
    >
      {setup.docError ? <p className="mb-4 text-sm text-destructive">{setup.docError}</p> : null}
      {actionData?.error ? (
        <p className="mb-4 text-sm text-destructive">{actionData.error}</p>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold">
          検査結果
          {counts.critical > 0 ? (
            <span className="rounded bg-destructive px-1.5 py-0.5 text-xs text-destructive-foreground">
              重大 {counts.critical}
            </span>
          ) : null}
          {counts.error > 0 ? (
            <span className="rounded border border-destructive/50 px-1.5 py-0.5 text-xs text-destructive">
              エラー {counts.error}
            </span>
          ) : null}
          {counts.warn > 0 ? (
            <span className="rounded border border-amber-500/50 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400">
              警告 {counts.warn}
            </span>
          ) : null}
        </h2>
        <LintPanel diagnostics={diagnostics} nodeNames={nodeNames} />
      </section>

      <nav className="mb-4 flex flex-wrap gap-1 border-b">
        {TABS.map((entry) => (
          <Link
            key={entry.id}
            to={`?tab=${entry.id}`}
            replace
            className={
              tab === entry.id
                ? "-mb-px border-b-2 border-primary px-3 py-2 text-sm font-medium"
                : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
            }
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      {tab === "devices" ? (
        <DevicesTab
          doc={doc}
          nodeInfo={nodeInfo}
          available={available}
          softwareModels={softwareModels}
          computers={computers}
        />
      ) : null}
      {tab === "links" ? <LinksTab doc={doc} nodeInfo={nodeInfo} /> : null}
      {tab === "routing" ? <RoutingTab doc={doc} nodeInfo={nodeInfo} /> : null}
      {tab === "diagram" ? <SignalFlowDiagram layout={layout} alerts={alerts} /> : null}
      {tab === "json" ? <JsonTab doc={doc} setupName={setup.name} /> : null}
    </Page>
  );
}

type NodeInfo = {
  node: SetupDoc["nodes"][number];
  device: { id: string; name: string } | undefined;
  model: DeviceModel | undefined;
  label: string;
};

/**
 * The spaces worth offering as a node's 所在.
 *
 * A meeting is where a join is and a room is where everything else is, and the
 * two are never the alternative to one another. Offering both made "所在" read
 * as a free-form tag; the graph then quietly ignored the nonsense combinations
 * (`space-kind-mismatch`) instead of the form never asking.
 */
function spacesFor(doc: SetupDoc, model: DeviceModel | undefined) {
  const wantsMeeting = model?.category === "software_conferencing";
  return doc.spaces.filter((space) =>
    wantsMeeting ? space.kind === "transport" : space.kind !== "transport",
  );
}

function DevicesTab({
  doc,
  nodeInfo,
  available,
  softwareModels,
  computers,
}: {
  doc: SetupDoc;
  nodeInfo: NodeInfo[];
  available: { id: string; name: string }[];
  softwareModels: DeviceModel[];
  computers: NodeInfo[];
}) {
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-8">
        <section>
          <h2 className="mb-1 text-sm font-semibold">空間</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            スピーカーは空間へ出力し、マイクは空間から入力します。ここを登録しないと
            ハウリングは検出できません。機材の「所在」にも使われ、同じ部屋のものは 信号フロー図で 1
            つの枠にまとまります。
          </p>
          {doc.spaces.length === 0 ? (
            <EmptyState>空間がまだありません。</EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {doc.spaces.map((space) => (
                <li
                  key={space.id}
                  className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                >
                  <span>
                    <span className="font-mono text-xs text-muted-foreground">{space.id}</span>{" "}
                    {space.label}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {SPACE_KIND_SHORT_LABELS[space.kind]}
                    </span>
                  </span>
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove-space" />
                    <input type="hidden" name="spaceId" value={space.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      削除
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">機材</h2>
          {nodeInfo.length === 0 ? (
            <EmptyState>右のフォームからイベントの利用可能機材を追加してください。</EmptyState>
          ) : (
            <div className="flex flex-col gap-3">
              {nodeInfo.map((info) => (
                <div key={info.node.id} className="rounded-lg border p-4">
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {info.node.id}
                      </span>{" "}
                      <span className="font-medium">{info.label}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {info.model ? info.model.category : "型番不明"}
                    </span>
                  </div>
                  <Form method="post" className="grid gap-3 sm:grid-cols-2">
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
                        info.model?.category === "software_conferencing"
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
                    <div className="sm:col-span-2">
                      <Button type="submit" variant="secondary" size="sm">
                        保存
                      </Button>
                    </div>
                  </Form>
                  <Form method="post" className="mt-2">
                    <input type="hidden" name="intent" value="remove-node" />
                    <input type="hidden" name="nodeId" value={info.node.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      構成から外す
                    </button>
                  </Form>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className="flex flex-col gap-6">
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">機材を追加</h2>
          {available.length === 0 && softwareModels.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              イベント側で利用可能機材を選んでください。
            </p>
          ) : (
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="add-node" />
              <Field label="機材" htmlFor="addDevice">
                <select id="addDevice" name="deviceId" required className={selectClassName}>
                  <optgroup label="イベントの利用可能機材">
                    {available.map((device) => (
                      <option key={device.id} value={`d:${device.id}`}>
                        {device.name}
                      </option>
                    ))}
                  </optgroup>
                  {/* Software comes from the catalog, not the ledger: it is not
                      a physical unit, and two joins into one meeting are two
                      nodes of one model. */}
                  <optgroup label="ソフトウェア">
                    {softwareModels.map((model) => (
                      <option key={model.id} value={`m:${model.id}`}>
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </Field>
              <p className="text-xs text-muted-foreground">
                ソフトウェアを追加したら、ホスト PC を指定してください。
              </p>
              <Button type="submit">追加</Button>
            </Form>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">空間を追加</h2>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="add-space" />
            <Field label="名前" htmlFor="spaceLabel">
              <Input
                id="spaceLabel"
                name="label"
                required
                placeholder="メインホール"
                maxLength={120}
              />
            </Field>
            <Field label="種別" htmlFor="spaceKind">
              <select id="spaceKind" name="kind" className={selectClassName}>
                {entries(SPACE_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="物理空間キー"
              htmlFor="venueKey"
              hint="将来トラックを分けたとき、同じ部屋だと判定するための任意の識別子です。"
            >
              <Input id="venueKey" name="venueKey" placeholder="hall-a" maxLength={64} />
            </Field>
            <Field
              label="ミーティングキー"
              htmlFor="meetingKey"
              hint="伝送空間のみ。将来トラックを分けたとき、同じミーティングだと判定するための任意の識別子です。"
            >
              <Input id="meetingKey" name="meetingKey" placeholder="meet-abc" maxLength={64} />
            </Field>
            <Button type="submit">追加</Button>
          </Form>
        </section>
      </div>
    </div>
  );
}

/**
 * Cables and device selections, kept in separate tables.
 *
 * They were one list, which is why the form used to carry a caveat about
 * out→out being correct "only between an app and its host PC". A caveat like
 * that is the sign of two relationships wearing one name: a cable physically
 * exists and someone can unplug it, while a device selection is a dropdown in
 * OBS. Splitting them lets each have its own vocabulary, and lets the app
 * derive the direction instead of explaining it.
 */
function LinksTab({ doc, nodeInfo }: { doc: SetupDoc; nodeInfo: NodeInfo[] }) {
  const assignments = doc.links.filter((link) => isHostAssignment(doc, link));
  const cables = doc.links.filter((link) => !isHostAssignment(doc, link));

  const portOptions = (filter: (port: DeviceModel["ports"][number]) => boolean) =>
    nodeInfo.flatMap((info) =>
      (info.model?.ports ?? []).filter(filter).map((port) => ({
        value: `${info.node.id}::${port.key}`,
        label: `${info.label} / ${port.label}`,
      })),
    );
  const outputs = portOptions((port) => port.direction === "out");
  const inputs = portOptions((port) => port.direction === "in");

  const hosted = nodeInfo.filter((info) => info.node.hostNodeId);
  const appPorts = hosted.flatMap((info) =>
    (info.model?.ports ?? []).map((port) => ({
      value: `${info.node.id}::${port.key}`,
      label: `${info.label} / ${port.label} (${port.direction === "out" ? "出力" : "入力"})`,
    })),
  );
  const hostIds = new Set(hosted.map((info) => info.node.hostNodeId));
  const hostPorts = nodeInfo
    .filter((info) => hostIds.has(info.node.id))
    .map((info) => ({
      label: info.label,
      ports: (info.model?.ports ?? []).map((port) => ({
        value: `${info.node.id}::${port.key}`,
        label: `${port.label} (${port.direction === "out" ? "出力" : "入力"})`,
      })),
    }));

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-8">
        <section>
          <h2 className="mb-1 text-sm font-semibold">ケーブル</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            物理的に挿さっているもの。出力から入力へ流れます。
          </p>
          {cables.length === 0 ? (
            <EmptyState>ケーブルがまだありません。</EmptyState>
          ) : (
            <LinkTable
              links={cables}
              headings={["接続元", "接続先"]}
              cells={(link) => [describePort(nodeInfo, link.from), describePort(nodeInfo, link.to)]}
            />
          )}
        </section>

        <section>
          <h2 className="mb-1 text-sm font-semibold">アプリの入出力割り当て</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            ケーブルではなく、アプリがホスト PC のどのデバイスを使うかの設定です。
          </p>
          {assignments.length === 0 ? (
            <EmptyState>割り当てがまだありません。</EmptyState>
          ) : (
            <LinkTable
              links={assignments}
              headings={["アプリ側", "PC 側"]}
              cells={(link) => {
                const appFirst = doc.nodes.find((node) => node.id === link.from[0])?.hostNodeId;
                const app = appFirst ? link.from : link.to;
                const host = appFirst ? link.to : link.from;
                return [describePort(nodeInfo, app), describePort(nodeInfo, host)];
              }}
            />
          )}
        </section>
      </div>

      <div className="flex flex-col gap-4">
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">ケーブルを追加</h2>
          {outputs.length === 0 || inputs.length === 0 ? (
            <p className="text-sm text-muted-foreground">先に機材を追加してください。</p>
          ) : (
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="add-link" />
              <Field label="接続元 (出力)" htmlFor="linkFrom">
                <select id="linkFrom" name="from" required className={selectClassName}>
                  {outputs.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="接続先 (入力)" htmlFor="linkTo">
                <select id="linkTo" name="to" required className={selectClassName}>
                  {inputs.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit">追加</Button>
            </Form>
          )}
        </section>

        <section className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold">割り当てを追加</h2>
          {appPorts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              先にホスト PC を指定したアプリを追加してください。
            </p>
          ) : (
            <Form method="post" className="flex flex-col gap-3">
              <input type="hidden" name="intent" value="add-assignment" />
              <Field label="アプリ側のポート" htmlFor="assignApp">
                <select id="assignApp" name="app" required className={selectClassName}>
                  {appPorts.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
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
              <Button type="submit">追加</Button>
            </Form>
          )}
        </section>
      </div>
    </div>
  );
}

function LinkTable({
  links,
  headings,
  cells,
}: {
  links: SetupDoc["links"];
  headings: [string, string];
  cells: (link: SetupDoc["links"][number]) => [string, string];
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
                  <Form method="post">
                    <input type="hidden" name="intent" value="remove-link" />
                    <input type="hidden" name="linkId" value={link.id} />
                    <button
                      type="submit"
                      className="text-xs text-muted-foreground hover:text-destructive"
                    >
                      削除
                    </button>
                  </Form>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function describePort(nodeInfo: NodeInfo[], ref: readonly [string, string]): string {
  const info = nodeInfo.find((entry) => entry.node.id === ref[0]);
  const port = info?.model?.ports.find((entry) => entry.key === ref[1]);
  return `${info?.label ?? ref[0]} / ${port?.label ?? ref[1]}`;
}

function RoutingTab({ doc, nodeInfo }: { doc: SetupDoc; nodeInfo: NodeInfo[] }) {
  const matrixNodes = nodeInfo.filter(
    (info) => info.model?.internalRouting === "matrix" && info.model.buses.length > 0,
  );
  const enabled = new Set(
    doc.routing.map((route) => `${route.nodeId}::${route.inPort}::${route.bus}`),
  );

  if (matrixNodes.length === 0) {
    return (
      <EmptyState>
        ルーティング行列を持つ機材がありません。ミキサーやオーディオインターフェイス、配信ソフトを
        追加すると表示されます。
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <p className="text-xs text-muted-foreground">
        チェックは「その入力がそのバスに乗るか」だけを表します。レベルやゲインは持ちません。
        リモート登壇者へのエコーは、会議ソフトの音声が送出バスに乗っていることが原因です。
      </p>
      {matrixNodes.map((info) => {
        const model = info.model;
        if (!model) return null;
        const inputs = model.ports.filter((port) => port.direction === "in");
        return (
          <section key={info.node.id}>
            <h2 className="mb-3 text-sm font-semibold">{info.label}</h2>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">入力</th>
                    {model.buses.map((bus) => (
                      <th key={bus.key} className="px-3 py-2 text-center">
                        {bus.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inputs.map((port) => (
                    <tr key={port.key} className="border-t">
                      <td className="px-3 py-2">{port.label}</td>
                      {model.buses.map((bus) => {
                        const on = enabled.has(`${info.node.id}::${port.key}::${bus.key}`);
                        return (
                          <td key={bus.key} className="px-3 py-2 text-center">
                            <Form method="post">
                              <input type="hidden" name="intent" value="toggle-route" />
                              <input type="hidden" name="nodeId" value={info.node.id} />
                              <input type="hidden" name="inPort" value={port.key} />
                              <input type="hidden" name="bus" value={bus.key} />
                              <button
                                type="submit"
                                aria-label={`${port.label} → ${bus.label}`}
                                aria-pressed={on}
                                className={
                                  on
                                    ? "size-5 rounded border border-primary bg-primary text-xs text-primary-foreground"
                                    : "size-5 rounded border border-input text-xs text-muted-foreground hover:border-ring"
                                }
                              >
                                {on ? "✓" : ""}
                              </button>
                            </Form>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function JsonTab({ doc, setupName }: { doc: SetupDoc; setupName: string }) {
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-1 text-sm font-semibold">構成ドキュメント</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          座標を持たない自己完結の JSON です。イベント間のコピーや、将来の AI 提案の入出力が
          この形式になります。
        </p>
        <Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="replace-doc" />
          <Textarea
            name="doc"
            rows={22}
            defaultValue={JSON.stringify(doc, null, 2)}
            className="font-mono text-xs"
            spellCheck={false}
          />
          <div>
            <Button type="submit" variant="secondary">
              この内容で置き換える
            </Button>
          </div>
        </Form>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-semibold">メモ</h2>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="set-notes" />
            <Textarea name="notes" rows={5} defaultValue={doc.notes ?? ""} />
            <div>
              <Button type="submit" variant="secondary" size="sm">
                保存
              </Button>
            </div>
          </Form>
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold">構成名</h2>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="rename-setup" />
            <Input name="name" defaultValue={setupName} maxLength={120} />
            <div>
              <Button type="submit" variant="secondary" size="sm">
                変更
              </Button>
            </div>
          </Form>
        </div>
      </section>
    </div>
  );
}
