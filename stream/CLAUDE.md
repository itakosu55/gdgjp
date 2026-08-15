# CLAUDE.md — `@gdgjp/stream`

stream.gdgs.jp. Repo-wide conventions in `../CLAUDE.md`.

Registers the 配信・音響機材 of an event and lints the wiring for howling, remote-participant echo
and a silent stream. AI-assisted proposal is a later phase; the linter is being built first so it
can serve as that phase's verifier.

**Two documents carry the reasoning this file does not repeat.**
`../docs/260805_stream_av_designer.md` is the design (all § numbers below point into it), and
`../docs/260811_stream_implementation_notes.md` is why the code has the shape it has. Read the
notes before changing `app/lib/av/`, the layout pipeline, or the editor's intents — most rules
below are one line here and a paragraph of reasoning there.

## Dev

- `pnpm dev` — :5179
- `pnpm test:e2e` boots only this app; it does **not** need `../accounts`
- D1: `migrate:local` / `migrate:remote` (both regenerate `schema.sql`)
- Re-run `pnpm typecheck` after `wrangler.toml` binding edits

`wrangler.toml` still carries a placeholder `database_id` — replace it with the id from
`wrangler d1 create gdgjp-stream-db` before any remote command. The Accounts OAuth client `stream`
must be seeded via `/admin/seed-clients` before sign-in works. `.dev.vars`: `RP_SESSION_SECRET`,
`IDP_CLIENT_SECRET`, and dev-only `APP_URL` / `ACCOUNTS_URL` / `IDP_URL` overrides — see
`.dev.vars.example`.

On the first start after `node_modules/.vite` is cold, Vite logs `optimized dependencies changed.
reloading` and its reload lands on a half-swapped module graph — "Application Error" with
`Invalid hook call`. Reload once. It is not a duplicate-React problem; `resolve.dedupe` does not
help (verified) — don't add it.

## Auth — RP of accounts

`app/lib/auth.server.ts` calls `initializeRpAuth` from `gdg-lib` with cookie prefix `gdgjp-stream`.
Same two passthroughs as the other RPs: `app/routes/api.auth.$.ts` and `auth.signout.ts`. Use
`requireUser` / `getOptionalUser` from `app/lib/auth-redirect.server.ts`.

## Data model

`device_models` (型番カタログ) → `devices` (機材台帳) → `event_devices` (what was brought) →
`setups.doc` (the SetupDoc JSON). All in `migrations/`.

- `devices` is **one row per physical unit** in a single pool shared by every signed-in user, not
  scoped to a chapter. Do not collapse it to model-with-quantity — the future `device-double-booked`
  rule needs the per-unit form. `devices.owner_note` is a memo, never an ACL.
- **Software skips the ledger.** A `SetupNode` names `deviceId` **or** `modelId`, never both.
- `setups` means alternatives *mutually exclusive in time* (本番 / リハ). Simultaneous tracks are a
  different axis — see §8 first.

## `app/lib/av/` — the model and the linter

Pure TypeScript, no D1, no React. Kept app-local; `gdg-lib` is scoped to RP auth. The OBS extension
and the CLI will consume JSON over the API, not this source.

Three ideas carry the design:

1. **Spaces are graph vertices.** `graph.ts` emits `speaker → acoustic space → mic`,
   `display → visual space → camera`, `join → transport space → every *other* join`, so howling,
   remote echo and the infinite mirror are one cycle search. A transport space gets one vertex per
   sending join (`space:<id>:from:<nodeId>`) — that absent self-edge *is* Mix-Minus. Keep the
   exclusion in the vertices; `paths.ts` must stay a generic BFS that knows nothing about joins.
2. **Device internals are a boolean matrix, never levels.** `internalRouting` is `matrix` |
   `passthrough` | `none`. No gain, EQ, pan or fader exists anywhere, deliberately.
3. **A computer is an internal patchbay.** Software nodes carry `hostNodeId`; a link to the host
   may run out→out or in→in, and `buildLinkEdges` orients it.

### Invariants

- **`SetupDoc` has no coordinates.** Layout runs on every render; positions would break the
  AI-proposal path the design is aimed at.
