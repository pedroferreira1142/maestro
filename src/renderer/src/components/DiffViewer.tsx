import { useCallback, useEffect, useRef, useState } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { EditorState, RangeSetBuilder, StateField, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet } from '@codemirror/view'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'
import type { GitFileDiff } from '../../../shared/types'
import { fsBus } from '../fsBus'
import { useStore } from '../store'

interface Props {
  sessionId: string
  /** Repo-root-relative path of the changed file (as listed in the Git panel). */
  relPath: string
}

/** Line class for one unified-diff line; null when it needs no background. */
function diffLineClass(text: string): string | null {
  if (
    text.startsWith('+++') ||
    text.startsWith('---') ||
    text.startsWith('diff --git') ||
    text.startsWith('index ') ||
    text.startsWith('new file') ||
    text.startsWith('deleted file') ||
    text.startsWith('old mode') ||
    text.startsWith('new mode') ||
    text.startsWith('similarity ') ||
    text.startsWith('rename ') ||
    text.startsWith('Binary files ')
  ) {
    return 'cm-diff-meta'
  }
  if (text.startsWith('@@')) return 'cm-diff-hunk'
  if (text.startsWith('+')) return 'cm-diff-added'
  if (text.startsWith('-')) return 'cm-diff-removed'
  return null
}

function buildDiffDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i)
    const cls = diffLineClass(line.text)
    if (cls) builder.add(line.from, line.from, Decoration.line({ class: cls }))
  }
  return builder.finish()
}

/**
 * Whole-line backgrounds for added/removed lines and hunk/meta headers. The
 * Diff language only colors tokens; full-line tinting is what makes a diff
 * scannable, so it's decorated independently of the (optional) highlighter.
 */
const diffDecorations = StateField.define<DecorationSet>({
  create: buildDiffDecorations,
  update: (deco, tr) => (tr.docChanged ? buildDiffDecorations(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f)
})

/**
 * Read-only viewer for the unified diff of one changed file against HEAD
 * (staged + unstaged combined). Reloads when the file changes on disk (the
 * session's fs events) and when git state is refreshed (gitNonce bumps), so
 * the diff tracks Claude's ongoing edits live.
 */
export function DiffViewer({ sessionId, relPath }: Props): JSX.Element {
  const editorParentRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const gitNonce = useStore((s) => s.gitNonce)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      setDiff(await window.api.gitFileDiff(sessionId, relPath))
    } catch (e) {
      setError(String(e))
    }
  }, [sessionId, relPath])

  useEffect(() => {
    void load()
  }, [load, gitNonce])

  // Live-reload while Claude edits. Diff paths are repo-root-relative while fs
  // events are session-folder-relative; they match exactly when the session is
  // the repo root (the normal case), with a suffix check covering subfolders.
  useEffect(() => {
    return fsBus.on(sessionId, (events) => {
      const hit = events.some(
        (e) =>
          e.relPath === relPath ||
          relPath.endsWith(`/${e.relPath}`) ||
          e.relPath.endsWith(`/${relPath}`)
      )
      if (hit) void load()
    })
  }, [sessionId, relPath, load])

  useEffect(() => {
    if (!diff || diff.binary || diff.diff === '') {
      viewRef.current?.destroy()
      viewRef.current = null
      return
    }
    if (!editorParentRef.current) return
    let cancelled = false
    const previousScroll = viewRef.current?.scrollDOM.scrollTop ?? 0
    void (async () => {
      const desc = LanguageDescription.matchFilename(languages, 'changes.diff')
      let lang: Extension = []
      if (desc) {
        try {
          lang = await desc.load()
        } catch {
          // highlighting is optional
        }
      }
      if (cancelled || !editorParentRef.current) return
      viewRef.current?.destroy()
      const view = new EditorView({
        state: EditorState.create({
          doc: diff.diff,
          extensions: [
            basicSetup,
            oneDark,
            lang,
            diffDecorations,
            EditorView.editable.of(false),
            EditorState.readOnly.of(true)
          ]
        }),
        parent: editorParentRef.current
      })
      view.scrollDOM.scrollTop = previousScroll
      viewRef.current = view
    })()
    return () => {
      cancelled = true
    }
  }, [diff])

  useEffect(() => {
    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [])

  return (
    <div className="viewer">
      <div className="viewer-header">
        <span className="viewer-path" title={`Working tree vs HEAD · ${relPath}`}>
          <span className="diff-label">diff</span>
          {relPath}
        </span>
        <div className="viewer-actions">
          <button className="btn" title="Reload the diff" onClick={() => void load()}>
            ⟳ Refresh
          </button>
        </div>
      </div>
      <div className="viewer-body">
        {error && <div className="viewer-msg">Could not load diff: {error}</div>}
        {!error && !diff && <div className="viewer-msg">Loading…</div>}
        {diff?.binary && (
          <div className="viewer-msg">Binary file — no text diff available.</div>
        )}
        {diff && !diff.binary && diff.diff === '' && (
          <div className="viewer-msg">No changes against HEAD.</div>
        )}
        {diff && !diff.binary && diff.diff !== '' && (
          <>
            {diff.truncated && (
              <div className="viewer-banner">
                Large diff — truncated to the first 500&nbsp;KB.
              </div>
            )}
            <div className="viewer-editor" ref={editorParentRef} />
          </>
        )}
      </div>
    </div>
  )
}
