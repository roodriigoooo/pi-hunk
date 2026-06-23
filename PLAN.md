# pi-huff — design plan

> Living doc. Captures the premise, what we've agreed, what we're still
> deliberating, and how the two halves of the product integrate. Updated as
> decisions crystallise.

## Premise

pi-huff is one product with two halves that must feel like one:

1. **Diff renderer** — replaces pi's default `write`/`edit` tool UI with
   syntax-highlighted, word-level-emphasised diffs rendered directly in the
   terminal. Theme-aware, configurable, personalisable (not only in regards to theme, but in terms of structure, orientation symbols used for diffs e.g +, *, etc. highlighting style, etc. this implies the existence of a nice UI to configure things, visually, elegantly, in a vanguardist manner). Inspiration: shiki +
   rehype-pretty-code (line highlights, word-level highlights, captions).
2. **Hunk bridge** — lets the human review diffs in a real Hunk TUI window and
   hands *the human's* inline notes back to the agent, elegantly and
   semantic-preserving.

The two halves share one patch model, one render record per tool call, one
theme, one visual language. The rendered diff in pi and the Hunk window in the
second terminal are two views of the same edit; the human is the only author
of review comments; the agent only ever *reads* comments, never *writes* them.

## Context: what's already on disk

- `src/index.ts` (~30 KB) — current implementation.
  - `HuffConfig` + global/project JSON merge, shiki theme selection.
  - Self-rolled `parseUnifiedPatch`, `wordRanges`, per-char emphasis mapped onto
    shiki tokens, compact-unchanged folding, line numbers, stats header,
    hunk captions, gutter bars, and width-cached `DiffComponent`.
  - Re-registers `edit` + `write`, reuses base execute, builds unified patches,
    remembers `RenderRecord` per `toolCallId`.
  - `/huff status|send|auto on|off` plus read-only `huff_review_notes` tool.
  - No sidecars, no `agent-context.json`, no agent-authored Hunk comments.
- `scripts/smoke.mjs` — imports the extension through Pi's Jiti runtime,
  drives synthetic `write` / `edit`, verifies ANSI rendering, Hunk read-only
  parsing, auto review pickup, no sidecars, exact `--type user`, and same-file concurrent writes.
- `README.md` — install, workflow, config, and checks.
- `package.json` — `check` script, `shiki@3`, `diff@8`, peer deps on pi packages,
  package-level `pi.extensions` metadata.
- `~/.pi/agent/settings.json` — includes `/Users/rosastre/.pi/pi-huff/src/index.ts`.
- `npm run check` passes as of 2026-06-23.

## Current assessment

- Core implementation and smoke test are in place.
- Extension is registered in Pi settings.
- Prior blocking bugs are resolved: dead `runHunkJson` line gone, broken
  `/huff comments` surface removed, sidecars removed, `--type user` pinned,
  agent clear/apply/rm paths absent, highlighter rebuilds on configured theme
  changes, smoke exists and passes.
- 2026-06-23 hardening added: unified patch parser ignores terminal empty split
  rows, `write` captures its pre-image inside Pi's file mutation queue, smoke
  no longer depends on one hard-coded Pi install path.
- 2026-06-23 UX pass added: opt-in auto pickup for 2+ Hunk notes, human-only
  note listing (no recent-diff summary line), cohesive self-rendering write
  shell, and quieter default word emphasis (`bold`; `none` supported).
- Future/not done: visual configuration UI, optional side-bg tint, semantic
  color slots beyond Pi defaults, broader fixture coverage against real Hunk
  payload variants, package distribution polish.

## Agreed

### Diff renderer
- shiki for tokenisation, mapped char-by-char onto word-level emphasis ranges.
- `diff` package (`createTwoFilesPatch`, `diffWordsWithSpace`) for patch build +
  word-level diff.
- theme-aware via pi `Theme` (`toolDiffAdded` / `toolDiffRemoved` /
  `toolDiffContext` + `accent` / `dim` / `muted` / `toolTitle`), with shiki
  theme chosen by `diffTheme: auto|dark|light`.
- config: global `~/.pi/agent/huff.json` + project `.pi/huff.json`, deep-merge.
- personalise: shiki themes, `maxRenderedLines`, `contextRadius`, `lineNumbers`,
  `wordHighlights`, `compactUnchanged`, `emphStyle` (future).
- re-register `edit` + `write`, reuse base `execute`, render via `DiffComponent`.

### Hunk bridge — agent is strictly read-only on comments
- Hunk TUI is the **human's** window. The working tree is the only buffer
  between it and the agent; `hunk diff --watch` refreshes natively as the agent
  edits. **No reload plumbing, no sidecar files, no `--agent-context`.**
- **Humans author all comments** (press `c` in the Hunk TUI). Comments are
  inline notes pinned to `(file, oldLine|newLine)` with `summary` + optional
  `rationale`, `--type user`, stored in the live hunk session.