- **`routing` is authoritative, not a delta.** `defaultRoutes` is only a template the editor copies
  in. A mixer with no routing rows passes no audio, and that is correct.
- **Every port is strictly `in` or `out`.** USB audio is two ports; draw both links.
- **`lint(doc, ctx)` keeps its two-argument shape.** `ctx.siblingSetups` is empty today and exists
  so §8 does not force a signature change across every rule.
- **Diagnostics are machine-readable** — `ruleId`, `severity`, ids, `cycle`, `fixes`. The AI phase
  runs generate → lint → apply fixes → lint again.
- **Add every new `SetupNode` field to `clean()` in `mutations.ts`.** It rebuilds from a whitelist,
  so a field it does not know is silently dropped on the next unrelated edit. `isolatedPorts`,
  `ports` and `assignments` each hit this. `Space` has no equivalent — `update-space` merges a
  patch — so do not grow one.
- **Port resolution has one implementation**, `resolvePorts` in `av/ports.ts`, read through
  `graph.resolveNode` and `setup-view.buildNodeInfo`. Nothing may grow a second — the editor
  applies every edit twice (optimistically, then on the server), so a rival implementation shows up
  as the picture disagreeing with what was saved. Downstream code reads `ResolvedNode.ports` /
  `NodeInfo.ports` and never learns a port can have come from the document.
- **Space coupling is read from `DeviceModelPort.couples`** (`from_space` / `to_space` / `null`).
  `CATEGORY_COUPLING` survives only as the default a new catalog port gets and as warning policy;
  the graph never reads it.

### Vocabulary the rules are written in

- **A port can be a template.** `DeviceModelPort.expandable` marks a kind of source;
  `SetupNode.ports` lists the instances (`key`, `template`, `label`, `sourceId`), and
  `resolvePorts` merges the two.
  Instance keys are `<template>:<n>` counting from the highest ever used and are **never**
  renumbered — the document is a single JSON column and `links`/`routing` name those keys. A
  default route naming a template follows every instance of it (`sourceRoutes` in `mutations.ts`),
  and `add-node` seeds one instance of each *unpaired* template.
- **A source is a jack that hears the room, or a port with `DeviceModelPort.origin`** (BGM, a video
  file). `sourcesOf` in `rules/coverage.ts` is the single set all three audience questions are
  asked of — PROGRAM (`no-audio-to-stream`), the meeting (`source-not-reaching-remote`) and the
  room (`source-not-reaching-room`). An origin is one source *per port*, not per node.
- **`sourceKey` (catalog) / `sourceId` (document)** pair two jacks into one source — audio and video
  stay separate ports because "the picture is on the stream and the sound is not" is the commonest
  accident there is. Grouping is per direction; a group of one is dropped. `partial-source` judges
  on reaching PROGRAM, not on being wired.
- **所在 is a place, and the jack picks the space.** `SetupNode.spaceId` names one Space, and
  `spacesForPort` walks space → `placeKeyOf` → the place's spaces → the one this port's medium can
  reach. `placeKeyOf` (`av/places.ts`) keys spaces into places by `venueKey ?? id`, so a hall's
  acoustic and visual spaces are one room. A meeting is not a place, so a join resolves to its
  transport space directly.
- **The 所在 select asks for a place too.** `locationOptions` (`setup-view.ts`) offers one entry per
  room — valued at the room's first space, which `inPlaceOrder` fixes — or the meetings when the
  model is a join. `locationValue` reads a node standing in *either* half of a hall back to that one
  entry: a `<select>` whose `defaultValue` matches no option shows its first one instead — here
  「（割り当てなし）」 — and 保存 posts whatever is showing, so the mismatch would not merely
  misreport the room but take it away on the next unrelated edit.
- **Muting is per jack.** `SetupNode.isolatedPorts`; node-wide `coupling: "isolated"` is the
  shorthand for all of them. `isolationFixes` names the jacks a cycle enters and leaves a space by,
  not nodes picked by category (§4.3 — offer the operation people actually perform).
- **`spaceNeedOf(category)`** decides when `space-unassigned` fires: `always` for transducers,
  `never` for a join (§9.3), `when-wired` for everything else.

### Known simplifications

