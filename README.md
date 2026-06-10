# Maestro

One window to run and **conduct** multiple Claude Code CLI sessions, each in its own repo, with a
live file explorer per session and git-worktree parallel tasks. See [PLAN.md](./PLAN.md) and
[SPECS.md](./SPECS.md).

Each session embeds the **real, unmodified `claude` CLI** in a real pseudo-terminal (ConPTY on
Windows, forkpty on macOS) — all CLI features (permission prompts, slash commands, `!` shell,
paste, vim mode) work exactly as in a normal terminal. The app adds the frame: session registry,
switching, status badges, file tree, viewer, parallel tasks, and restore-on-restart.

Requires the `claude` CLI on PATH (`npm i -g @anthropic-ai/claude-code`).

## Install

**Windows** — grab either from the [latest release](https://github.com/pedroferreira1142/maestro/releases/latest):

- `Maestro-<version>-portable.exe` — single file, run from anywhere, **no install, no admin rights**
- `Maestro-Setup-<version>.exe` — per-user installer (Start menu + uninstaller, no admin rights)

**macOS** — from the same release page:

- `Maestro-<version>-arm64.dmg` (Apple Silicon) or `Maestro-<version>-x64.dmg` (Intel)
- The app is unsigned: on first launch, right-click the app → **Open** (or
  `xattr -d com.apple.quarantine /Applications/Maestro.app`).

**npx** (any OS with Node 20+; runs from source, slower first start):

```bash
npx github:pedroferreira1142/maestro
```

## Develop

```powershell
npm install
npm run dev        # development with HMR
npm run build      # production bundles into out/
npm run package    # build installers/portables into release/
node bin/maestro.mjs   # run the built app
```

## Use

On macOS, `Cmd` works wherever `Ctrl` is listed (except `Ctrl+Tab`, which stays `Ctrl`).

| Action | How |
|---|---|
| New session | `＋` in the sidebar, or `Ctrl+Shift+N` → pick a repo folder |
| **New parallel task (worktree)** | `⑂` on a session, or `Ctrl+Shift+T` |
| New terminal in session | `＋▾` in the tab strip, or `Ctrl+T` |
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

## Parallel tasks (git worktrees)

While Claude works on task A in a repo, spin off task B **on the same repo** without waiting:

1. Click `⑂` on the session (or `Ctrl+Shift+T`). Name the task — a branch (`claude/<slug>`)
   and a worktree folder (`<repo>.worktrees/<slug>`, sibling of the repo) are created.
2. A linked session appears indented under the parent, running its own `claude` in the
   worktree — optionally pre-typed with your first prompt (you press Enter to send).
3. When the task is done, click **Merge** on the task entry: the branch is merged
   (`--no-ff`) into the base branch. Clean merge → offers to remove the worktree and
   branch. Conflicts → you land in the terminal to resolve them like a normal merge.

Any number of tasks can run side by side; each is isolated in its own working tree.

### Reliable "needs input" detection

Claude Code rings the terminal bell on prompts when configured to:

```powershell
claude config set --global preferredNotifChannel terminal_bell
```

With that set, background sessions flag themselves (badge + OS notification + taskbar flash)
the moment Claude asks for permission or input. Without it, detection falls back to output
heuristics.

## State

Session list, window bounds, and settings persist in `sessions.json` under the app's user-data
dir (`%APPDATA%\maestro` on Windows, `~/Library/Application Support/maestro` on macOS). Terminal
scrollback is not persisted across app restarts — Claude's own `--continue` restores the
conversation.

## Architecture (short)

- **Main process** (`src/main/`): `SessionManager` owns one `PtySession` (node-pty ConPTY
  running `claude`) per session — PTYs live in main, so a renderer reload never kills sessions.
  `StatusDetector` classifies the output stream; `FsService` does bounded chokidar watching
  (root + expanded dirs, ignore-list at watcher level) and path-validated file reads.
- **Preload** (`src/preload/`): typed `window.api` bridge, contextIsolation on.
- **Renderer** (`src/renderer/`): React + zustand. One persistent xterm.js instance per
  session (hidden, never unmounted ⇒ instant switching), lazy file tree with live updates and
  changed-file flashes, CodeMirror 6 read-only viewer with auto language detection.