- **Agent never writes, creates, edits, or clears comments.** No
  `comment add`, no `comment apply`, no `comment clear`, no `comment rm` from
  the agent side.
- `hunk skill path` — **not loaded.** That skill teaches the agent to drive
  hunk and author comments; rejected by posture.
- `agent-context.json` sidecars — **removed** from the plan. Prior
  `writePatchSidecars` / `.pi/huff/*.agent-context.json` get deleted.
- `/huff send` — the **extension** (not the agent) spawns
  `hunk session comment list --repo . --type user --json`, parses, builds a
  semantic message (file → line → summary/rationale), delivers to agent via
  `pi.sendUserMessage`.
- `/huff status` — probes `hunk session get --repo .`; diagnostic only
  (linked? how many recent diffs?).
- `/huff auto on|off` — opt-in pre-turn pickup. When enabled, Huff injects
  notes once when at least two user notes exist; duplicate unchanged notes are
  not resent. Default off.

### Registration
- Simplest path: add `~/.pi/pi-huff/src/index.ts` to
  `~/.pi/agent/settings.json` `extensions` array. Hot-reloadable via `/reload`.

## Chosen bridge posture

### Agent access to Hunk

Decision: option (b), an extension-internal read tool. The agent may call
`huff_review_notes`; the extension runs curated read-only
`hunk session comment list --repo . --type user --json`; raw Hunk CLI access and
all write paths stay hidden.

Historical options considered:

**(a) Fully opaque.** Extension only exposes `/huff send` (human-initiated).
Agent never sees hunk, never knows about it. Simplest, safest,
maximally flow-protecting. Cost: agent can't *ask* "did the human review my
last edit yet?" — it only hears the human when the human remembers to send.

**(b) Extension-internal read tool (lean).** Register one LLM-callable tool,
e.g. `huff_review_notes`, that the agent may call on demand. Internally it runs
`hunk session comment list --repo . --type user --json` and returns parsed,
semantic notes (file → line → summary/rationale). **No raw `hunk` CLI exposed
to the model; no write path; no `comment apply`/`clear`/`rm`; no skill.** Found
a live session is a precondition; if none, returns "no live hunk session."
Keeps `/huff send` as the human-initiated path as well — two ways in, both
read-only, both human-gated (you decide whether/when the agent hears you:
explicitly via `/huff send`, or on-demand when the agent itself asks).
This is the elegant middle: opinionated *selective* surface, curated by the
extension, opaque CLI, read-only.

**(c) Hybrid + auto-preface.** Same as (b) but the extension also auto-probes
`--type user` before each agent turn and silently prefacing pending notes onto
the turn. More flow-disruptive; can shadow the human's pacing; risks the agent
acting on half-finished notes. Rejected as a default; accepted as opt-in via `/huff auto on` with a 2+ note
threshold.

**Chosen: (b).** It matches "selectively, opinionatedly design surfaces where
we DO want agents to interact with hunk" without ever crossing into authorship.
The single curated tool is small, named, and auditable; the model never gets
raw CLI power; humans remain sole authors.

### Resolved supporting decisions

- `/huff send` delivery mode — idle → `followUp`, streaming → `steer`.
- Footer hint — minimal single line, only when a live Hunk session is detected;
  includes `/huff send` and `huff_review_notes` when enabled.
- `huff_review_notes` renders its result through the same `DiffComponent` visual
  language, but only lists human-authored notes; no agent summary/rewrite.
- `/huff auto on` is opt-in and picks up 2+ notes before agent turns; `/huff auto off` disables.

## Integration of the two halves (the regrounding)

The prompt's core ask: integrating "this new way of seeing diffs" with
"whatever pi-huff goes on to become." The two halves are not features bolted
together; they share substrate:

- **One patch model.** `parseUnifiedPatch` is the single source of truth for
  both the renderer (hunk lines, word ranges, stats) and the read-only hunk
  bridge (mapping human `comment list` entries back to the right file/line in
  the rendered view).
- **One record per edit.** `RenderRecord` (`tool, filePath, patch, summary`)
  drives the rendered diff and keeps recent context available. Human notes are
  grouped by file and line, but the visible note UI avoids extension-authored
  summaries so the human's words stay primary.
- **One theme.** Accent `✦`, diff-added/removed/context, dim/muted, all
  shared. The footer hint (when shown) uses the same accent + rule as the diff
  header — no second visual language.
- **One set of commands.** Under posture, the surface collapses to
  `status · send · auto on|off` (plus the `huff_review_notes` tool under option b).
  The prior footer hint advertising a `hunk patch … --agent-context` command was
  *wrong* (killed surface) and gets rewritten to match what actually exists.