Phantom power is checked one hop only. One loop is reported per space and per conferencing app, and
`loopRules` marks every space on a reported cycle as covered. `dangling-port` is scoped to endpoint
categories, so spare mixer channels and origins stay quiet. `transport-echo-loop` searches audio
only — video loops belong to `visual-feedback-loop`. `unreachable-device` skips both ends of a host
relationship; an app with no device selection is `software-io-unassigned` instead. Coverage rules
never rise above warn: a hall mic that is not in the hall speakers is usually correct wiring, and a
critical that correct wiring cannot clear breaks the fix-one-and-re-run loop. Sources are still
limited to `mic` / `camera` categories plus origins, so a USB speakerphone's room-facing jack is not
counted.

**`Space.reinforced` is a declaration, not a suppression** (§13). A closed acoustic loop is
howling's necessary condition; the sufficient one is loop gain, which idea 2 above refuses to hold.
So a room may say it reinforces, and `acoustic-feedback-loop` drops to warn — but only when *every*
space on the cycle says so, and never for `stream-monitor-loop` or `transport-echo-loop`, which
placement cannot fix. It has to cut both ways or it rots into a lint-disable: in a reinforced room
`source-not-reaching-room` rises info → warn, because the reason it was info (the hall mic is
deliberately kept out of the hall speakers) is the very thing the room just denied. `declare-reinforced`
is a `Fix` that **`canApplyFix` refuses** — machines may rewire, only people may assert facts about
the world — so `LintPanel` renders it as a link to the space, not a button.

**`DeviceModel.echoCancels` is a spec, and the wiring is still the judge** (§13.7). AEC needs one
unit holding both ends of its reference, and the path proves that on its own only for a unit that
is *both faces of the room* — a laptop's built-in pair, a speakerphone. A room DSP owns neither
transducer and stands exactly where a plain mixer stands, so the catalog says which box has the
hardware and `aecCanceller` still requires it to stand on **both legs** of the room hop before
`remote-echo-acoustic` drops to warn. A model may claim the hardware; it may not claim the
installation. Cutting both ways again: a declaring unit on only one leg raises
`aec-reference-missing`, having nothing to subtract, or nothing to subtract it from.

## Three relationships, and only one of them is a link

- **A cable** runs output → input and physically exists. `links` means this and nothing else, so
  `buildLinkEdges` has no exceptions. An out→out link is plainly `bad-link-direction`.
- **A device selection** is `SetupNode.assignments: { port, hostPort }[]` — a fact about the app, so
  it lives on the app. **The direction is derived and never written down**: `buildAssignmentEdges`
  reads it off the two jacks' shared direction.
- **A capture** is one app taking another's window on the machine they share. Still written as a
  link, but `buildLinkEdges` tags it `kind: "capture"` when both ends are software with the same
  `hostNodeId`. `cable-bypasses-host` (warn) reports the mistake version — a cable with exactly one
  end on a hosted app; a join with no `hostNodeId` is skipped.

The editor keeps cables and selections in separate tables with separate forms; the cable form offers
only outputs as a source and only inputs as a destination. An assignment carries no `linkId`, so
tests find it by its jack.

## Routes

Flat RR7 framework-mode in `app/routes.ts`. Everything except `/` and `/signin` is behind
`requireUser`.

| Route | Screen |
| --- | --- |
| `/` | Landing, the only page that works signed out |
| `/models`, `/models/:modelId` | 型番カタログ. Ports, buses and the default routing template |
| `/devices` | 機材台帳 — the shared per-unit pool |
| `/events`, `/events/:eventId` | Events; the detail page picks gear and lists setups |
| `/events/:eventId/setups/:setupId` | The setup editor |

### Setup editor

One route, one action, dispatched on a hidden `intent`. Every write goes `applyOperation` /
`applyFix` → `saveSetupDoc`.

- **`setup-intents.ts` is the single implementation of what an intent means.** `applyIntent(doc,
  formData, catalog)` is pure and *both* sides run it — the action against the stored document, the
  browser against its own copy while the request is in the air. Never re-derive an intent's effect
  anywhere else. `rename-setup` / `delete-setup` return `elsewhere`: they are columns, not document
  edits.
