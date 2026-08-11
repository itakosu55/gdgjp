# stream.gdgs.jp — 実装ノート

`stream/CLAUDE.md` がこの内容そのものだった時点 (2026-08-11) の退避。以降 `stream/CLAUDE.md` は
守るべきルールだけを列挙する短い形に圧縮し、**なぜそうなっているか**はこのファイルが持つ。
`app/lib/av/`・レイアウト・セットアップエディタの意図 (intent) を変更する前に読むこと。

設計そのものは `260805_stream_av_designer.md`。本ファイルはその設計を実装したときに決めたこと、
つまり「この関数がこの形をしている理由」「触ると壊れるもの」の記録で、章番号 (§9.3, §11.6, §12.1
…) はすべて設計書を指す。以下は退避時点の内容をそのまま残したものなので、コードが先に進んだ場合は
コードが正しい。

---

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

`unreachable-device` skips both ends of a host relationship. A machine is used by the apps it
runs, and an app with no device selection is reported as `software-io-unassigned` instead — the
actionable half of the same fact. That rule uses `isPortWired`, not reachability, because a join
sitting in a meeting carries space edges on both faces and always looks reached.

**Three audiences, not one.** `coverageRules` asks whether a sound reaches the stream's PROGRAM,
the meeting and the room, and reports the asymmetry — `source-not-reaching-remote` (warn) and
`source-not-reaching-room` (info). Arriving at the broadcast software's *input* is not being on
the stream, since an input routed to no bus is a dead end; `no-audio-to-stream` still judges on
inputs on purpose, because it is the rule that has to catch a silent stream earliest. Neither
audience rule rises above warn: a hall mic that is not in the hall speakers is correct wiring,
and a critical that correct wiring cannot clear breaks the fix-one-and-re-run loop.

**A source is a jack that hears the room, or a port with no upstream.** `DeviceModelPort.origin`
marks the second kind — a video file, the BGM — and `sourcesOf` in `coverage.ts` is the single
set all three audience questions are asked of. Keeping one set is the point: while sources were
mics only, playing a video made `no-audio-to-stream` call a perfectly audible stream silent, and
"only the remote participants heard nothing" was invisible. An origin is one source *per port*,
not per node, because one OBS holds several and the row is what somebody changes. `paths.ts` is
untouched — `reachableFrom` already takes any vertex set, and the generic search stays free of
domain knowledge. Sources are still limited to `mic`/`camera` category nodes plus origins, so a
USB speakerphone's room-facing jack is not yet counted; that gap arrived with §11 and is not
`origin`'s to close.

`software-io-unassigned` fires on an OBS whose only source is a video, and that is correct: it
has selected none of its host's jacks, so nothing it captures or plays is visible to any other
rule. `dangling-port` stays quiet on origins because it is scoped to endpoint categories.

**Two ports, one source.** `sourceKey` (catalog) and `sourceId` (document) name the pairing, and
`sourceGroups` reads both — a browser source is paired on the day, a meeting's screen share has
been two jacks since §9.7.2. Audio and video are deliberately *not* merged into one port, since
"the picture is on the stream and the sound is not" is the commonest accident there is and a
combined port cannot be half wrong; `partial-source` (warn) is what the name bought. Grouping is
**per direction** — what we send into a meeting and what it sends back are two shares — and a
group of one is dropped, which is why `cam` names a feature and reports nothing: a camera and a
microphone are chosen separately. The rule judges on reaching PROGRAM, not on being wired, so a
row switched off in the matrix counts as off the stream.

**Space coupling belongs to the jack, not the category.** `DeviceModelPort.couples` is
`from_space` / `to_space` / `null`; `CATEGORY_COUPLING` survives only as the default a new
catalog port gets and as the warning policy below, and **the graph never reads it**. What
couples to a room is the transducer, and a transducer is a port — a USB speakerphone is one unit
with both faces, and a laptop is a mic and a speaker plus six jacks that are neither. The
direction is stated rather than derived: a mic's OUT and a speaker's IN both face the room and
point opposite ways (design doc §11.2).

