import { ChevronDown, Menu, Minus, PanelLeft, PanelRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import { Link, redirect, useFetcher, useSearchParams } from "react-router";
import { Header } from "~/components/header";
import { LintPanel, SeverityChips, severityCounts } from "~/components/lint-panel";
import { SetupInspector } from "~/components/setup-inspector";
import { SetupTree } from "~/components/setup-tree";
import { AddPanel, CablesView, JsonView, RoutingView } from "~/components/setup-views";
import type { PortEnd } from "~/components/signal-flow-diagram";
import { SignalFlowDiagram } from "~/components/signal-flow-diagram";
import { requireUser } from "~/lib/auth-redirect.server";
import { describeNode } from "~/lib/av/diagnostics";
import { buildGraph } from "~/lib/av/graph";
import { layoutGraph } from "~/lib/av/layout";
import { lint } from "~/lib/av/lint";
import { placeKeyOf } from "~/lib/av/places";
import type { PortRef, SetupDoc } from "~/lib/av/schema";
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
import { text } from "~/lib/form";
import { applyIntent } from "~/lib/setup-intents";
import { buildNodeInfo, collectPlaces, worstSeverities } from "~/lib/setup-view";
import { useOptimisticDoc } from "~/lib/use-setup-doc";
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

  const [models, eventDeviceIds, ledger] = await Promise.all([
    listModels(env.DB),
    listEventDeviceIds(env.DB, setup.eventId),
    listLedger(env.DB),
  ]);

  return {
    user: { name: user.name, email: user.email, image: user.image },
    event: { id: event.id, title: event.title },
    setup: { id: setup.id, name: setup.name, docError: setup.docError },
    doc: setup.doc,
    models,
    // Every unit, not just this event's: a node pointing at gear that was not
    // brought must surface as `device-not-in-event`, not `unknown-reference`.
    // In ledger order, so the "add gear" list stays grouped by category.
    devices: ledger.map((device) => ({
      id: device.id,
      modelId: device.modelId,
      name: device.name,
    })),
    eventDeviceIds: [...eventDeviceIds],
  };
}

/**
 * Selecting something and switching views are query-string moves, and the
 * document did not change — re-reading it would put a round trip in front of
 * every click on the canvas. A fetcher submission still revalidates, which is
 * what replaces the optimistic document with the saved one.
 */
