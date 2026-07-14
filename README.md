# pi-hunk

[![npm version](https://img.shields.io/npm/v/@roodriigoooo/pi-hunk.svg)](https://www.npmjs.com/package/@roodriigoooo/pi-hunk)

pi-hunk is a lightweight Hunk orchestrator for Pi with Shiki-highlighted inline diffs and explicit human review checkpoints.

## Workflow

1. Pi makes changes and renders `write` and `edit` results as inline diffs.
2. Run `/hunk review` or press `Ctrl+Shift+H`.
3. Review and comment in full Hunk, then exit.
4. Choose `Submit now`, `Keep for later`, or `Abandon`.
5. After requested changes, wait for Pi to settle, re-review, and submit an empty review to approve.

Hunk owns human review. Pi orchestrates and persists captured snapshots; the model receives only explicitly submitted notes. Approval never starts a model turn.

Freshness covers the complete changeset, not only Pi's wrapped tools. A live Hunk session is authoritative. An owned default Git working-tree review also has a Git fallback that includes untracked files. Unsupported sources, unavailable sessions without an eligible fallback, and failed freshness probes report `unknown` rather than heuristically claiming the review is clean.

## Optional side pane

If Hunk is already open in another terminal, `/hunk review` attaches read-only and returns immediately. Review there, then use `/hunk submit` in Pi; pi-hunk does not try to focus another terminal.

## Install

```bash
pi install npm:@roodriigoooo/pi-hunk
```

Restart Pi or run `/reload`. Hunk CLI is optional unless you use review.

## Commands

- `/hunk status` — checkpoint ID/revision, lifecycle, session, freshness, and journal diagnostics.
- `/hunk review` — attach an existing Hunk session or launch same-terminal Hunk.
- `/hunk submit` — validate freshness and deliver exact submitted human notes.
- `/hunk abandon` — abandon the active checkpoint without a model turn.
- `/hunk configure` — configure renderer and Hunk binary settings.

## Checks

```bash
npm run check
npm pack --dry-run
```

## Project layout

- `src/diff-view.ts` — unified-patch renderer and generic inline annotations.
- `src/review-export.ts` — strict complete-export normalization and stable digests.
- `src/changeset.ts` — tool-independent freshness fingerprints and comparisons.
- `src/git-changeset.ts` — owned Git working-tree fallback adapter.
- `src/checkpoint-store.ts` — immutable checkpoint state machine and journal folding.
- `src/hunk-session-client.ts` — read-only Hunk probe and review client.
- `src/hunk-handoff.ts` — direct child/TUI lifecycle and serial sampling.
- `src/index.ts` — commands, shortcut, persistence, and explicit submission.

## License

MIT
