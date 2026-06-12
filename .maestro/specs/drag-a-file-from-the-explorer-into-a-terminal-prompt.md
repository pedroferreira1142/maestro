# Drag a file from the explorer into a terminal prompt

Let users drag a file row out of the per-session file explorer (FileExplorer.tsx) and drop it onto any terminal (TerminalHost.tsx) to insert that file's session-relative path into the CLI prompt. Implementation reuses what already exists: file rows in FileExplorer.renderDir already hold `e.relPath` (forward-slash, relative to the session folder); make those file rows `draggable` and, on dragStart, put the relPath on the DataTransfer under a custom MIME type (e.g. `application/x-maestro-path`). In TerminalHost.onDrop, branch before the existing image-attachment logic: if the drop carries that custom type, paste the path (reusing the existing `quotePath` helper + trailing space) into that terminal via `term.paste(...)` and return; otherwise fall through to the current OS-file image-attachment behaviour unchanged. Because the drop lands on a specific TerminalHost instance, it naturally targets the terminal it was dropped on. The explorer stays strictly read-only — only `draggable` and dragStart handlers are added.

## Specs

- [ ] Starting a drag from a file row in the explorer initiates a drag whose DataTransfer carries that file's session-relative path in forward-slash form under a Maestro-specific type (not the OS file list).
- [ ] Dropping a dragged explorer file onto a terminal inserts that file's session-relative path followed by a single trailing space into that terminal's prompt, and does NOT send Enter / submit the prompt.
- [ ] A dragged path that contains whitespace is inserted wrapped in double quotes; a path with no whitespace is inserted bare (matching the existing quotePath behaviour).
- [ ] Dropping an explorer file inserts only text — it creates no image attachment and adds nothing to the session's attachment history.
- [ ] The path is inserted into the exact terminal the file was dropped on, and this works regardless of the terminal's kind (claude or a plain shell).
- [ ] While an explorer file is dragged over a terminal, the terminal shows a drop hint indicating a path will be inserted, visually distinct from the existing "Drop image to attach" hint, and the hint clears on drop or drag-leave.
- [ ] Dropping an OS file from outside the app onto a claude terminal still saves it as an image attachment and pastes its absolute path, exactly as before (the new path-drop branch does not regress OS-file image drops).
- [ ] Existing file-row interactions are preserved: single-click still opens the file, double-click still opens it in the editor, and right-click still opens the context menu — making a row draggable does not break these.
