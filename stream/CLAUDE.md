# CLAUDE.md — `@gdgjp/stream`

stream.gdgs.jp. Repo-wide conventions in `../CLAUDE.md`. Design rationale and the decisions
behind the model live in `../docs/260805_stream_av_designer.md` — read it before changing
anything in `app/lib/av/`.

Registers the 配信・音響機材 of an event and checks the wiring for howling, remote-participant
echo and a silent stream. AI-assisted proposal is a later phase; the linter is being built first
so it can serve as that phase's verifier.

## Dev

- `pnpm dev` — :5179
- `pnpm test:e2e` boots only this app; it does **not** need `../accounts` (see E2E below)

On the very first start after `node_modules/.vite` is cold, Vite discovers `lucide-react`,
`radix-ui` and friends late, logs `optimized dependencies changed. reloading`, and its automatic
reload lands on a half-swapped module graph — the page shows "Application Error" with
`Invalid hook call`. Reload once and it is fine; it does not recur while the cache stays warm.
It is not a duplicate-React problem, so `resolve.dedupe` does not help (verified) — don't add it.
- D1: `migrate:local` / `migrate:remote` (both regenerate `schema.sql`)
- Re-run `pnpm typecheck` after `wrangler.toml` binding edits

`wrangler.toml` still carries a placeholder `database_id`. Replace it with the id from
`wrangler d1 create gdgjp-stream-db` before any remote command. The Accounts OAuth client
`stream` must be seeded via `/admin/seed-clients` before sign-in works.

`.dev.vars`: `RP_SESSION_SECRET`, `IDP_CLIENT_SECRET`, and dev-only `APP_URL` / `ACCOUNTS_URL` /
`IDP_URL` overrides. See `.dev.vars.example`.

## Auth — RP of accounts

`app/lib/auth.server.ts` calls `initializeRpAuth` from `gdg-lib` with cookie prefix
`gdgjp-stream`. Same two passthroughs as the other RPs: `app/routes/api.auth.$.ts` and
`auth.signout.ts`. Use `requireUser` / `getOptionalUser` from `app/lib/auth-redirect.server.ts`.

## `app/lib/av/` — the model and the linter

Pure TypeScript, no D1, no React. Kept app-local for now; `gdg-lib` is scoped to RP auth. The
OBS extension and the CLI will consume JSON over the API, not this source.

### Three things carry the whole design

1. **Spaces are graph vertices.** `graph.ts` emits implicit edges `speaker → acoustic space → mic`,
   `display → visual space → camera`, and `join → transport space → every *other* join`. Howling,
   remote echo, the infinite mirror and a presenter's laptop feeding the room back through a second
   join of the same meeting are then all one cycle search. Deleting the space vertex silently
   disables most of the linter.

   A transport space is a meeting (Meet, VDO.Ninja) and is the one kind that excludes itself: it
   gets **one vertex per sending join**, `space:<id>:from:<nodeId>`, so the self-edge simply never
   exists. That absent edge is the Mix-Minus a conference bridge performs internally. Doing it
   with vertices rather than a search-time rule is what keeps `paths.ts` a generic BFS that knows
   nothing about join identity — do not move the exclusion into the search.
2. **Device internals are a boolean matrix, never levels.** `internalRouting` picks how signal
   crosses a device: `matrix` (the setup's `routing` array), `passthrough` (every input to every
   same-medium output — DI boxes, 会場常設 PA), `none` (endpoints, and conferencing apps, which
   must never route their own input to their own output). No gain, EQ, pan or fader values exist
   anywhere, deliberately: cycle detection never needs a dB value, and the omission is what keeps
   the data maintainable during a live event.
3. **A computer is an internal patchbay.** Software nodes carry `hostNodeId`. A link between a
   software node and its host may run out→out (an app playing into the headphone jack) or in→in
   (an app capturing from a USB input); `buildLinkEdges` orients those. Most Mix-Minus violations
   are OS device-selection mistakes, and this is what makes them visible.

### Invariants

- **`SetupDoc` has no coordinates.** Diagrams are laid out on every render. Adding positions
  breaks the AI-proposal path the whole design is aimed at.