**所在 is a place; the jack picks the space.** `SetupNode.spaceId` still names one Space, and
`spacesForPort` walks `space → placeKeyOf → the place's spaces → the one this port's medium can
reach`. So a camera and a mic in the same hall need one 所在 between them, and which of the
hall's two spaces the form happened to store does not change the graph. A meeting is not a
place (`placeKeyOf` returns `null` for `transport`), so a join resolves to its transport space
directly and no medium ever has two candidates.

**Muting is per jack.** `SetupNode.isolatedPorts` lists the jacks that are off; node-wide
`coupling: "isolated"` stays as the shorthand for all of them, which is what a headset wants.
The per-jack form is not a nicety: a laptop is one node whose built-in mic *and* speaker both
sit on a transport loop, so isolating the node would deafen the presenter to fix a mic, and §4.3
requires the offered fix be the operation people actually perform. `isolationFixes` therefore
names the jacks the cycle enters and leaves a space by, not nodes picked by category. **Add any
new `SetupNode` field to `clean()` in `mutations.ts`** — it rebuilds from a whitelist, so a
field it does not know is dropped on the next unrelated edit.

`mdl_seed_pc` carries `builtin_mic` (in, `from_space`) and `builtin_spk` (out, `to_space`), and
the separate 内蔵マイク / 内蔵スピーカー models are deleted (migration 0006). That took a
laptop from four entries — two of them cables that do not physically exist — down to the two
device selections. `isAecCancellable` got simpler with it: ownership is a fact now, so it checks
that every port on the path belongs to the join or its host instead of matching a six-node
shape.

`space-kind-mismatch` is gone with it — a mic in a place that has only a screen now reaches no
space, which is the same hole as leaving 所在 blank, so `space-unassigned` says it. When that
warning fires is `spaceNeedOf(category)`: `always` for gear that *is* a transducer (mic, speaker,
camera, display), `never` for a join, because a meeting nobody wrote down is a finished document
(§9.3) — the cost being that a two-join loop is only found once someone makes the meeting space —
and `when-wired` for everything else, the default. That last one is §11.6's price: a streaming PC
whose built-in mic nobody selected must not be charged a warning, but the same jack assigned to a
join is §9.1's accident and the missing room is then real.

**A port can be a template, and the setup says how many.** `DeviceModelPort.expandable` marks a
kind of source rather than a jack; `SetupNode.ports` lists the instances (`key`, `template`, an
optional `label`, an optional `sourceId`), and `resolvePorts(model, node)` in `av/ports.ts` is
what turns the two into the ports everything else reads. OBS's mixer has one strip per source and
the sources are chosen on the day, so a single 音声ソース row made the standard hybrid layout
*unwritable*: turning MONITOR on carried the hall mics with the meeting, `stream-monitor-loop`
fired critical, and the fix offered was to take the remote participants out of the room (design
doc §12.1).

`graph.resolveNode` and `setup-view.buildNodeInfo` **both** call `resolvePorts`, and nothing else
may grow its own copy — the editor applies every edit twice (optimistically in the browser, then
on the server), so a second implementation shows up as the picture disagreeing with what was
saved. Downstream code reads `ResolvedNode.ports` / `NodeInfo.ports` and never learns that a port
can have come from a document. Instances stand where their template stood, so the sources read
before the outputs the way the OBS window does.

Instance keys are `<template>:<n>` counting from the highest ever used, so deleting the middle
source leaves a gap: renumbering means rewriting `links` and `routing` in the same breath, and the
document is a single JSON column. `add-node` seeds one instance of each *unpaired* template
(§9.3 — an OBS whose mixer has no rows is not a document anyone wanted); a paired template is one
someone has to ask for. A default route naming a template follows every instance of it, which is
`sourceRoutes` in `mutations.ts`. **`clean()` has to know `ports` too** — same whitelist trap as
`isolatedPorts`.

`sourceKey` (catalog) and `sourceId` (document) name the pair a browser source is: two ports,
because "the video is on the stream but its audio is not" is the commonest accident there is and
one merged port hides it, but one act to add, rename and delete (§12.4). The `partial-source`
rule that reads it is still to come, as is `origin` — the column exists and `resolvePorts`
inherits it, but nothing seeds or reads it yet (§12.5).

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

