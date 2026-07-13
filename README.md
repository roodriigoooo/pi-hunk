# pi-hunk

[![npm version](https://img.shields.io/npm/v/@roodriigoooo/pi-hunk.svg)](https://www.npmjs.com/package/@roodriigoooo/pi-hunk)

Pi extension for Shiki-highlighted terminal diffs and explicit human Hunk review checkpoints.

## Demo

https://github.com/user-attachments/assets/d204fc5e-8716-4fbe-96a5-debeaa589fa5

## Workflow

1. Pi renders `write` and `edit` results as terminal diffs.
2. Run `/hunk review` while Pi is idle.
   - Existing matching Hunk session: pi-hunk attaches to it. Side pane stays human-owned.
   - No session: pi-hunk temporarily stops Pi TUI, launches `hunk diff --watch`, then restores Pi when Hunk exits.
3. Add user notes in Hunk. pi-hunk samples only complete `session review --include-patch --include-notes --json` exports.
4. Run `/hunk submit` while Pi is idle.
   - Notes: one visible `hunk-review-submission` follow-up turn.
   - No notes: checkpoint becomes approved; no model turn.
5. Use `/hunk abandon` to discard active review. No model turn.

Hunk exports become immutable, branch-aware session checkpoints. Agent edits only mark an active review `re_review_due`; next complete Hunk export creates next revision. pi-hunk never creates, edits, removes, clears, reloads, or applies Hunk comments.

## Install

```bash
pi install npm:@roodriigoooo/pi-hunk
```

Restart pi or run `/reload`. Hunk CLI is optional unless using review.

## Commands

- `/hunk status` — checkpoint state, Hunk session state, journal diagnostics.
- `/hunk review` — attach existing matching Hunk side pane or launch `hunk diff --watch`.
- `/hunk submit` — validate final complete export and deliver exact human notes.
- `/hunk abandon` — append abandoned transition and stop sampling.
- `/hunk configure` — renderer and Hunk binary settings.

`/hunk send`, `/hunk on`, `/hunk off`, `/hunk auto`, and `hunk_review_notes` do not exist.

## Checks

```bash
npm run check
```

Checks cover renderer behavior, strict review-export normalization, checkpoint journal transitions and branch rehydration, session/handoff lifecycle, explicit submission, and removed legacy surface.

## Project layout

- `src/diff-view.ts` — unified-patch renderer and generic inline annotations.
- `src/review-export.ts` — strict complete-export normalization and stable digests.
- `src/checkpoint-store.ts` — immutable checkpoint state machine and journal folding.
- `src/hunk-session-client.ts` — read-only Hunk probe, review, navigation client.
- `src/hunk-handoff.ts` — direct child/TUI lifecycle and serial sampling.
- `src/review-coordinator.ts` — existing-session attachment and spawned review coordination.
- `src/index.ts` — commands, persistence wiring, explicit submission.

## License

MIT
