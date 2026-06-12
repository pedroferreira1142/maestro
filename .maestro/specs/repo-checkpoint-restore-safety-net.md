# Repo checkpoint & restore (safety net)

A one-click 'Checkpoint' button (in the Git panel and Command Palette) that snapshots the session's working tree before a risky prompt — implemented as a labeled, timestamped git commit on a dedicated maestro-checkpoints ref (or a stash-backed tag) via the existing GitService. A list shows recent checkpoints with their labels; 'Restore' runs a guarded git reset/restore back to that snapshot. All git plumbing (run-git helpers, IPC, preload) already exists from the diff viewer and worktree merge code.

## Specs

- [x] A one-click 'Checkpoint' button (in the Git panel and Command Palette) that snapshots the session's working tree before a risky prompt — implemented as a labeled, timestamped git commit on a dedicated maestro-checkpoints ref (or a stash-backed tag) via the existing GitService. A list shows recent checkpoints with their labels; 'Restore' runs a guarded git reset/restore back to that snapshot. All git plumbing (run-git helpers, IPC, preload) already exists from the diff viewer and worktree merge code.