## Three relationships, and only one of them is a link

**A cable** runs output → input, physically exists, and someone can unplug it. `links` now means
this and nothing else, so `buildLinkEdges` has no exceptions in it.

**A device selection** is `SetupNode.assignments: { port, hostPort }[]` — which input OBS captures
from, which output it monitors on. It is a fact about the app, so it lives on the app.
**The direction is derived and never written down**: from inside a computer a physical output is
a *sink* and a physical input is a *source*, so two jacks that share a direction already say which
end is upstream, and `buildAssignmentEdges` reads that off. While this lived in `links` the
document had to carry the orientation, which meant every writer of one — a person today, the AI
phase later — had to know that this single relationship runs out→out. `isHostAssignment` and
`orientHostAssignment` are gone with it.

**A capture** is one app taking another's window on the machine they share (OBS and the Meet
tab). It touches no jack, so it legitimately bypasses §2.3's patchbay. It stays written as a
link, because it really is out → in, but `buildLinkEdges` gives it `kind: "capture"` when both
ends are software with the same `hostNodeId`. Nothing new is declared for it: two apps on one
host is already in the document, and asking for it again would be a second place to get it wrong.

That third name is what closed §11.8's hole. `cable-bypasses-host` (warn) reports a `cable` with
exactly one end on a hosted app — `ハンドマイク.out → join.mic_in`, a cable that does not exist —
and it could not be written while the legitimate bypass and the mistake were the same document.
A join with no `hostNodeId` is skipped: there is no machine to bypass, and §9.3 says a meeting
nobody wrote down is a finished document. Two apps on *different* machines are still reported.

An out→out link is now plainly `bad-link-direction`, which is right — it is a selection somebody
wrote the old way, and the diagnostic carries a remove fix. There is no document migration: the
app has never been deployed remotely, so fixtures, seeds and local dev are the only documents
that exist. **Add `assignments` to `clean()` in `mutations.ts`** — same whitelist trap as
`isolatedPorts` and `ports`; a deleted source drops its selection the way it drops its cables.

The editor keeps cables and selections in separate tables with separate forms, and the cable form
offers only outputs as a source and only inputs as a destination. It used to be one form whose
hint had to say "out→out is correct between an app and its host PC" — a caveat like that is the
sign of two relationships wearing one name. Because a derived orientation only ever produces
same-face edges, `routeNested` can assume both ends sit on the same side of the machine and route
straight up the gutter. An assignment carries no `linkId`, so the diagram gives it no
`data-link-id` and tests find one by its jack.

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

**`setup-intents.ts` is the single implementation of what an intent means.** `applyIntent(doc,
formData, catalog)` is pure, and both sides run it: the action against the stored document, and
the browser against its own copy while the request is still in the air. It lives outside `av/`
because `FormData` is this editor's detail and `av/` is what the CLI and the OBS extension will
consume. Do not re-derive an intent's effect anywhere else — an optimistic result that came from
a second implementation is a *different* answer from the one being saved, and the disagreement
only shows up on the next reload.

`rename-setup` and `delete-setup` return `elsewhere`: they are columns on the `setups` row, not
edits to the document, so only the server can perform them.