- **`routing` is authoritative, not a delta over the model's defaults.** `defaultRoutes` is a
  template the editor copies in when a node is added. A mixer with no routing rows passes no
  audio, and that is correct — the UI pre-fills it.
- **USB audio is two ports, not one bidirectional port.** Every port is strictly `in` or `out`.
  Draw both links when a USB cable carries audio both ways.
- **`lint(doc, ctx)` keeps its two-argument shape.** `ctx.siblingSetups` is always empty today;
  it exists so simultaneous parallel tracks (design doc §8) do not force a signature change
  across every rule.
- **Diagnostics are machine-readable.** `ruleId`, `severity`, node/link ids, the `cycle` edges,
  and `fixes`. The AI phase depends on generate → lint → apply fixes → lint again.

### Known simplifications

Phantom power is checked one hop only (the port the mic plugs into). Only one loop is reported
per space and per conferencing app — they overlap heavily; fix one and re-run. A single loop
routinely passes through several spaces at once (a satellite feed crosses two rooms and a
meeting), so `loopRules` marks every space on a reported cycle as covered rather than reporting
the same loop once per room. `dangling-port` is scoped to endpoint categories so spare mixer
channels stay quiet.

A sender vertex merges a join's `mic_in` and `share_audio_in`, so the model says a listener's
`share_audio_out` can carry the far-end voice. It is a superset in the same direction as
`blackbox` passthrough, and it produces no loop that `spk_out` does not already produce.
`transport-echo-loop` searches audio only; a video loop through a meeting is the infinite-mirror
family and is left to `visual-feedback-loop`.

**Creating the transport space is opt-in.** `spaceRequired: false` on the conferencing coupling
keeps the commonest setup — one online speaker, far side not modelled — free of a
`space-unassigned` warning, which is deliberate. The cost is that a two-join loop is only found
once someone has made a meeting space and assigned both joins to it.

## Data model

Three layers plus the event, all in `migrations/`:

`device_models` (型番カタログ, shared) → `devices` (機材台帳 — one row per physical unit, a single
pool shared by every signed-in user, **not** scoped to a chapter) → `event_devices` (what was
actually brought) → `setups.doc` (the SetupDoc JSON).

**Software skips the ledger.** A `SetupNode` names either a `deviceId` or a `modelId`, never both.
Software is not a physical unit: two joins into one meeting are two nodes of one model, and a
"Meet #2" ledger row would make the future `device-double-booked` rule fire on them. The editor
and `/devices` only ever offer software as a model; a `deviceId` pointing at a software model
still resolves, so no document ever had to be migrated (the app has never been deployed remotely,
so none existed). `device-not-in-event` skips nodes with no `device`.

`devices.owner_note` is a memo, never an ACL. Keeping the ledger per-unit rather than
per-model-with-quantity is a prerequisite for the future double-booking rule; do not collapse it.

`setups` means *alternatives that are mutually exclusive in time* ("本番" / "リハ"). Simultaneous
tracks are a different axis — see design doc §8 before adding one.

## Two things `links` means

A cable runs output → input, physically exists, and someone can unplug it. A link between an app
and the computer it runs on is a device selection — which input OBS captures from, which output
it monitors on — and runs out→out or in→in. `buildLinkEdges` orients both; `isHostAssignment`
tells them apart from the document alone, and `orientHostAssignment` derives the direction from
the two port directions.

The editor keeps them in separate tables with separate forms, and the cable form offers only
outputs as a source and only inputs as a destination. It used to be one form whose hint had to
say "out→out is correct between an app and its host PC" — a caveat like that is the sign of two
relationships wearing one name. The assignment form never asks which way round the link goes.

Because `orientHostAssignment` only ever produces same-face links, `routeNested` can assume both
ends sit on the same side of the machine and route straight up the gutter. Anything else between
an app and its host is not a device selection, and falls back to `routeSibling`.

The long-term fix is to move assignments out of `links` and onto the node
(`assignments: { port, hostPort }[]`), so `links` means only cables and the AI phase never has to
be taught the out→out rule. That is a schema change, so it should ride along the next one rather
than happen alone.

## Routes

Flat RR7 framework-mode in `app/routes.ts`.