- **A room is added as a room, not a space at a time.** `add-place` mints one space per medium the
  form ticked and gives a pair the same `venueKey` — the first minted id, which is what `placeKeyOf`
  falls back to anyway, so a room of one medium carries no key at all and is written exactly as
  `add-space` writes it. The checkboxes come from `PLACE_KINDS` (`av/places.ts`), derived from "a
  meeting is not a place" rather than spelled out, and reading the submission back through that
  list is also what puts air before sight in the document. A typed `venueKey` still wins — that is
  the §8 cross-track case. `add-space` stays the primitive, and is what the ミーティング form posts.
- State lives in the URL — `?view=diagram|routing|cables|json`, `?sel=<nodeId> | space:<spaceId> |
  setup` — because forms post to the current URL.
- Four regions: `setup-tree.tsx`, the centre pane (`setup-views.tsx`), `setup-inspector.tsx`, and
  the lint dock across the centre column only. `setup-view.ts` is the view model all three read.
- One implementation serves every width: two container queries (`@max-[1000px]`, `@max-[720px]`)
  plus a three-state `auto | open | closed` per panel. Write every narrow override out per state —
  a container query that silently loses to a `group-data-` rule looks exactly like one that never
  matched, and this editor has had that bug.
- **Lint and layout run in the browser.** The loader sends the document and the catalog and nothing
  else; `buildGraph` → `lint` → `layoutGraph` are `useMemo`s, so they run during SSR too. The
  catalog carries **every** unit in the ledger, or `device-not-in-event` degrades into
  `unknown-reference`.
- Every form is a `SetupForm` (a `useFetcher`), and `useOptimisticDoc` replays pending submissions
  through `applyIntent`, so toggling a matrix cell re-lints on the click. `replace-doc` is
  deliberately **not** optimistic.
- `shouldRevalidate` returns false for a query-string-only move.
- A refusal lands on `fetcher.data` and **`useFetchers()` cannot carry it** — the router drops an
  idle fetcher one render after it settles. `SetupForm` renders its own error under itself.
- Pass the previous `Layout.order` back into `layoutGraph` on every re-layout.
- Two edits fired inside one round trip still race at the database — a property of the single JSON
  column, not of the fetchers.
- **The picture is the wiring surface.** Dragging jack to jack is told apart by geometry alone —
  across the faces is a cable, along one face is a device selection — the same rule
  `buildAssignmentEdges` uses, so neither drag nor form asks which way round it goes. `canWire` /
  `onWire` come from the route, the only place that knows about `hostNodeId`. A drag is not
  keyboard-reachable: the cable and assignment forms in 結線表 are the accessible path and must
  stay. Media mismatches are *allowed* by the drag, exactly as the form allows them — the linter is
  the authority. `apply-fix` posts a serialized `Fix`; `canApplyFix` decides which get a button.

## Diagram (`av/layout.ts`)

Four-stage Sugiyama: rank into columns, insert dummies, order rows (median), assign y. The
component draws the `points` it is handed and owns no geometry.

- Ranking is longest path **after cutting back edges**, constrained by `CATEGORY_ROLE`
  (`input` / `hub` / `output`). Do not "simplify" the cutting away — a howling setup is the normal
  input here, and relaxing over a loop rendered a four-node document ~5000px wide. Tests assert
  `columns <= nodes.length` and, from the browser, the rendered width.
- `nestBoxes` folds an app's height into its host before ranking and `projectToRoots` re-points its
  edges, so the machine is the unit that gets ranked and the app never enters the column stages. Do
  not reintroduce `pinToHosts`, `hostsFirst`, or host pinning in `assignRows`. `routeNested` draws
  the selection up the gutter between the two borders. The cost is that a conferencing app is no
  longer pinned left — it goes where its machine goes.
- `separateLanes` shifts each place's members as a rigid body onto its own band of rows;
  `computeFrames` draws the border, and a place holding only its own air gets none.
- `computeBands` tints runs of columns sharing a role. **Three shapes say three things and must stay
  distinct: tint = role, border = place, box-in-box = machine runs the app.**
