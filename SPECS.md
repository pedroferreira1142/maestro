# Claude Session Manager — Specifications

Companion to [PLAN.md](./PLAN.md). This document is the buildable spec: functional requirements,
UI layout, data model, IPC contract, and behavioral edge cases.

---

## 1. Functional Requirements

### 1.1 Session lifecycle

| ID | Requirement |
|----|-------------|
| FR-S1 | The user can create a session by selecting a working directory via a native folder picker. The session name defaults to the folder name and is editable. |
| FR-S2 | Creating a session spawns the `claude` CLI in a ConPTY with `cwd` = the chosen directory, inheriting the user's environment (PATH, etc.). |
| FR-S3 | Per-session launch options: extra CLI args (e.g. `--model`, `--permission-mode plan`), and start mode: `fresh` \| `continue` (= `claude --continue`) \| `ask` (show choice on launch). |
| FR-S4 | Multiple sessions may point at the **same** folder (e.g. two conversations on one repo). They are independent PTYs. |
| FR-S5 | Closing a session prompts for confirmation if its process is alive, then terminates the PTY and removes it from the list. Claude's own persistence means the conversation remains resumable later. |
| FR-S6 | If a session's `claude` process exits (crash, `/exit`, Ctrl+D), the pane is preserved showing the final output, with **Restart fresh** and **Restart with --resume** actions. The session is NOT auto-removed. |
| FR-S7 | Sessions can be renamed, reordered (drag), and assigned a color tag. |
| FR-S8 | The session list, including order, names, folders, colors, and launch options, persists across app restarts (FR-P1). |

### 1.2 Terminal (CLI parity)