| Route | Screen |
| --- | --- |
| `/` | Landing, the only page that works signed out |
| `/models`, `/models/:modelId` | 型番カタログ. Ports, buses and the default routing template |
| `/devices` | 機材台帳 — the shared per-unit pool |
| `/events`, `/events/:eventId` | Events; the detail page picks the available gear and lists setups |
| `/events/:eventId/setups/:setupId` | The setup editor |

Everything except `/` and `/signin` is behind `requireUser`.

### Setup editor

One route, one action, dispatched on a hidden `intent` field. Every write goes
`applyOperation` / `applyFix` → `saveSetupDoc`, so mutation stays pure and testable and the
AI phase can reuse the same path.

Tabs are a `?tab=` search param rather than component state. Forms post to the current URL, so
the tab survives a submit — toggling a routing cell must not bounce the user back to the first
tab.

Lint runs in the loader and the panel sits above the tabs, always visible. `apply-fix` posts the
serialized `Fix` straight back; `canApplyFix` decides which ones get a button.

## E2E (no real OAuth)

`e2e/global-setup.ts` skips the IdP the way wiki's does: apply the local migrations, write
fixtures straight into the miniflare D1 file with `node:sqlite`, and forge a
`gdgjp-stream-session` cookie signed with `RP_SESSION_SECRET` from `.dev.vars`. Needs `.dev.vars`
and one prior `pnpm dev` to create the D1 file. Storage state lands in `e2e/storage-state/`
(gitignored) and is wired through `use.storageState`, so every spec is signed in unless it opts
out with `test.use({ storageState: { cookies: [], origins: [] } })`.

Setup **wipes and recreates** everything matching `e2e_%` or named `E2E %` on each run, so specs
may create rows as long as they name them with `E2E_PREFIX`.

The suite is fully parallel, so fixtures are split by who mutates them — `e2e/seed-data.ts` is
the single source of truth. `EVENT` is read-only; `GEAR_EVENT` exists purely so `event.spec.ts`
can toggle a gear list without `linter.spec.ts` seeing it. Same for the `*_fix` setups. If you
add a spec that writes, give it its own fixture rather than sharing one.

`linter.spec.ts` is the suite that matters: each fixture is a wiring mistake that has actually
cost an event (howl, Mix-Minus violation, silent stream), driven through the real editor. It
asserts both that the rule fires and that the one-click fix resolves it *without* creating a new
problem — cutting the MAIN send must not silence the stream.

The panel exposes `data-testid="lint-panel"` and per-finding `data-rule-id` / `data-severity`.
Keep those when restyling; they are the suite's only stable hook.

### Diagram

`layoutGraph` is a four-stage Sugiyama pipeline: rank into columns, insert a dummy per column a
long edge crosses, order the rows (median heuristic), assign y. The component draws the
`points` it is handed and owns no geometry.

Ranking is longest path **after cutting back edges**, constrained by role. Do not "simplify" the
cutting away: relaxing over a loop adds a column per pass, and since a howling setup is the
normal input here, a four-node document rendered ~5000px wide before it was fixed. The
regression test asserts `columns <= nodes.length`, and `linter.spec.ts` asserts the rendered
width from the browser.

`CATEGORY_ROLE` in `layout.ts` sorts each category into `input` / `hub` / `output`, which is what
gives the diagram its left-to-right bands. Two rules implement it: every edge arriving at an
input is cut before the loop search runs, and outputs get a rank floor one past the deepest
non-output. Rooms carry no role — a room lands wherever what feeds it puts it, which is just
past the speakers, so the rightmost box is usually the room.

The role constraint is also what makes the layout *fair*: with pure longest path, which edge got
cut to break a loop depended on the order the search visited nodes, so two identical mics could
land in different columns. Cutting by rule instead of by search order puts them together.

### Containment

Two things contain other things, and neither is a column, because where a thing *is* has nothing
to do with which stage of the chain it is.

**A computer contains its apps.** A software node is drawn *inside* its host's box: `nestBoxes`
folds the children's heights into the machine before anything is ranked, and the child never
enters the column stages at all. `projectToRoots` then re-points every edge at the machine, so
the machine is the unit that gets ranked. This replaced three special cases that used to chase an
app around after ranking had scattered it (`pinToHosts`, `hostsFirst`, and a host-pinning pass in
`assignRows`) — do not reintroduce them. `routeNested` draws the device selection up the gutter
between the app's border and the machine's, the one strip of the machine nothing else occupies.

