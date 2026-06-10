# Claude Session Manager — Project Plan

> A desktop app for running and managing multiple Claude Code CLI sessions — each bound to its own
> folder/repo — inside a single window, with a per-session file explorer and instant session switching.

---

## 1. Problem Statement

Working on several projects at once with Claude Code today means several terminal windows, each
running `claude` in a different repo. This gets messy fast:

- It's hard to tell which terminal belongs to which repo.
- Switching projects means hunting for the right window.
- There is no view of the file tree next to the conversation, so checking what Claude changed
  means opening a separate editor or `ls`-ing around.
- When a terminal window is closed by accident, the session context is "lost" (recoverable via
  `claude --resume`, but you have to remember that and find the right session).
- There's no at-a-glance signal of which sessions are *waiting for you* (permission prompt,
  question) versus working versus idle.

## 2. Goal

One window that behaves like a lightweight editor, but whose purpose is **session management**,
not editing:

1. Run **N independent Claude Code CLI sessions**, each in its own working directory (repo).
2. **Preserve 100% of Claude Code CLI functionality** — the app embeds the real CLI in a real
   terminal; it never wraps or re-implements it.
3. Show the **file directory of the active session** beside the terminal, live-updating as
   Claude creates/edits files.
4. **Open files** from the tree — quick built-in viewer for inspection, or hand off to the
   user's editor of choice.
5. Make **switching between sessions instant and obvious** — sessions keep running in the
   background, scrollback intact, with status indicators showing which ones need attention.
6. **Survive restarts** — reopening the app restores the session list and can resume each
   Claude conversation.

### Explicit non-goals

- Not a code editor. File viewing is read-only by default (open-in-editor covers editing).
- Not a Claude API client. We never talk to the Anthropic API directly; the CLI does everything.
- Not a terminal multiplexer replacement (tmux/wezterm) — it's purpose-built for Claude sessions.
- No re-implementation of Claude Code features (no custom permission UI, no custom chat UI).
  The terminal IS the interface; the app is the frame around it.

## 3. Core Design Decision: Real PTYs, Real CLI

The single most important decision: **each session is a genuine pseudo-terminal (ConPTY on
Windows) running the unmodified `claude` binary**, rendered with xterm.js.

Why this matters:

- **Zero feature drift.** Slash commands, permission prompts, vim mode, `!` shell escape,
  image paste, MCP auth flows, `/resume` picker — everything works because it's literally the CLI.
- **Zero maintenance coupling.** When Claude Code ships new features, they appear automatically.
- **Honest behavior.** Ctrl+C, resize, colors, alternate screen — all native terminal semantics.

The app's value-add is everything *around* the terminal: session registry, file tree, status
detection, persistence, and switching UX.

## 4. Technology Choices

| Concern | Choice | Rationale |
|---|---|---|
| Shell/app framework | **Electron** | Mature node-pty + xterm.js integration; the canonical stack for this exact app shape (VS Code, Hyper use it). Tauri considered — smaller binaries, but PTY handling must go through Rust (`portable-pty`) and the ecosystem fit is worse for an MVP. Revisit later if footprint matters. |
| Terminal emulation | **xterm.js** (+ `@xterm/addon-fit`, `webgl`, `search`, `unicode11`) | Industry standard, GPU-accelerated renderer, handles Claude Code's TUI (alternate screen, 256-color/truecolor) correctly. |
| PTY | **node-pty** (ConPTY backend on Windows 11) | Real pseudo-terminal so the CLI behaves exactly as in Windows Terminal. |
| UI framework | **React + TypeScript + Vite** (via `electron-vite`) | Fast iteration; typed IPC contracts. |
| File watching | **chokidar** | Reliable recursive watching on Windows; powers the live file tree. |
| File viewer | **CodeMirror 6** (read-only mode) | Lightweight syntax highlighting; far smaller than Monaco. Monaco is the upgrade path if in-app editing is ever wanted. |
| State persistence | JSON file in app data dir (`sessions.json`) | Simple, debuggable, no DB needed at this scale. |
| Styling | Tailwind CSS + a dark theme matching terminal aesthetics | Quick, consistent. |

