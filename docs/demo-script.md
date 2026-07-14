# pi-hunk demo script — v0.8.0

Goal: show Shiki diffs and the complete human-controlled Hunk checkpoint loop.

Install Hunk 0.15.3+ and pi-hunk before recording.

## Canonical take — one terminal

Start `pi` in one terminal. Do not start Hunk first.

### Beat 1 — rendered edit

Ask Pi to make a small `edit` or `write` in a committed demo file. Pause on the pi-hunk output: Shiki tokens, word emphasis, line numbers, folded context, gutter, and file header.

### Beat 2 — review

When Pi is idle:

```text
/hunk review
```

Pi temporarily stops its TUI, launches:

```text
hunk diff --watch --no-exclude-untracked
```

Add one or more user notes in Hunk, then exit Hunk. Pi restores its TUI and shows:

```text
Submit now
Keep for later
Abandon
```

Choose `Keep for later` first. Escape has the same effect.

Narration: Hunk owns review interaction. pi-hunk reads only complete
`session review --include-patch --include-notes --json` exports.

### Beat 3 — submit

Run:

```text
/hunk submit
```

Show one visible `hunk-review-submission` follow-up. The model receives the exact submitted note bodies and coordinates, not raw Hunk controls.

After Pi makes the requested changes, wait for the agent to settle. Freshness notices changes made by shell commands, plugins, and untracked-file mutations too. Run `/hunk review` again, add no notes, exit Hunk, choose `Submit now`, or run `/hunk submit` if the review was kept for later. The empty review approves locally and starts no model turn.

### Beat 4 — status and abandon

Show:

```text
/hunk status
/hunk abandon
```

Abandon starts no model turn.

## Optional second take — side pane

In a second terminal, start:

```text
hunk diff --watch --no-exclude-untracked
```

Run `/hunk review` in Pi. pi-hunk attaches to the existing human-owned session, returns without a selector, and advertises `/hunk submit` in Pi. Review in the side pane and submit explicitly from Pi.

## Recording cues

- Show `/hunk review` and `Ctrl+Shift+H` as the two entry points.
- Show the exact `Submit now`, `Keep for later`, `Abandon` choices.
- Show `hunk · reviewing`, `hunk · re-review`, and `hunk · approved` status changes.
- Do not show removed automatic pickup, agent-authored comments, sidecars, or legacy commands.
