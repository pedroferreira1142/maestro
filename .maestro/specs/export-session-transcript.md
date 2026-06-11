# Export Session Transcript

Let users export a terminal's scrollback as a clean plain-text/Markdown artifact, or copy it to the clipboard, from the Ctrl+K command palette and a right-click context menu on terminal tabs. The renderer serializes the live xterm buffer in src/renderer/src/termRegistry.ts (reuse the wrapped-row joining approach of searchBuffer: translateToString over buffer.active with isWrapped continuation handling — buffer cells are already rendered, so output is naturally ANSI-free). A new IPC handler in src/main/ipc.ts opens electron's dialog.showSaveDialog and writes the file; the clipboard variant reuses the existing 'clipboard:write' channel. The Markdown export is prefixed with a metadata header built from SessionConfig (name, folder), the terminal's title, the current git branch via the existing getGitStatus IPC, and the export timestamp. Surfaces: new items in CommandPalette.tsx for the active session's focused terminal, and a small context menu added to TerminalTab in TabStrip.tsx. No changes to PtySession, the PTY byte stream, or StatusDetector.

## Specs

- [ ] Right-clicking a terminal tab in the tab strip opens a context menu with 'Export transcript…' and 'Copy transcript' items; the menu closes on outside click or Escape without side effects.
- [ ] With a session active, the Ctrl+K command palette lists 'Export transcript' and 'Copy transcript' entries (fuzzy-matchable like other items) that act on the session's focused terminal, falling back to its first terminal when a file tab is focused.
- [ ] 'Export transcript…' opens a native save dialog pre-filled with a filename derived from the session name and current date with a .md extension; cancelling the dialog writes nothing and shows no error.
- [ ] The exported Markdown file begins with a metadata header containing the session name, repo folder path, terminal title, current git branch (omitted when the folder is not a git repo), and export timestamp, followed by the transcript in a fenced code block.
- [ ] The exported transcript text contains no ANSI escape sequences, joins soft-wrapped terminal rows into single logical lines, and has trailing blank lines trimmed.
- [ ] 'Copy transcript' places the same cleaned plain transcript text (without the Markdown header/fences) on the system clipboard and shows a brief in-app confirmation instead of a dialog.
- [ ] Export and copy work for every terminal kind (claude and shells) and for a terminal restored after app restart, capturing whatever its current scrollback buffer holds.
- [ ] If writing the export file fails (e.g. permission denied), the user sees an error message naming the problem, and the app keeps running with no other state changed.