Four regions, not five tabs: `setup-tree.tsx` on the left (所在 → 機械 → アプリ, mirroring the
diagram's box-in-box), the work surface in the middle, `setup-inspector.tsx` on the right, and
the linter as a dock across the middle column only, so neither panel loses its height.
`setup-views.tsx` holds the three faces of the work surface plus the JSON, and
`setup-view.ts` is the view model all three regions read so they never disagree about a name,
a room or which findings point where.

**The tabs are now views of the centre pane** (`?view=diagram|routing|cables|json`), and
selection is `?sel=<nodeId> | space:<spaceId> | setup`. Both live in the URL for the reason
`?tab=` did: forms post to the current URL, so toggling a routing cell must not throw away
what was on screen. This is also what makes one implementation serve every width — the tree,
the inspector and the dock are the same components at 1500px and at 400px, reflowed by two
container queries (`@max-[1000px]`, `@max-[720px]`) and a three-state `auto | open | closed`
flag per panel. `auto` means "follow the width", which is why selecting a tree row can close
the drawer on a phone and do nothing on a desktop with one call.

Every narrow override is written out per state rather than left to source order — a container
query that silently loses to a `group-data-` rule looks exactly like a query that never
matched, and the editor's own history has that bug in it.

**Lint and layout run in the browser.** The loader sends the document and the catalog and
nothing else — no `Layout`, no `Diagnostic[]`. `buildGraph` → `lint` → `layoutGraph` are
`useMemo`s in the component, so they also run during SSR and the first paint is unchanged. The
catalog carries **every** unit in the ledger, not just this event's, because a node pointing at
gear that was left behind has to keep resolving or `device-not-in-event` degrades into
`unknown-reference`.

Every form is a `SetupForm` (a `useFetcher`), and `useOptimisticDoc` replays each pending
submission through `applyIntent`. So toggling a matrix cell re-lays out the diagram and re-runs
the linter on the click — which is the loop the app exists for, and a round trip per cell was
enough to stop people trying combinations. `replace-doc` is deliberately **not** optimistic: the
server is what decides whether pasted text is a document, and applying it locally would reformat
the box someone is still typing in.

Consequences worth knowing:

- `shouldRevalidate` returns false for a query-string-only move, so selecting and switching
  views cost no round trip. A fetcher submission still revalidates, which is what swaps the
  optimistic document for the saved one.
- A refusal from the action lands on `fetcher.data`, not `actionData`, and **`useFetchers()`
  cannot carry it**: the router drops an idle fetcher from that list one render after it
  settles, so a shared reader sees the message flash and vanish. `SetupForm` renders its own
  error under itself instead, which is also where it belongs. The status bar is left with the
  drag (no form to report under) and `actionData` (the no-JavaScript path).
- `layoutGraph` is seeded with the previous `Layout.order`, so one added cable does not
  reshuffle a column under the cursor that drew it.
- Two edits fired inside one round trip still race at the database — the action reads the
  document, applies one intent and writes it whole. That is a property of a single-JSON-column
  schema, not of the fetchers.
- In e2e, an assertion can now pass while the write is still in the air. `saving(page, act)`
  waits for the POST; anything whose effect has to outlive the current page needs it.

**The picture is the wiring surface.** Clicking a box or a place frame drives `?sel=`; selecting
anywhere scrolls the canvas to the box. Dragging jack to jack wires two things, told apart by
geometry alone — across the faces is a cable, along one face is an app picking a device on the
computer under it — which is the same rule `buildAssignmentEdges` uses to derive the direction,
so neither the drag nor the form ever asks which way round it goes. A second drag onto a jack
that already selects a device replaces the selection, because one app input reads from one
device. The diagram stays geometric: `canWire` / `onWire` come from the route, which is the only
place that knows about `hostNodeId`. Valid targets light up during a drag, Escape cancels, and
hit testing is arithmetic against the port anchors rather than `pointerover` on a 3px circle.

A drag is not keyboard-reachable; the cable and assignment forms in 結線表 remain the accessible
path and must stay. Media mismatches are *allowed* by the drag, exactly as the form allows them —
prevention in the UI is not detection, and the linter is the authority.

`apply-fix` posts the serialized `Fix` straight back; `canApplyFix` decides which ones get a
button. Hovering a finding passes its `Diagnostic.cycle` to the diagram as `highlight`, which
fades everything else — the danger colour alone cannot tell two reported cycles apart, because
both wear it.

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

Because the editor is optimistic, a "click then assert" test can pass before the write reaches
D1. Use `saving(page, act)` whenever the effect has to outlive the current page — a serial group
whose next step depends on this one, or a `page.goto` right after an edit, which otherwise aborts
the request in flight. `dragWire` already does it.

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

**A room contains what is in it.** `SetupNode.spaceId` means *where this node is*, and the jacks
that face a space find it from there. `placeKeyOf` (`av/places.ts` — the graph needs it too now)
keys spaces into places by `venueKey ?? id`, so a hall's acoustic and visual spaces are one room
and one frame — the use `venueKey` was reserved for.

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

Two properties the editing surface rests on, and both have tests:

- **Ports are first class.** A cable ends at a jack. Anchors come from the model's `ports` order,
  never from which links exist, so drawing a new cable cannot move anchors already on screen —
  the precondition visual wiring needed. `LayoutEdge` carries `linkId`, and the SVG carries
  `data-node-key` / `data-port-key` / `data-port-grip` / `data-link-id`.
- **Small edits move the picture a little.** Every stage is deterministic, ties break on the
  incoming order, and `options.order` seeds the row ordering with a previous `Layout.order`.
  Plain barycenter/median without that seed reshuffles a column when one link is added. The
  route passes the seed on every re-layout; keep doing so.

Both shapes a room wears — the dashed box for the air in it and the frame around everything
standing in it — select the same room, so they must not share an accessible name. The frame keeps
the plain name; the box says which medium it stands for, as `title` already does for the eye.
Only the frame's caption strip is clickable: a frame spans the whole rig, and a hit area over its
middle would swallow every click meant for the gear inside it.

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

Ranking follows no edge out of a space, and that one rule is what keeps the picture symmetric. A
room feeds every non-input device standing in it, so while space vertices took part in forward
ranking a document chained mic → mixer → pc → meeting → laptop → hall → pc, and which link the
DFS happened to cut decided the columns. Mics were never the problem — the input rank floor had
already pinned them — so the asymmetry surfaced in the hubs instead: `twoJoinsInOneHall` drew 12
columns for 9 boxes, quietly breaking the invariant only two small fixtures asserted. Cutting
every edge that leaves a space takes it to 5, `satelliteRooms` from 8 to 5, and every pair of
identical devices back into one column, with the other five fixtures unchanged.

## 13. Howling is not decided by the cycle

`Space.reinforced` landed as designed. Four things were settled while writing it.

**`update-space` did not exist.** Spaces could only be added and removed; `SpaceInspector` was
read-only apart from its delete button. The new operation merges a patch with `id` and `kind`
excluded, and every key in that patch is guarded by `form.has()` in `applyIntent`. That guard is
load-bearing, not defensive: the merge is `{ ...space, ...patch }`, so a key the form did not send
would arrive as `undefined` and erase the field — and `label` is `min(1)`, so erasing it produces a
document that no longer validates. The checkbox keeps the `reinforcedForm` marker pattern, because
an unchecked box sends nothing and "off" and "not on screen" are otherwise the same request.

**The declaration is not offered to a room that already made it.** `acousticDiagnostic` filters
`declare-reinforced` down to the spaces on the cycle that have *not* declared. On a demoted finding
that list is empty; on a two-room cycle with one room declared it names only the other. Emitting it
unconditionally rendered a dead link under every warn.

**Label editing was left out, and so was the plumbing for it.** The operation accepts any field of
a space, but `applyIntent` reads only `reinforced` off the form — no `label`, `venueKey` or
`meetingKey` branch, because no form sends them and an unused branch here is not free. `add-space`
guards `if (!label)`; an `update-space` branch without that guard would persist `label: ""`, and
nothing on the write path would catch it — `safeParseSetupDoc` runs for the JSON tab alone and
`saveSetupDoc` stringifies what it is handed, so the document would fail validation days later in a
tab nobody connects to the rename.

Renaming is still worth having. It is safe on the model — `placeKeyOf` is `venueKey ?? id` and
never the label, so a rename cannot regroup rooms or move a finding — but it needs that guard, and
it needs an answer for `collectPlaces` taking a place's caption from the *first* space sharing a
`venueKey`: rename the acoustic half of a room and the box may or may not follow. Its own change.
The form renders for `acoustic` spaces only, so a transport space does not get an empty form with a
save button.

**Nothing was added to `fixtures.ts`.** The four new cases build their documents inline in
`lint.test.ts` next to the loop tests they vary, which is what the surrounding tests already do; a
shared fixture would have been read by exactly one test each.

Still open, and named in §13.7: the correct hybrid rig in `hybridMonitorMix()` still reports one
`remote-echo-acoustic` critical that no wiring change clears. `reinforced` deliberately does not
touch it — the flag asserts loop gain below unity in one room, not that echo is inaudible, and echo
is a defect far below oscillation. That wants its own declaration wired through `isAecCancellable`.
