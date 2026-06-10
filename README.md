# Claude Session Manager

One window to run and manage multiple Claude Code CLI sessions, each in its own repo, with a
live file explorer per session. See [PLAN.md](./PLAN.md) and [SPECS.md](./SPECS.md).

Each session embeds the **real, unmodified `claude` CLI** in a ConPTY pseudo-terminal — all CLI
features (permission prompts, slash commands, `!` shell, paste, vim mode) work exactly as in a
normal terminal. The app adds the frame: session registry, switching, status badges, file tree,
viewer, and restore-on-restart.

## Run

```powershell
npm install
npm run dev        # development with HMR
npm run build      # production bundles into out/
npx electron .     # run the built app
```

Requires the `claude` CLI on PATH (`npm i -g @anthropic-ai/claude-code`).

## Use

| Action | How |
|---|---|
| New session | `＋` in the sidebar, or `Ctrl+Shift+N` → pick a repo folder |
| Switch session | Click in sidebar, `Ctrl+Tab` / `Ctrl+Shift+Tab`, or `Ctrl+1…9` |
| Close session | ✕ on hover, or `Ctrl+Shift+W` |
| Rename session | Double-click its name |
| Toggle file explorer | `Ctrl+B` |
| View a file | Single-click in the tree (read-only viewer tab) |
| Open in editor | Double-click in the tree (default: VS Code) |
| Context menu | Right-click a file/folder: open, reveal, copy path |
| Terminal search | `Ctrl+F` in the terminal |
| Copy / paste in terminal | `Ctrl+Shift+C` / `Ctrl+Shift+V`, right-click toggles copy/paste, `Ctrl+C` with selection copies |

Sessions keep running in the background when not visible; scrollback is preserved. Status
glyphs in the sidebar: `⟳` working · `●` needs your input · `○` idle · `✕` exited (with
restart-resume buttons in the pane).

On app restart, all sessions are restored and conversations resumed via `claude --continue`.

### Reliable "needs input" detection

Claude Code rings the terminal bell on prompts when configured to:

```powershell
claude config set --global preferredNotifChannel terminal_bell
```

With that set, background sessions flag themselves (badge + OS notification + taskbar flash)
the moment Claude asks for permission or input. Without it, detection falls back to output
heuristics.

## State

Session list, window bounds, and settings persist in
`%APPDATA%\claude-session-manager\sessions.json`. Terminal scrollback is not persisted across
app restarts — Claude's own `--continue` restores the conversation.

## Architecture (short)

- **Main process** (`src/main/`): `SessionManager` owns one `PtySession` (node-pty ConPTY
  running `claude`) per session — PTYs live in main, so a renderer reload never kills sessions.
  `StatusDetector` classifies the output stream; `FsService` does bounded chokidar watching
  (root + expanded dirs, ignore-list at watcher level) and path-validated file reads.
- **Preload** (`src/preload/`): typed `window.api` bridge, contextIsolation on.
- **Renderer** (`src/renderer/`): React + zustand. One persistent xterm.js instance per
  session (hidden, never unmounted ⇒ instant switching), lazy file tree with live updates and
  changed-file flashes, CodeMirror 6 read-only viewer with auto language detection.
