import { ChevronDown, Menu, Minus, PanelLeft, PanelRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Link, redirect, useNavigation, useSearchParams } from "react-router";
import { Header } from "~/components/header";
import { LintPanel, SeverityChips, severityCounts } from "~/components/lint-panel";
import { SetupInspector } from "~/components/setup-inspector";
import { SetupTree } from "~/components/setup-tree";
import { AddPanel, CablesView, JsonView, RoutingView } from "~/components/setup-views";
import { SignalFlowDiagram } from "~/components/signal-flow-diagram";
import { requireUser } from "~/lib/auth-redirect.server";
import type { Fix } from "~/lib/av/diagnostics";
import { describeNode } from "~/lib/av/diagnostics";
import { buildGraph, orientHostAssignment } from "~/lib/av/graph";
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
  softDeleteSetup,
} from "~/lib/db";
import { emptyToNull, text } from "~/lib/form";
import { newDocId } from "~/lib/id";
import { buildNodeInfo, worstSeverities } from "~/lib/setup-view";
import { cn } from "~/lib/utils";
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
      await softDeleteSetup(env.DB, setup.id);
      return redirect(`/events/${setup.eventId}`);

    default:
      return { error: `不明な操作です: ${intent}` };
  }
}

function splitPortRef(value: FormDataEntryValue | null): [string, string] | null {
  const [nodeId, portKey] = text(value).split("::");
  return nodeId && portKey ? [nodeId, portKey] : null;
}

/**
 * The work surface's faces.
 *
 * These were page-level tabs (`?tab=`), which meant that acting on a finding
 * naming "MG10XU の CH 2" cost a tab switch and lost whatever else was on
 * screen. They are now views of the centre pane only: the tree and the
 * inspector stay put, so one implementation serves every screen width instead
 * of tabs on narrow ones and panels on wide ones.
 */
const VIEWS = [
  { id: "diagram", label: "図" },
  { id: "routing", label: "ルーティング" },
  { id: "cables", label: "結線表" },
] as const;

/** `auto` follows the screen width; the other two are the user overriding it. */
type PanelState = "auto" | "open" | "closed";