## 5. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Electron Main Process                                            │
│                                                                  │
│  SessionManager ── owns one PtySession per session               │
│   ├─ PtySession: node-pty process (claude, cwd=repo)             │
│   │    · stays alive regardless of which session is visible      │
│   │    · ring-buffers output so re-attach replays scrollback     │
│   ├─ StatusDetector: parses PTY stream → idle/working/attention  │
│   ├─ FsService: directory listing + chokidar watchers per session│
│   └─ PersistenceService: sessions.json read/write                │
│                          │ typed IPC (contextBridge)             │
├──────────────────────────────────────────────────────────────────┤
│ Renderer (React)                                                 │
│                                                                  │
│  ┌───────────┬──────────────┬───────────────────────────────┐    │
│  │ Session   │ File         │ Terminal area                 │    │
│  │ sidebar   │ explorer     │  · one xterm.js instance per  │    │
│  │ (list +   │ (active      │    session, kept mounted,     │    │
│  │  status   │  session's   │    hidden when inactive       │    │
│  │  badges)  │  repo tree)  │  · optional file-viewer tab   │    │
│  └───────────┴──────────────┴───────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

Key behaviors:

- **Sessions never die on switch.** The PTY and its xterm instance live for the app's lifetime
  (or until the user closes the session). Switching toggles CSS visibility — instant, no replay
  cost, scrollback and alternate-screen state intact.
- **Status detection is heuristic but useful.** The main process watches each PTY stream for
  signals (spinner output, bell `\x07`, prompt-shaped output, silence) and classifies each
  session as `working / needs-attention / idle / exited`. Badges in the sidebar + optional OS
  notification when a background session needs input.
- **File tree follows Claude.** chokidar events stream to the renderer; the tree updates as
  Claude writes files, with a brief highlight on changed entries so you can *see* what it touched.

Full details in [SPECS.md](./SPECS.md).

## 6. Phased Roadmap

### Phase 0 — Scaffolding (≈ 1 day)
- `electron-vite` project: main / preload / renderer, TypeScript everywhere.
- Typed IPC layer (contextBridge; no `nodeIntegration` in renderer).
- node-pty + xterm.js proof of life: one hardcoded session running `claude` in a fixed folder,
  resize working, colors correct, permission prompt usable.
- **Exit criterion:** Claude Code is fully usable inside the app window — this de-risks the
  entire project before any UI is built.

### Phase 1 — Multi-Session MVP (≈ 3–5 days)
- Session model + `SessionManager` in main process.
- "New session" flow: pick a folder (native dialog) → name auto-derived from folder → PTY spawns
  `claude` in it.
- Session sidebar: list, active highlight, switch on click, close with confirm.
- One persistent xterm instance per session; show/hide on switch; correct refit on activation.
- Keyboard shortcuts: `Ctrl+Tab` cycle, `Ctrl+1..9` jump, `Ctrl+Shift+N` new session.
- **Exit criterion:** 4+ simultaneous Claude sessions on different repos, switching freely,
  no input/output bleed between sessions, scrollback preserved.

### Phase 2 — File Explorer + Viewer (≈ 3–4 days)
- File tree panel for the active session (lazy-loaded directories, ignores `.git`,
  `node_modules` by default but toggleable).
- chokidar wiring: live add/remove/change reflected in the tree; changed-file flash highlight.
- Built-in read-only file viewer (CodeMirror 6): click a file → opens in a viewer tab above/
  beside the terminal; syntax highlighting; images render; binary fallback.
- "Open in editor" (double-click / context menu): launches user-configured editor
  (`code <path>` default), plus "Reveal in Explorer" and "Copy path / relative path".
- **Exit criterion:** while Claude works in a repo, you watch files appear/change in the tree
  and can inspect any file without leaving the app.

### Phase 3 — Persistence, Resume & Status (≈ 3–4 days)
- `sessions.json`: persist session list (name, folder, order, last-active) across restarts.
- On app start: restore session entries; spawn each as `claude --continue` (most recent
  conversation in that folder) — configurable per session: continue / fresh / ask.
- Status detector: `working` (output flowing), `needs-attention` (bell or input-prompt
  heuristics after output stops), `idle`, `exited` (process gone — show re-launch button).