| ID | Requirement |
|----|-------------|
| FR-T1 | Each session embeds an unmodified `claude` CLI in a real pseudo-terminal (node-pty, ConPTY backend). The app must not intercept, rewrite, or filter the byte stream between the PTY and xterm.js (status detection observes a copy, never mutates). |
| FR-T2 | All CLI features must work as in Windows Terminal: interactive permission prompts, slash commands, `!` shell prefix, multi-line input, paste (incl. images if the CLI supports it in that terminal), vim keybindings, alternate screen, truecolor, cursor styles. |
| FR-T3 | The terminal resizes correctly: panel resize → `pty.resize(cols, rows)` → CLI redraw. Refit fires when a session becomes visible (hidden terminals can't measure). |
| FR-T4 | Scrollback is preserved per session (default 10,000 lines, configurable) and survives session switching without replay flicker. |
| FR-T5 | Background sessions keep running and receiving output; nothing is paused on switch. |
| FR-T6 | Keyboard input goes **only** to the active session's terminal. Switching sessions must never leak buffered keystrokes to the wrong PTY. |
| FR-T7 | Terminal text search via `Ctrl+F` (xterm search addon). |
| FR-T8 | Absolute/relative file paths and URLs in terminal output are link-detected: click opens the file viewer / browser. Path resolution is relative to the session's cwd. |
| FR-T9 | Copy on select (configurable), `Ctrl+Shift+C`/`Ctrl+Shift+V` always copy/paste; plain `Ctrl+C` passes through to the CLI as SIGINT-equivalent (it must remain "interrupt Claude"). |

### 1.3 File explorer

| ID | Requirement |
|----|-------------|
| FR-F1 | The explorer shows the directory tree of the **active** session's working directory. Switching sessions switches the tree (each session remembers its own expanded state and scroll position). |
| FR-F2 | Directories load lazily on expand. Default ignore list: `.git`, `node_modules`, `dist`, `build`, `.venv`, `__pycache__`, `target` — configurable globally and per session; a toggle shows ignored entries on demand. |
| FR-F3 | The tree live-updates via file watching: files/dirs created, deleted, or renamed by Claude (or anything else) appear/disappear within ~1 s. |
| FR-F4 | A file changed in the last N seconds (default 8) shows a transient highlight, so the user can see what Claude just touched. A small "recently changed" section at the top of the panel lists the last ~10 changed files for quick access. |
| FR-F5 | Single-click a file → open in the built-in viewer. Double-click → open in the configured external editor. Context menu: Open, Open in editor, Reveal in File Explorer, Copy path, Copy relative path. |
| FR-F6 | Only watch what's cheap: top-level + expanded directories (depth-limited), respecting the ignore list. Watchers are torn down for collapsed subtrees. |
| FR-F7 | The explorer is read-only in v1: no create/delete/rename of files from the tree (Claude and the editor do that). |

### 1.4 File viewer

| ID | Requirement |
|----|-------------|
| FR-V1 | Built-in viewer renders text files read-only with syntax highlighting (CodeMirror 6), line numbers, and `Ctrl+F` search. |
| FR-V2 | Images (png/jpg/gif/svg/webp) render as images. Unknown/binary files show a hex-free fallback: file size, type guess, and an "Open in editor" button. Files > 5 MB load truncated with a "load full file" option. |
| FR-V3 | The viewer opens as a tab in a pane adjacent to the terminal (layout §3). Multiple viewer tabs allowed; tabs belong to the session that opened them. |
| FR-V4 | If a viewed file changes on disk, the viewer refreshes (with scroll position kept) and flashes its tab. |
| FR-V5 | "Open in editor" runs the configured command template, default `code "${path}"`, with `${path}`, `${dir}`, `${line}` substitutions. |

### 1.5 Status & notifications

| ID | Requirement |
|----|-------------|
| FR-N1 | Each session shows one of: `working` (spinner ⟳), `needs-attention` (●, accent color), `idle` (○), `exited` (✕). Displayed in the sidebar and the active session header. |
| FR-N2 | Detection inputs, in priority order: (1) BEL `\x07` in the stream → `needs-attention` (the CLI emits bell on prompts when `preferredNotifChannel terminal_bell` is set — the app offers a one-click "enable bell notifications" that runs `claude config set --global preferredNotifChannel terminal_bell`); (2) output flowing within the last 2 s → `working`; (3) output stopped and last screen content matches prompt heuristics (e.g. lines ending in `❯`, `?`, `(y/n)`, "Do you want", "Esc to") → `needs-attention`; (4) otherwise → `idle`. |
| FR-N3 | `needs-attention` on a **background** session triggers: sidebar badge, taskbar overlay/flash, and (configurable, default on) an OS notification "Session ‹name› needs input". Clicking the notification focuses that session. |
| FR-N4 | Status flags clear when the user focuses the session and types. |
| FR-N5 | Heuristics are best-effort: the sidebar also shows "last output: Xs ago" on hover as ground truth. |

### 1.6 Persistence & restore

| ID | Requirement |
|----|-------------|
| FR-P1 | `sessions.json` (in `app.getPath('userData')`) stores: schema version, session array (id, name, folder, color, order, launch args, start mode, expanded-tree state), window bounds, active session id, settings. Written atomically (write temp + rename), debounced. |
| FR-P2 | On launch, sessions are restored in order. Each spawns per its start mode; default for restored sessions is `continue` so conversations pick up where they left off. Sessions whose folder no longer exists are shown in an error state (not silently dropped) with "Relocate folder" / "Remove" actions. |
| FR-P3 | On quit: confirm if any session is `working`; then terminate PTYs gracefully (close stdin, brief grace, then kill), flush `sessions.json`. |
| FR-P4 | Scrollback content is **not** persisted across app restarts in v1 (Claude's own `--continue` restores conversational context; terminal pixels are ephemeral). |

### 1.7 Keyboard shortcuts (global within app)

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+N` | New session (folder picker) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous session (MRU order) |
| `Ctrl+1` … `Ctrl+9` | Jump to session 1–9 |
| `Ctrl+Shift+W` | Close session (confirm) |
| `Ctrl+B` | Toggle file explorer panel |
| `Ctrl+Shift+E` | Focus file explorer |
| `Ctrl+`` ` `` | Focus terminal of active session |
| `Ctrl+F` | Search (terminal or viewer, whichever focused) |
| `Ctrl+,` | Settings |

All shortcuts that collide with terminal semantics must be chosen so they don't shadow anything
Claude Code uses; `Ctrl+C`, `Ctrl+D`, `Ctrl+R`, `Esc`, arrows etc. always pass through to the PTY
when the terminal is focused.

## 2. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | Session switch renders in < 50 ms (no terminal re-serialization; visibility toggle only). |
| NFR-2 | Supports ≥ 10 concurrent sessions; memory target < 150 MB renderer + ~30 MB per session at 10k scrollback. Hidden terminals use the DOM renderer; only the visible one gets WebGL. |
| NFR-3 | Keystroke-to-echo latency indistinguishable from Windows Terminal (< 16 ms added). |
| NFR-4 | Electron security baseline: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for renderer, typed IPC only, no remote content loaded, CSP set. |
| NFR-5 | The PTY byte stream is never logged or sent anywhere; `sessions.json` contains no conversation content. |
| NFR-6 | App is Windows-first (ConPTY); code structured so macOS/Linux support is a build-config matter, not a rewrite (node-pty is cross-platform). |
| NFR-7 | Crash isolation: a renderer crash must not kill PTYs (they live in main); reload re-attaches with ring-buffer replay. |

## 3. UI Specification

### 3.1 Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ☰  Claude Session Manager                                       ─  □  ✕   │
├──────────────┬──────────────────┬──────────────────────────────────────────┤
│ SESSIONS  ＋ │ EXPLORER         │  ⟳ miles-core   C:\repos\miles-core      │
│              │ miles-core       │ ┌───────────────────────────────────────┐│
│ ⟳ miles-core │ ▸ .github        │ │ tab: Terminal │ tab: SofToken.java    ││
│   (active)   │ ▾ src            │ ├───────────────────────────────────────┤│
│ ● mmp-data   │   ▾ main         │ │                                       ││
│ ○ session-mgr│     SofToken.java│ │   [ xterm.js — claude CLI running ]   ││
│ ✕ old-spike  │     Util.java ⚡ │ │                                       ││
│              │ ▸ test           │ │  ❯ Do you want to make this edit?     ││
│              │ package.json     │ │    1. Yes  2. Yes, allow all  3. No   ││
│              │ ──────────────   │ │                                       ││
│              │ RECENT CHANGES   │ │                                       ││
│              │ ⚡ Util.java  12s │ │                                       ││
│              │ ⚡ pom.xml    40s │ └───────────────────────────────────────┘│
├──────────────┴──────────────────┴──────────────────────────────────────────┤
│ status bar: active session · cwd · claude pid · last output 2s ago         │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Column 1 — Session sidebar** (collapsible to icon strip): session entries show status glyph,
  color tag, name, and folder basename; tooltip shows full path + last output time. `＋` opens
  the new-session flow. Context menu: rename, color, restart, close, open folder in Explorer.
- **Column 2 — File explorer** (toggle `Ctrl+B`): tree of the active session's cwd + a
  "recent changes" list. Header shows session name to make the binding obvious.
- **Column 3 — Main area**: tab strip per session. Tab 0 is always the Terminal (not closable);
  further tabs are file viewers. Optional horizontal split: viewer above, terminal below, for
  the "watch the file Claude is editing" workflow.
- **Split view (Phase 4)**: main area can split vertically into two session columns, each with
  its own tab strip; the explorer follows the *focused* split.

### 3.2 Visual design

- Dark theme default, matching terminal background exactly so the terminal doesn't look like a
  box-in-a-box. Light theme later.
- Session color tags appear as a 3 px left border on the sidebar entry and the active header —
  the primary "which repo am I in" affordance.
- Status glyphs: `⟳` animated only when `working` (and only for visible entries — no constant
  animation churn); `●` needs-attention uses the accent color and the entry pulses once.
- Font: terminal uses the user's configured monospace (default Cascadia Mono, falls back to
  Consolas); UI uses system font stack.

## 4. Data Model

```ts
// shared/types.ts

type SessionStatus = 'starting' | 'working' | 'needs-attention' | 'idle' | 'exited' | 'error';
type StartMode = 'fresh' | 'continue' | 'ask';

interface SessionConfig {           // persisted
  id: string;                       // uuid
  name: string;
  folder: string;                   // absolute path
  color: string | null;            // hex tag
  order: number;
  claudeArgs: string[];             // extra CLI args
  startMode: StartMode;             // applied on app launch / restart
  explorer: {
    expandedPaths: string[];
    showIgnored: boolean;
  };
}

interface SessionRuntime {          // main-process only, not persisted
  config: SessionConfig;
  pty: IPty | null;                 // node-pty handle
  pid: number | null;
  status: SessionStatus;
  lastOutputAt: number;             // epoch ms
  ringBuffer: TerminalRingBuffer;   // last ~2 MB of raw output for re-attach
  watcher: FSWatcher | null;        // chokidar
}

interface AppStateFile {            // sessions.json
  schemaVersion: 1;
  sessions: SessionConfig[];
  activeSessionId: string | null;
  window: { x: number; y: number; width: number; height: number; maximized: boolean };
  settings: Settings;
}

interface Settings {
  editorCommand: string;            // 'code "${path}"'
  scrollbackLines: number;          // 10000
  fontFamily: string;
  fontSize: number;
  ignoreGlobs: string[];
  notifyOnAttention: boolean;
  confirmCloseWorking: boolean;
  recentChangeHighlightSecs: number; // 8
}
```

## 5. IPC Contract (preload `contextBridge` API)

All channels are typed in `shared/ipc.ts`; renderer gets a single `window.api` object.

```ts
interface Api {
  // session lifecycle
  createSession(folder: string, opts?: Partial<SessionConfig>): Promise<SessionConfig>;
  closeSession(id: string): Promise<void>;
  restartSession(id: string, mode: 'fresh' | 'resume'): Promise<void>;
  updateSession(id: string, patch: Partial<SessionConfig>): Promise<void>;
  listSessions(): Promise<{ config: SessionConfig; status: SessionStatus; pid: number | null }[]>;
  pickFolder(): Promise<string | null>;            // native dialog (main process)

  // terminal data plane (high-frequency — kept lean)
  ptyWrite(id: string, data: string): void;        // keystrokes → PTY
  ptyResize(id: string, cols: number, rows: number): void;
  onPtyData(id: string, cb: (chunk: Uint8Array) => void): Unsubscribe;
  requestReplay(id: string): Promise<Uint8Array>;  // ring buffer for (re)attach

  // status
  onStatusChange(cb: (id: string, status: SessionStatus) => void): Unsubscribe;

  // filesystem (always validated against the session's folder root in main)
  readDir(id: string, relPath: string): Promise<DirEntry[]>;
  readFile(id: string, relPath: string, opts?: { maxBytes?: number }): Promise<FileContent>;
  watchPath(id: string, relPath: string): Promise<void>;
  unwatchPath(id: string, relPath: string): Promise<void>;
  onFsEvent(cb: (id: string, ev: FsEvent) => void): Unsubscribe;
  openInEditor(id: string, relPath: string): Promise<void>;
  revealInExplorer(id: string, relPath: string): Promise<void>;

  // settings
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<void>;
}
```

Security rules enforced in main-process handlers:

- Every `relPath` is resolved against the session's folder and rejected if it escapes it
  (`path.relative` check) — the renderer can never read arbitrary disk paths.
- `openInEditor` builds the command with proper argument quoting (no shell string interpolation
  of untrusted paths into `cmd.exe`); template substitution is whitelist-based.
- PTY data events are namespaced per session id; the renderer only subscribes to ids it owns.

## 6. Terminal Implementation Details

- **Spawn:** `pty.spawn(claudePath, args, { cwd, cols, rows, useConpty: true, env })`.
  `claudePath` resolved once at startup (`where claude`), overridable in settings. Args =
  session `claudeArgs` + start-mode flag (`--continue` when resuming).
- **Data flow:** PTY `onData` → (a) append to ring buffer, (b) feed StatusDetector, (c) forward
  to renderer if a listener is attached. Hidden sessions still do (a)+(b); the renderer keeps all
  xterm instances mounted so (c) continues too — the ring buffer exists for renderer
  reload/crash re-attach (NFR-7), not for routine switching.
- **Ring buffer:** byte-based circular buffer (default 2 MB/session). Replay after reload:
  `term.reset()` then write buffer. Alternate-screen apps redraw on the resize that follows
  re-attach, which corrects any mid-escape-sequence truncation.
- **Resize:** `fit()` on container resize (ResizeObserver) and on session activation;
  then `ptyResize`. Debounced 50 ms.
- **Exit handling:** PTY `onExit` → status `exited`, keep xterm content, render overlay bar in
  the pane: "claude exited (code N) — [Restart] [Restart --resume] [Close session]".
- **StatusDetector:** per-session state machine, evaluated on data chunks + 2 s tick:
  - bell seen → `needs-attention` (sticky until user input)
  - data in last 2 s → `working`
  - else inspect last non-empty rows of the terminal buffer (via xterm buffer API snapshot sent
    from renderer, or a small ANSI-stripped tail of the ring buffer in main) against prompt
    regexes → `needs-attention` or `idle`.
  - user keystroke (`ptyWrite`) → clears sticky flags, re-evaluates.

## 7. File Watching Strategy

- One chokidar instance per session, rooted at the session folder with:
  `depth: 0` initially; expanding a directory in the tree adds it via `watcher.add(dir)` with
  depth 0 (children only). Collapsing removes it. This bounds watcher cost on monorepos.
- Ignore list applied at the watcher level (`ignored` option) so events for `node_modules` etc.
  are never generated.
- Events are coalesced in main (50 ms window) into `FsEvent { kind: add|unlink|change|addDir|unlinkDir, relPath }`
  batches before IPC, preventing renderer churn during bulk operations (e.g. `npm install`,
  Claude writing many files).
- "Recent changes" list is maintained in main per session (last 10 change/add events with
  timestamps, ignore-list filtered) so it's available immediately on session switch.

## 8. Edge Cases & Error Handling

| Case | Behavior |
|---|---|
| `claude` not found on PATH | First-run check; settings field for explicit path; actionable error dialog with install hint (`npm i -g @anthropic-ai/claude-code`). |
| Session folder deleted/renamed while session runs | Watcher error → banner on session ("folder missing"); terminal keeps running (CLI handles its own cwd errors); explorer shows error state with Relocate. |
| Folder on a network drive / UNC path | Supported; watcher falls back to polling (chokidar `usePolling` auto-detect toggle in settings). |
| Two sessions, same folder | Allowed (FR-S4); explorer instances are independent; `--continue` on both would resume the same conversation — the restore flow warns and offers the session picker for the second one. |
| Very large file clicked in tree | Truncated load with banner (FR-V2). |
| Renderer crash / reload (`Ctrl+R` dev) | PTYs unaffected (main-owned); on reload, renderer re-lists sessions and replays ring buffers. |
| App crash / force kill | PTYs die with the app. Next launch restores sessions with `--continue`, recovering conversations. |
| System sleep/wake | PTYs survive; chokidar watchers re-validated on wake (`powerMonitor` resume event → re-stat expanded dirs). |
| Claude Code auto-updates itself mid-session | No impact on running PTYs; new sessions pick up the new binary. |
| User opens the same file in viewer twice | Focuses the existing tab instead of duplicating. |
| Non-UTF-8 / mixed encoding files | Viewer detects (chardet-lite heuristic), renders best-effort with an encoding badge. |

## 9. Settings (v1 surface)

| Setting | Default |
|---|---|
| Editor command template | `code "${path}"` |
| Claude binary path | auto (`where claude`) |
| Default extra args for new sessions | _empty_ |
| Default start mode for restored sessions | `continue` |
| Scrollback lines | 10,000 |
| Terminal font / size | Cascadia Mono / 14 |
| Ignore globs (explorer & watcher) | `.git, node_modules, dist, build, .venv, __pycache__, target` |
| OS notification on needs-attention | on |
| Confirm close while working | on |
| Recent-change highlight duration | 8 s |
| Theme | dark |

## 10. Testing Strategy

- **Unit (vitest):** StatusDetector state machine against recorded PTY transcripts (fixtures
  captured from real Claude sessions: permission prompt, long tool run, idle, exit); path-escape
  validation for fs IPC; ring buffer correctness.
- **Integration:** spawn a fake CLI (`node fake-claude.js` emitting scripted ANSI incl. bell and
  alternate screen) to test session lifecycle, resize, replay, and status transitions without
  burning API usage.
- **E2E (Playwright for Electron):** create 3 sessions → type into each → switch → assert no
  input bleed; kill a child process → assert exited overlay; restart app → assert restore.
- **Manual checklist per release:** real `claude` parity pass — permission prompt, `/resume`
  picker, `!dir`, paste multi-line, vim mode, `Ctrl+C` interrupt, window resize during TUI.