The cost is deliberate: a conferencing app is **no longer pinned left**. It goes where its
machine goes, because a Meet window several columns away from the laptop running it was the thing
being complained about. `joinRole` still derives the role (§9.7.1) and the role still tints the
band and still decides the column for a join with no host.

**A room contains what is in it.** `SetupNode.spaceId` means *where this node is*; for a category
that couples to a space it is also what it couples to, and for a mixer or a PC the graph ignores
it. `collectPlaces` groups spaces into places by `venueKey ?? id`, so a hall's acoustic and visual
spaces are one room and one frame — the use `venueKey` was reserved for.

A room spans the whole chain, so it cannot be a box; it is a **horizontal lane**. `separateLanes`
shifts each place's members as a rigid body onto its own band of rows. That is not cosmetic: a
plain bounding box round a room's members would swallow whichever box from the room next door
happened to be laid out between them, and lanes make that impossible rather than unlikely. A
rigid shift also cannot introduce a collision, since the alignment passes already settled the
inside of each lane.

`computeFrames` then draws the border. A place holding nothing but its own air gets no frame.

Bands come from `computeBands`: a run of columns sharing a role, emitted as a tint the component
captions 入力 / 中間 / 出力 / 空間. Deliberately a tint and **not** a frame — position already
carries the role, and a role is not a container. The three shapes now say three different things
and must stay distinct: tint = role, border = place, box-inside-box = machine runs the app.

`software_conferencing` is the one category whose role is **derived from its wiring** rather than
fixed (`joinRole`). Only outputs wired, or nothing wired yet, means `input` — a remote participant
is someone talking into the room. Only inputs wired means `output`: a join used purely to send to
a satellite room is a sink, and treating that as a source drops the whole main signal into the
return lane.

The predicate counts only `cable` and `host` edges (`isPortWired`). Every join in a meeting has
space edges on both faces, so counting those would classify every join as "both" and the role
would be fixed again in all but name.

Two properties exist for the phases after this one, and both have tests:

- **Ports are first class.** A cable ends at a jack. Anchors come from the model's `ports` order,
  never from which links exist, so drawing a new cable cannot move anchors already on screen —
  the precondition for visual wiring. `LayoutEdge` carries `linkId`, and the SVG carries
  `data-node-key` / `data-port-key` / `data-link-id`, which is the hit-testing hook.
- **Small edits move the picture a little.** Every stage is deterministic, ties break on the
  incoming order, and `options.order` seeds the row ordering with a previous `Layout.order`.
  Plain barycenter/median without that seed reshuffles a column when one link is added, which
  makes live AI visualisation unreadable. Pass the seed when re-laying out an edited document.

Three edge kinds are treated differently on purpose. `internal` is not drawn at all — it lives
inside one box and the routing matrix is the honest view of it. `space` is not a cable, so it
collapses to one edge per box pair and anchors on the box, not on a jack; that is what keeps a
room from growing a fan of lines. `cable` and `host` draw one line per link.

**The danger colour belongs to the linter, not to the layout.** The diagram draws in red only the
graph edges passed in as `alerts`, which the route builds from `Diagnostic.cycle`. Being routed
in the return lane is a fact about ranking, not a fault: the room feeding a mic and the send back
to a remote participant are both correct wiring and both take that lane, so colouring the lane
red trains people to ignore red. `LayoutEdge.sourceIds` exists for this — room coupling collapses
several graph edges into one line, and matching on `id` alone would draw a reported loop as
innocent.

Diagonals only ever occur in the gap between two columns, and a gap holds no boxes — that
invariant is what the "routes clear of the boxes" test checks by sampling along each segment.
Host links run out→out or in→in, so one end sits on the wrong face of its box; those loop around
the box rather than have the jack drawn on a side it does not belong on. Back edges get a lane
under the diagram, one per edge.

Still open: identical devices can land in different columns, because which edge gets cut depends
on DFS order (in the mixed audio/video fixture one handheld mic ranks at column 0 and its twin at
column 4). Deterministic, but asymmetric.