- Sidebar badges + dock/taskbar badge count for sessions needing attention; optional OS
  notification when a *background* session needs input.
- Graceful shutdown: SIGTERM-equivalent to PTYs, flush state.
- **Exit criterion:** quit the app mid-work on 3 repos; relaunch; all 3 sessions are back and
  `--continue`d; a backgrounded session asking for permission visibly flags itself.

### Phase 4 — Polish & Daily-Driver Quality (≈ 1 week, ongoing)
- Split view: two sessions side-by-side (the "watch one repo while prompting another" case).
- Session rename, custom color tags, reorder by drag.
- Settings UI: editor command, default `claude` args per session (e.g. `--model`,
  `--permission-mode`), font size, theme, ignored folders for the tree.
- Terminal search (`Ctrl+F` in terminal via search addon), clickable file paths in terminal
  output (open in viewer), clickable URLs.
- Crash resilience: if a PTY dies unexpectedly, keep the pane with the last output + a
  "Restart (resume)" button.
- Packaging: `electron-builder` → Windows installer + portable exe; auto-update optional.
- **Exit criterion:** you stop using standalone terminals for Claude work.

### Phase 5 — Later / Nice-to-Have (backlog)
- Git awareness: branch name + dirty count in session header; git status coloring in the tree.
- Conversation picker integration: list `~/.claude/projects/<dir>` sessions, choose which to
  resume instead of always `--continue`.
- Diff viewer for files Claude changed (before/after within the session's lifetime).
- Session templates ("new session in repo X with model Y and skill Z").
- Multiple windows / detach a session to its own window.
- Usage/cost surface per session (parse `/cost` or statusline output).
- Tauri port if Electron footprint becomes a pain.

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ConPTY quirks with Claude Code's TUI (alternate screen, resize redraw) | Broken rendering | Phase 0 spike validates exactly this before UI investment; pin tested node-pty/xterm.js versions. |
| Status heuristics misclassify (e.g. "needs attention" never fires) | Reduced trust in badges | Treat as best-effort; always show last-output-time as fallback; iterate on real transcripts. Claude Code emits a bell on permission prompts when `terminal bell` notif channel is on — document the `claude config set --global preferredNotifChannel terminal_bell` setup for reliable detection. |
| Many sessions × WebGL terminals → memory | Sluggish app | Cap renderer addon to WebGL for active terminal only; DOM renderer for hidden ones; scrollback cap (e.g. 10k lines) configurable. |
| chokidar on huge repos (node_modules) | CPU churn | Ignore-list by default, watch depth limits, lazy subtree watching (only expanded dirs + top level). |
| Electron security footguns | XSS → full node access | `contextIsolation: true`, no `nodeIntegration`, strict typed IPC, sanitize all renderer-bound data. |
| Windows file locking / path edge cases (UNC, long paths) | Crashes on some repos | Normalize with `path.win32`, test long-path repos early. |

## 8. Suggested Repo Layout

```
session-manager-ai/
├─ PLAN.md / SPECS.md
├─ package.json
├─ electron.vite.config.ts
├─ src/
│  ├─ main/            # Electron main: SessionManager, PtySession, FsService,
│  │                   # StatusDetector, PersistenceService, ipc handlers
│  ├─ preload/         # contextBridge API (typed)
│  ├─ renderer/        # React app: SessionSidebar, FileExplorer, TerminalHost,
│  │                   # FileViewer, StatusBadge, SettingsDialog
│  └─ shared/          # IPC contract types, Session model types
└─ resources/          # icons
```

## 9. Definition of Done (v1.0)

- [ ] 5+ concurrent Claude sessions across distinct repos, stable for a full workday.
- [ ] Full CLI parity verified: permission prompts, `/resume`, `!` shell, paste, vim mode, resize.
- [ ] File tree live-updates while Claude edits; any file viewable in ≤ 1 click.
- [ ] Session switch < 50 ms perceived; no cross-session input bleed ever.
- [ ] Restart restores all sessions with conversations resumed.
- [ ] Needs-attention badge fires reliably on permission prompts (with terminal-bell config).
- [ ] Windows installer built; app survives sleep/wake and repo deletion gracefully.