export function shouldRevalidate(arg: ShouldRevalidateFunctionArgs) {
  if (arg.formMethod) return arg.defaultShouldRevalidate;
  return arg.currentUrl.pathname !== arg.nextUrl.pathname;
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

  // The two that edit the row rather than the document.
  if (intent === "rename-setup") {
    await renameSetup(env.DB, setup.id, text(form.get("name")) || "(無題)");
    return null;
  }
  if (intent === "delete-setup") {
    await softDeleteSetup(env.DB, setup.id);
    return redirect(`/events/${setup.eventId}`);
  }

  // Everything else is the browser's own edit, replayed against the stored
  // document — see `app/lib/setup-intents.ts` for why there is only one of it.
  const [models, devices] = await Promise.all([listModels(env.DB), loadDevices(env.DB)]);
  const outcome = applyIntent(setup.doc, form, {
    models: new Map(models.map((model) => [model.id, model])),
    devices,
  });
  if (outcome.kind !== "doc") {
    return { error: outcome.kind === "error" ? outcome.error : `不明な操作です: ${intent}` };
  }
  await saveSetupDoc(env.DB, setup.id, outcome.doc, user.id);
  return null;
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
  const { models, devices, eventDeviceIds, event, setup } = loaderData;
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "diagram";
  const selection = params.get("sel");

  // The catalog the linter, the graph and every intent read. Built once from
  // what the loader sent, because all three have to resolve a `deviceId` the
  // same way or they describe different documents.
  const catalog = useMemo(
    () => ({
      models: new Map(models.map((model) => [model.id, model])),
      devices: new Map(devices.map((device) => [device.id, device])),
    }),
    [models, devices],
  );

  const { doc, busy } = useOptimisticDoc(loaderData.doc, catalog);
  // Drag-to-wire has no form of its own to post, so it needs a fetcher it can
  // submit to directly. Everything else on the page goes through `SetupForm`.
  const wiring = useFetcher();
  const wiringError = (wiring.data as { error?: string } | undefined)?.error;

  const eventDevices = useMemo(() => new Set(eventDeviceIds), [eventDeviceIds]);
  const available = useMemo(
    () => devices.filter((device) => eventDevices.has(device.id)),
    [devices, eventDevices],
  );

  const diagnostics = useMemo(
    () => lint(doc, { ...catalog, eventDeviceIds: eventDevices }),
    [doc, catalog, eventDevices],
  );
  const graph = useMemo(() => buildGraph(doc, catalog), [doc, catalog]);
  // Seeded with the row order the last picture used, which is what keeps one
  // added cable from reshuffling a column under the cursor that drew it.
  const order = useRef<readonly string[] | undefined>(undefined);
  const layout = useMemo(() => layoutGraph(graph, { order: order.current }), [graph]);
  useEffect(() => {
    order.current = layout.order;
  }, [layout]);

  // Same naming the diagnostics use, so a fix button and the message it sits
  // under call the same machine the same thing.
  const nodeNames = useMemo(
    () => Object.fromEntries([...graph.nodes.keys()].map((id) => [id, describeNode(graph, id)])),
    [graph],
  );

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

  // A room is two shapes at once — the dashed box for the air in it, and the
  // frame round everything standing in it — so selecting one has to light both.
  const places = collectPlaces(doc);
  const selectedKeys = new Set<string>();
  if (selection) {
    selectedKeys.add(selection);
    const space = doc.spaces.find((entry) => `space:${entry.id}` === selection);
    const placeKey = space ? placeKeyOf(space) : null;
    if (placeKey) selectedKeys.add(placeKey);
  }

  // Selecting is two-way now, so the picture has to answer for it: picking a
  // row in the tree or a finding in the dock is a claim about a box, and on a
  // rig tall enough to scroll that box is usually not the one on screen.
  // `nearest` so a box already in view is left exactly where it is.
  useEffect(() => {
    if (view !== "diagram" || !selection) return;
    const box = surface.current?.querySelector(`[data-node-key="${CSS.escape(selection)}"]`);
    box?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [view, selection]);

  const selectOnCanvas = (key: string) => {
    // A frame is a place and a place can cover several spaces (a hall's
    // acoustic and visual one share a `venueKey`), so it lands on the same
    // space the tree's header selects rather than on a second one.
    const place = places.find((entry) => entry.key === key);
    const next = new URLSearchParams(params);
    next.set("sel", place ? `space:${place.spaceIds[0]}` : key);
    setParams(next, { replace: true, preventScrollReset: true });
    onSelect();
  };

  /**
   * What dragging one jack onto another means, or `null` if it means nothing.
   *
   * The two relationships look identical on the canvas and are told apart by
   * geometry alone: across the faces is a cable, and on the same face is an app
   * picking a device on the computer under it. That is the same rule
   * `buildAssignmentEdges` applies to derive the direction, which is why
   * neither the drag nor the assignment form ever asks which way round it goes.
   */
  const wireFor = (from: PortEnd, to: PortEnd) => {
    if (from.nodeId === to.nodeId) return null;
    const a: PortRef = [from.nodeId, from.portKey];
    const b: PortRef = [to.nodeId, to.portKey];

    if (from.direction !== to.direction) {
      // Drawn output → input however the drag was made: patching backwards
      // from the input you are standing at is how people actually wire.
      const [out, into] = from.direction === "out" ? [a, b] : [b, a];
      if (hasLink(doc, out, into)) return null;
      return { intent: "add-link", from: out, to: into } as const;
    }

    const hostOf = (nodeId: string) => doc.nodes.find((node) => node.id === nodeId)?.hostNodeId;
    if (hostOf(from.nodeId) === to.nodeId && !hasAssignment(doc, a)) {
      return { intent: "add-assignment", app: a, host: b } as const;
    }
    if (hostOf(to.nodeId) === from.nodeId && !hasAssignment(doc, b)) {
      return { intent: "add-assignment", app: b, host: a } as const;
    }
    return null;
  };

  const onWire = (from: PortEnd, to: PortEnd) => {
    const drawn = wireFor(from, to);
    if (!drawn) return;
    wiring.submit(
      drawn.intent === "add-link"
        ? { intent: drawn.intent, from: portValue(drawn.from), to: portValue(drawn.to) }
        : { intent: drawn.intent, app: portValue(drawn.app), host: portValue(drawn.host) },
      { method: "post" },
    );
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
                  selected={selectedKeys}
                  onSelect={selectOnCanvas}
                  canWire={(from, to) => wireFor(from, to) !== null}
                  onWire={onWire}
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
        <span>{busy ? "保存中…" : "保存済み"}</span>
        {view === "diagram" ? <span>表示 {Math.round(zoom * 100)}%</span> : null}
        {setup.docError ? <span className="text-destructive">{setup.docError}</span> : null}
        {/* Every form reports its own refusal under itself (`SetupForm`). What
            is left for here is the drag, which has no form to report under, and
            `actionData`, which is only set when the browser posted a form
            itself — the no-JavaScript path. */}
        {(wiringError ?? actionData?.error) ? (
          <span className="text-destructive">{wiringError ?? actionData?.error}</span>
        ) : null}
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

/** An app port already selects a device — one input reads from one of them. */
function hasAssignment(doc: SetupDoc, app: PortRef): boolean {
  const node = doc.nodes.find((entry) => entry.id === app[0]);
  return (node?.assignments ?? []).some((assignment) => assignment.port === app[1]);
}

function hasLink(doc: SetupDoc, from: PortRef, to: PortRef): boolean {
  return doc.links.some(
    (link) =>
      link.from[0] === from[0] &&
      link.from[1] === from[1] &&
      link.to[0] === to[0] &&
      link.to[1] === to[1],
  );
}

/** The `nodeId::portKey` shape every port field on this route already posts. */
function portValue(ref: PortRef): string {
  return `${ref[0]}::${ref[1]}`;
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
