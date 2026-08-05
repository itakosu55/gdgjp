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

1. **Spaces are graph vertices.** `graph.ts` emits implicit edges `speaker → acoustic space → mic`
   and `display → visual space → camera`. Howling, remote echo and the infinite mirror are then
   all one cycle search. Deleting the space vertex silently disables most of the linter.
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
per space and per conferencing app — they overlap heavily; fix one and re-run.
`dangling-port` is scoped to endpoint categories so spare mixer channels stay quiet.

## Data model

Three layers plus the event, all in `migrations/`:

`device_models` (型番カタログ, shared) → `devices` (機材台帳 — one row per physical unit, a single
pool shared by every signed-in user, **not** scoped to a chapter) → `event_devices` (what was
actually brought) → `setups.doc` (the SetupDoc JSON).

`devices.owner_note` is a memo, never an ACL. Keeping the ledger per-unit rather than
per-model-with-quantity is a prerequisite for the future double-booking rule; do not collapse it.

`setups` means *alternatives that are mutually exclusive in time* ("本番" / "リハ"). Simultaneous
tracks are a different axis — see design doc §8 before adding one.

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

`layoutGraph` ranks nodes into columns by longest path **after cutting back edges**. Do not
"simplify" that away: relaxing over a loop adds a column per pass, and since a howling setup is
the normal input here, a four-node document rendered ~5000px wide before it was fixed. The
regression test asserts `columns <= nodes.length`.
