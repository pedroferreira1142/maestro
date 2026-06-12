# Conductor chat: image paste + configurable task-approval card

Upgrade the Conductor (Maestro AI chat) in two ways: (1) allow pasting/drag-dropping images into the chat input and forward them to the headless Claude session so it can analyze screenshots; (2) turn the proposed-action approval card for worktree-task creation into a configurable form with base-branch selector, model selector (Opus/Sonnet/Haiku/inherit), a 'create PR on completion' toggle, and an 'auto-merge into base when done' toggle — all applied to the task that gets created on approval.

## Specs

- [x] Chat input accepts image paste (Ctrl+V from clipboard) and drag-and-drop; show thumbnail previews with a remove button before sending
- [x] Persist pasted images to a temp/session folder and pass their file paths to the headless Claude (HeadlessClaude.ts) so the model can read them as part of the prompt
- [x] Approval card for create_worktree_task/author_feature(implement) renders an options form: base-branch dropdown populated from the repo's real local branches (default: repo default branch)
- [x] Approval card includes a model selector (inherit/Opus/Sonnet/Haiku) that sets the model for the spawned task's Claude session
- [x] Approval card includes a 'Create PR when task completes' toggle that triggers PR creation from the task branch into the base branch
- [x] Approval card includes an 'Auto-merge into base when done' toggle, guarded: skip with a visible warning if the base tree is dirty or the merge conflicts
- [x] Selected card options are passed through to the actual task-creation flow and persisted as per-repo defaults for the next proposal
