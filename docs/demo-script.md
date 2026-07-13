# pi-hunk demo script — explicit review

Goal: show Shiki diffs, then human-controlled Hunk checkpoint submission.

## Layout

Two panes, same repository:

```text
┌───────────────────────┬───────────────────────┐
│ Hunk side pane         │ pi                     │
│ human review           │ agent + pi-hunk        │
└───────────────────────┴───────────────────────┘
```

Install `hunk` 0.15.3+ and pi-hunk. Start `pi` in right pane. Do **not** start Hunk first for first take.

## Beat 1 — rendered edit

Ask Pi to make a small `edit` in a committed demo file. Pause on pi-hunk output: Shiki tokens, word emphasis, line numbers, folded context, gutter, file header.

## Beat 2 — launch review

In Pi, while agent is idle:

```text
/hunk review
```

Pi temporarily leaves its TUI, directly runs `hunk diff --watch`, and restores Pi when Hunk quits. Add several user notes with Hunk’s `c` flow. Quit Hunk with `q`.

Narration: Hunk owns review interaction. pi-hunk only reads complete review exports; it never changes notes.

For second take, first run `hunk diff --watch` in left pane. Then run `/hunk review` in Pi. pi-hunk attaches to existing human-owned side pane instead of launching another Hunk.

## Beat 3 — submit once

Back in Pi:

```text
/hunk submit
```

Show one visible `hunk-review-submission` follow-up. Agent receives checkpoint ID/revision, reviewed ref, patch digest, and exact note bodies; raw patch remains session-only checkpoint data. Agent edits invalidate submitted review to `re_review_due` but do not synthesize a next revision.

Run `/hunk review` again after edits. Add no notes, quit Hunk, then:

```text
/hunk submit
```

Show local approval confirmation and no model turn.

## Optional cleanup

```text
/hunk abandon
```

Show abandoned checkpoint and no model turn.

## Recording cues

- Show only `/hunk status`, `/hunk review`, `/hunk submit`, `/hunk abandon`, `/hunk configure` completions.
- Show attached side-pane reuse in second take.
- Never show `/hunk send`, auto pickup, steering, or `hunk_review_notes`; removed surface.