- `joinRole` derives `software_conferencing`'s role from its wiring, counting only `cable` and
  `host` edges (`isPortWired`) — every join carries space edges on both faces.
- **Ports are first class.** Anchors come from the model's `ports` order, never from which links
  exist. The SVG carries `data-node-key` / `data-port-key` / `data-port-grip` / `data-link-id`.
- **Small edits move the picture a little.** Every stage is deterministic and `options.order` seeds
  the row ordering with the previous `Layout.order`.
- Edge kinds differ on purpose: `internal` is not drawn (the routing matrix is the honest view),
  `space` collapses to one edge per box pair anchored on the box, `cable` and `host` draw one line
  per link.
- **The alert colour belongs to the linter, and so does which colour.** `alerts` is
  `worstSeverities`' `byEdge` (from `Diagnostic.cycle`, matched on `LayoutEdge.sourceIds`, never
  `id`) and `byLink` (from `Diagnostic.linkIds`, matched on `LayoutEdge.linkId`, so `level-mismatch`
  and the other per-cable rules are drawn too). Worst wins per line. `SEVERITY_STROKE` is
  `LintPanel`'s `SEVERITY_TEXT` in stroke form — a reinforced room's loop is amber in both, and
  `info` is the ordinary cable colour, so an info-only finding leaves the line alone. Being routed
  in the return lane is correct wiring and colouring the lane trains people to ignore red; so does
  painting a finding the dock calls 警告 as though it were 重大.
- **A finding that names only a node is the tree's dots, not the picture** — including critical
  ones like `no-audio-to-stream`. Putting it on a box needs a fourth shape and §10.5 gives three.
  A link the graph rejects (`bad-link-direction`, `link-media-mismatch`) has no edge at all, so it
  is drawn nowhere; both gaps are open on purpose.
- A room's two shapes select the same room, so they must not share an accessible name; only the
  frame's caption strip is clickable.
- **Ranking never follows an edge out of a space.** A room is where signal leaves the cables, so it
  cannot chain one device to the next; that is what keeps two identical devices in one column.
- **A space's column comes from its rank floor, never from its inflow.** `rankByRole` floors every
  space one past the outputs, so the two halves of one place share a column whatever stands in
  them. Ranking a room by what feeds it drew a camera-only space at column 0.
- **The spaces inside one place are ordered by `inPlaceOrder` (`av/places.ts`), never by document
  order** — air, then sight. Which half somebody added first is not something a reader knows, so it
  decides neither the rows (`byLane`'s tie-break), nor the frame caption and the space the tree's
  header edits (both `collectPlaces`, in `av/layout.ts` and `setup-view.ts`). **Places themselves
  stay in document order**: a lane is a room, and the order rooms were written in is the author's.

## E2E (no real OAuth)

`e2e/global-setup.ts` skips the IdP the way wiki's does: apply local migrations, write fixtures into
the miniflare D1 file with `node:sqlite`, and forge a `gdgjp-stream-session` cookie signed with
`RP_SESSION_SECRET` from `.dev.vars`. Needs `.dev.vars` and one prior `pnpm dev`. Storage state
lands in `e2e/storage-state/` (gitignored) and is wired through `use.storageState`, so every spec is
signed in unless it opts out with `test.use({ storageState: { cookies: [], origins: [] } })`.

- Setup **wipes and recreates** everything matching `e2e_%` or named `E2E %`, so specs may create
  rows as long as they name them with `E2E_PREFIX`.
- The suite is fully parallel, so fixtures are split by who mutates them and `e2e/seed-data.ts` is
  the single source of truth. `EVENT` is read-only. A spec that writes gets its own fixture.
- `linter.spec.ts` is the suite that matters: each fixture is a wiring mistake that has actually
  cost an event, driven through the real editor, asserting both that the rule fires and that the
  one-click fix resolves it *without* creating a new problem.
- The panel exposes `data-testid="lint-panel"` and per-finding `data-rule-id` / `data-severity`.
  Keep those when restyling; they are the suite's only stable hook.
- Because the editor is optimistic, an assertion can pass while the write is still in the air. Use
  `saving(page, act)` whenever the effect has to outlive the current page — a serial group, or a
  `page.goto` right after an edit. `dragWire` already does it.
