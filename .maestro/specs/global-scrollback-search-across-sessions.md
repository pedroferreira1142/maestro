# Global scrollback search across sessions

A Ctrl+Shift+F palette that searches the live xterm scrollback buffers of every open session at once and lists matches grouped by session. Selecting a match switches to that session and uses the existing per-terminal search addon to highlight and scroll to the hit. Implemented in the renderer by iterating the already-persistent terminal instances in termRegistry and reading their buffer lines — no main-process changes needed.

## Specs

- [x] A Ctrl+Shift+F palette that searches the live xterm scrollback buffers of every open session at once and lists matches grouped by session. Selecting a match switches to that session and uses the existing per-terminal search addon to highlight and scroll to the hit. Implemented in the renderer by iterating the already-persistent terminal instances in termRegistry and reading their buffer lines — no main-process changes needed.
