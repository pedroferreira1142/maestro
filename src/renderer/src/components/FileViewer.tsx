import { useCallback, useEffect, useRef, useState } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'
import type { FileContent } from '../../../shared/types'
import { fsBus } from '../fsBus'

interface Props {
  sessionId: string
  relPath: string
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileViewer({ sessionId, relPath }: Props): JSX.Element {
  const editorParentRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [content, setContent] = useState<FileContent | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setError(null)
      setContent(await window.api.readFile(sessionId, relPath))
    } catch (e) {
      setError(String(e))
    }
  }, [sessionId, relPath])

  useEffect(() => {
    void load()
  }, [load])

  // live-reload when the file changes on disk (e.g. Claude edits it)
  useEffect(() => {
    return fsBus.on(sessionId, (events) => {
      if (events.some((e) => e.kind === 'change' && e.relPath === relPath)) void load()
    })
  }, [sessionId, relPath, load])

  useEffect(() => {
    if (!content || content.kind !== 'text' || !editorParentRef.current) return
    let cancelled = false
    const previousScroll = viewRef.current?.scrollDOM.scrollTop ?? 0
    void (async () => {
      const name = relPath.split('/').pop() ?? relPath
      const desc = LanguageDescription.matchFilename(languages, name)
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
          doc: content.content,
          extensions: [
            basicSetup,
            oneDark,
            lang,
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
  }, [content, relPath])

  useEffect(() => {
    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, [])

  return (
    <div className="viewer">
      <div className="viewer-header">
        <span className="viewer-path" title={relPath}>
          {relPath}
        </span>
        <button
          className="btn"
          onClick={() => void window.api.openInEditor(sessionId, relPath)}
        >
          Open in editor
        </button>
      </div>
      <div className="viewer-body">
        {error && <div className="viewer-msg">Could not read file: {error}</div>}
        {!error && !content && <div className="viewer-msg">Loading…</div>}
        {content?.kind === 'text' && (
          <>
            {content.truncated && (
              <div className="viewer-banner">
                Large file — showing first {formatSize(2 * 1024 * 1024)} of{' '}
                {formatSize(content.size)}
              </div>
            )}
            <div className="viewer-editor" ref={editorParentRef} />
          </>
        )}
        {content?.kind === 'image' && (
          <div className="viewer-image">
            <img src={content.dataUrl} alt={relPath} />
          </div>
        )}
        {content?.kind === 'binary' && (
          <div className="viewer-msg">
            Binary file · {formatSize(content.size)} — use “Open in editor” to inspect it.
          </div>
        )}
      </div>
    </div>
  )
}