- **No duplicate "view".** Under (b), `huff_review_notes` reuses the renderer,
  so the agent's read of human notes looks the same as your diff view — same
  captions, same colors, same word-level emphasis. One aesthetic, two readers.

The integration test: if you delete the hunk bridge half, the renderer must
still be beautiful and self-contained. If you delete the renderer half, the
bridge must still deliver semantic notes to the agent. Each half earns its
place; together they share everything shareable.

## Aesthetic pass (shared by both halves)

- hunk caption: `@@ hunk · path:lines` rendered with accent rule, not raw `@@`.
- left gutter bar `▎` for changed lines, coloured by side (add/remove).
- configurable `wordHighlight`: `none|bold|underline|inverse|strike|color`.
  Default `bold`; underline/strike/color only when explicitly requested.
- configurable `lineHighlight`: `none|gutter|bar|tint` for changed-line markers.
- configurable `symbols`: add/remove/context/fold/gutter glyphs.
- configurable `colors`: semantic slots add/remove/context/meta/header/gutter/lineNo,
  each `auto`, a friendly alias, a `theme:` slot, or hex.
- configurable `header`: `box|compact|minimal`.
- configurable `lineNumbers`: `false|true|changed`.
- bordered file header box (path · stats · hunk count) for `box` style.
- side-bg tint derived from diff fg (optional, may stage).
- `/huff configure` TUI: SettingsList + live sample-diff preview, save to `.pi/huff.json`.

## Completed build order

1. **Audit+verify against live Pi** — done via `scripts/smoke.mjs`.
2. **Fix blocking bugs** — done; removed broken/dead Hunk write surfaces and
   sidecars, pinned `--type user`, rebuilt highlighter path, added smoke.
3. **Implement read-only bridge** — done; `/huff status`, `/huff send`, parser,
   recent `RenderRecord` correlation.
4. **`huff_review_notes` tool** — done; LLM-callable, read-only,
   live-session-gated, shared renderer.
5. **Aesthetic pass** — done for captions, gutter bars, `emphStyle`, bordered
   header; optional side-bg tint staged.
6. **Wire into Pi** — done via `~/.pi/agent/settings.json` `extensions`.
7. **Docs** — done in `README.md`.

## Remaining staged work

- Beautiful config UI: **implemented** as `/huff configure` — a SettingsList
  with live sample-diff preview; saves to `.pi/huff.json`. Semantic color slots,
  line-number modes, line/word highlight styles, symbol presets, header styles,
  shiki theme presets, and hunk toggles are all editable with Enter/Space cycle
  + fuzzy search.
- Optional side-background tint derived from diff foreground.
- More Hunk JSON fixtures from real sessions.
- Package distribution polish beyond direct settings-path registration.

## Decision log

| date | decision | status |
| --- | --- | --- |
| 2026-06-22 | agents never author/create/edit hunk comments; read-only | agreed |
| 2026-06-22 | no `agent-context.json` sidecars; no `--agent-context` path | agreed |
| 2026-06-22 | no `hunk skill path`; agent never loads hunk skill | agreed |
| 2026-06-22 | working tree is the only agent→hunk buffer; `--watch` refreshes natively | agreed |
| 2026-06-22 | `/huff send` + `/huff status` are the command surface | agreed |
| 2026-06-22 | global registration via settings `extensions` | agreed |
| 2026-06-22 | option (b) curated `huff_review_notes` read tool | agreed + implemented |
| 2026-06-22 | `/huff send`: idle→followUp, streaming→steer | agreed + implemented |
| 2026-06-22 | footer hint minimal, only when live session detected | agreed + implemented |
| 2026-06-22 | v1 aesthetic scope: captions + gutter + emphStyle + header | agreed + implemented |
| 2026-06-23 | `write` diff pre-image captured inside Pi file mutation queue | implemented |
| 2026-06-23 | smoke must be portable across Pi install roots and assert Hunk flags | implemented |
| 2026-06-23 | `/huff auto on|off` opt-in pickup for 2+ notes | implemented |
| 2026-06-23 | review note UI lists human notes only, no extension summary line | implemented |
| 2026-06-23 | write renderer uses self shell for cohesive look | implemented |
| 2026-06-23 | default word emphasis is `bold`; `none` supported | implemented |
| 2026-06-23 | semantic config slots: colors, symbols, lineHighlight, wordHighlight, header, lineNumbers | implemented |
| 2026-06-23 | `/huff configure` live-preview TUI saves to `.pi/huff.json` | implemented |
| 2026-06-23 | modularize: split `src/index.ts` into config / paths / render-records / diff-view / hunk-bridge / configure / index | implemented |
| 2026-06-23 | DiffView module owns patch model + render; `parseUnifiedPatch` is a direct test seam | implemented |
| 2026-06-23 | ReviewBridge module owns Hunk read path + pickup/dedup; `normalizeHunkComments` is a direct test seam | implemented |