export default function SetupEditorPage({ loaderData, actionData }: Route.ComponentProps) {
  const { doc, models, available, diagnostics, nodeNames, layout, event, setup } = loaderData;
  const [params] = useSearchParams();
  const view = params.get("view") ?? "diagram";
  const selection = params.get("sel");
  const navigation = useNavigation();

  const [left, setLeft] = useState<PanelState>("auto");
  const [right, setRight] = useState<PanelState>("auto");
  const [adding, setAdding] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [highlight, setHighlight] = useState<ReadonlySet<string> | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  const hrefFor = (nextSelection: string, nextView?: string) => {
    const next = new URLSearchParams(params);
    next.set("sel", nextSelection);
    if (nextView) next.set("view", nextView);
    return `?${next}`;
  };
  const hrefForView = (nextView: string) => {
    const next = new URLSearchParams(params);
    next.set("view", nextView);
    return `?${next}`;
  };

  const nodeInfo = buildNodeInfo(doc, models, available);
  const computers = nodeInfo.filter((info) => info.model?.category === "computer");
  const softwareModels = models.filter(
    (model) =>
      model.category === "software_broadcast" || model.category === "software_conferencing",
  );
  const counts = severityCounts(diagnostics);
  const severities = worstSeverities(diagnostics);
  const spaceNames = Object.fromEntries(doc.spaces.map((space) => [space.id, space.label]));
  const enabled = new Set(
    doc.routing.map((route) => `${route.nodeId}::${route.inPort}::${route.bus}`),
  );
  // The only thing the diagram draws in the danger colour. Routing facts — a
  // return path under the picture — are not faults and must not borrow red.
  const alerts = new Set(
    diagnostics.flatMap((diagnostic) => (diagnostic.cycle ?? []).map((edge) => edge.id)),
  );

  // Clicking a row on a phone has to get the drawer out of the way; on a wide
  // screen `auto` is exactly where the panel already was, so the same call does
  // nothing there. An inspector the user collapsed on purpose stays collapsed.
  const onSelect = () => {
    setLeft("auto");
    setRight((current) => (current === "closed" ? current : "open"));
  };

  const fitWidth = () => {
    const element = surface.current;
    if (!element || layout.width === 0) return;
    setZoom(Math.max(0.4, Math.min(2, (element.clientWidth - 32) / layout.width)));
  };

  return (
    <div
      className="group/app @container flex h-dvh flex-col overflow-hidden"
      data-left={left}
      data-right={right}
    >
      <Header user={loaderData.user} fluid />

      <div className="flex flex-none items-center gap-2 border-b px-2 py-1.5">
        <IconButton
          label="構成の内容を開く"
          onClick={() => setLeft("open")}
          className="hidden @max-[720px]:inline-flex"
        >
          <Menu className="size-4" />
        </IconButton>
        <IconButton
          label={left === "closed" ? "左パネルを開く" : "左パネルを折りたたむ"}
          onClick={() => setLeft((current) => (current === "closed" ? "auto" : "closed"))}
          className="@max-[720px]:hidden"
        >
          <PanelLeft className="size-4" />
        </IconButton>
        <Link
          to={`/events/${event.id}`}
          className="truncate text-xs text-muted-foreground hover:underline @max-[720px]:hidden"
        >
          ← {event.title}
        </Link>
        <h1 className="truncate text-sm font-medium">{setup.name}</h1>
        <div className="flex shrink-0 items-center gap-1.5">
          <SeverityChips counts={counts} />
        </div>
        <span className="flex-1" />
        <Link
          to={hrefFor("setup")}
          replace
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"
        >
          構成の設定
        </Link>
        <IconButton
          label="インスペクタを開く"
          onClick={() => setRight("open")}
          className="hidden @max-[1000px]:inline-flex"
        >
          <PanelRight className="size-4" />
        </IconButton>
        <IconButton
          label={right === "closed" ? "右パネルを開く" : "右パネルを折りたたむ"}
          onClick={() => setRight((current) => (current === "closed" ? "auto" : "closed"))}
          className="@max-[1000px]:hidden"
        >
          <PanelRight className="size-4" />
        </IconButton>
      </div>

      {/* The four regions. The dock spans the centre column only, so collapsing
          it never disturbs the two panels and neither panel loses its height. */}
      <div
        className={cn(
          "relative grid min-h-0 flex-1",
          "[--left:264px] [--right:320px]",
          "grid-cols-[var(--left)_minmax(0,1fr)_var(--right)] grid-rows-[minmax(0,1fr)_auto]",
          "[grid-template-areas:'left_center_right'_'left_dock_right']",
          "group-data-[left=closed]/app:[--left:0px] group-data-[right=closed]/app:[--right:0px]",
          // Narrow: the panel leaves the grid and becomes an overlay, so its
          // column has to collapse whichever state it is in. Each case is
          // written out rather than relying on source order to beat the rule
          // above — a container query that silently loses is invisible.
          "@max-[1000px]:group-data-[right=auto]/app:[--right:0px]",
          "@max-[1000px]:group-data-[right=open]/app:[--right:0px]",
          "@max-[720px]:group-data-[left=auto]/app:[--left:0px]",
          "@max-[720px]:group-data-[left=open]/app:[--left:0px]",
        )}
      >
        <aside
          className={cn(
            "flex min-w-0 flex-col overflow-hidden border-r [grid-area:left]",
            "@max-[720px]:absolute @max-[720px]:inset-y-0 @max-[720px]:left-0 @max-[720px]:z-20",
            "@max-[720px]:w-[268px] @max-[720px]:bg-background @max-[720px]:shadow-xl",
            "@max-[720px]:-translate-x-full @max-[720px]:transition-transform",
            "@max-[720px]:group-data-[left=open]/app:translate-x-0",
          )}
        >
          <div className="flex flex-none items-center gap-2 border-b px-3 py-2">
            <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              構成の内容
            </h2>
            <span className="flex-1" />
            <IconButton
              label="機材と空間を追加"
              onClick={() => setAdding((current) => !current)}
              expanded={adding}
            >
              <Plus className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {adding ? <AddPanel available={available} softwareModels={softwareModels} /> : null}
            <SetupTree
              doc={doc}
              nodeInfo={nodeInfo}
              severities={severities}
              selection={selection}
              hrefFor={hrefFor}
              onSelect={onSelect}
            />
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col [grid-area:center]">
          <div className="flex flex-none items-center gap-1 overflow-x-auto border-b px-2 py-1.5">
            {VIEWS.map((entry) => (
              <Link
                key={entry.id}
                to={hrefForView(entry.id)}
                replace
                aria-current={view === entry.id ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 text-sm whitespace-nowrap text-muted-foreground hover:bg-secondary hover:text-foreground",
                  view === entry.id && "bg-secondary font-medium text-foreground",
                )}
              >
                {entry.label}
              </Link>
            ))}
            <span className="flex-1" />
            {view === "diagram" ? (
              <div className="flex shrink-0 items-center gap-1">
                <IconButton label="縮小" onClick={() => setZoom((z) => Math.max(0.4, z - 0.1))}>
                  <Minus className="size-4" />
                </IconButton>
                <span className="min-w-10 text-center text-xs text-muted-foreground tabular-nums">
                  {Math.round(zoom * 100)}%
                </span>
                <IconButton label="拡大" onClick={() => setZoom((z) => Math.min(2, z + 0.1))}>
                  <Plus className="size-4" />
                </IconButton>
                <button
                  type="button"
                  onClick={fitWidth}
                  className="rounded-md px-2 py-1 text-xs whitespace-nowrap text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  幅に合わせる
                </button>
              </div>
            ) : null}
          </div>

          <div ref={surface} className="min-h-0 flex-1 overflow-auto">
            {view === "diagram" ? (
              <div className="w-max min-w-full p-4">
                <SignalFlowDiagram
                  layout={layout}
                  alerts={alerts}
                  highlight={highlight}
                  scale={zoom}
                />
              </div>
            ) : null}
            {view === "routing" ? <RoutingView nodeInfo={nodeInfo} enabled={enabled} /> : null}
            {view === "cables" ? <CablesView doc={doc} nodeInfo={nodeInfo} /> : null}
            {view === "json" ? <JsonView doc={doc} /> : null}
          </div>
        </div>

        <aside
          className={cn(
            "flex min-w-0 flex-col overflow-hidden border-l [grid-area:right]",
            "@max-[1000px]:absolute @max-[1000px]:inset-y-0 @max-[1000px]:right-0 @max-[1000px]:z-20",
            "@max-[1000px]:w-80 @max-[1000px]:bg-background @max-[1000px]:shadow-xl",
            "@max-[1000px]:translate-x-full @max-[1000px]:transition-transform",
            "@max-[1000px]:group-data-[right=open]/app:translate-x-0",
          )}
        >
          <div className="flex flex-none items-center border-b px-3 py-2">
            <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              インスペクタ
            </h2>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {/* Keyed on the selection so the uncontrolled fields inside are torn
                down and rebuilt when a different thing is selected. React reuses
                a `<select>` across a re-render and leaves its selected option
                alone — `defaultValue` only applies at mount — so without this
                the panel keeps showing the *previous* node's 所在, 結合 and
                ホスト PC. Not keying it also means a stale value is what a 保存
                would write. */}
            <SetupInspector
              key={selection ?? "none"}
              doc={doc}
              nodeInfo={nodeInfo}
              selection={selection}
              computers={computers}
              enabled={enabled}
              setupName={setup.name}
              hrefFor={hrefFor}
              matrixInCenter={view === "routing"}
            />
          </div>
        </aside>

        <section className="flex min-w-0 flex-col border-t [grid-area:dock]">
          <div className="flex flex-none items-center gap-2 px-2 py-1.5">
            <IconButton
              label={dockOpen ? "検査結果を折りたたむ" : "検査結果を開く"}
              onClick={() => setDockOpen((current) => !current)}
              expanded={dockOpen}
            >
              <ChevronDown
                className={cn("size-4 transition-transform", !dockOpen && "-rotate-90")}
              />
            </IconButton>
            <h2 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              検査結果
            </h2>
            <SeverityChips counts={counts} />
            <span className="flex-1" />
            <span className="truncate text-[11px] text-muted-foreground @max-[720px]:hidden">
              行にカーソルを合わせると該当経路だけが残ります
            </span>
          </div>
          {dockOpen ? (
            <div className="max-h-52 overflow-auto border-t">
              <LintPanel
                diagnostics={diagnostics}
                nodeNames={nodeNames}
                spaceNames={spaceNames}
                hrefForNode={hrefFor}
                onFocus={setHighlight}
              />
            </div>
          ) : null}
        </section>

        {/* Only ever reachable while a panel is overlaying the work surface. */}
        <button
          type="button"
          aria-label="パネルを閉じる"
          onClick={() => {
            setLeft("auto");
            setRight("auto");
          }}
          className={cn(
            "absolute inset-0 z-10 hidden bg-black/30",
            "@max-[1000px]:group-data-[right=open]/app:block",
            "@max-[720px]:group-data-[left=open]/app:block",
          )}
        />
      </div>

      <div className="flex flex-none items-center gap-4 border-t bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
        <span>{navigation.state === "idle" ? "保存済み" : "保存中…"}</span>
        {view === "diagram" ? <span>表示 {Math.round(zoom * 100)}%</span> : null}
        {setup.docError ? <span className="text-destructive">{setup.docError}</span> : null}
        {actionData?.error ? <span className="text-destructive">{actionData.error}</span> : null}
        <span className="flex-1" />
        <Link
          to={hrefForView("json")}
          replace
          aria-current={view === "json" ? "page" : undefined}
          className={cn(
            "rounded px-1.5 py-0.5 hover:bg-secondary hover:text-foreground",
            view === "json" && "bg-secondary text-foreground",
          )}
        >
          {"</> JSON"}
        </Link>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  expanded,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      className={cn(
        "rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}
