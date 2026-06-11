import { useStore } from '../store'

/**
 * Dialog for the custom app background: pick an image, tune how strongly it
 * shows through the UI, or remove it. The image covers the whole app — the
 * terminal goes transparent so it shows behind claude/PowerShell output too.
 */
export function BackgroundDialog(): JSX.Element {
  const close = useStore((s) => s.closeBackgroundDialog)
  const pickBackground = useStore((s) => s.pickBackground)
  const clearBackground = useStore((s) => s.clearBackground)
  const setBackgroundOpacity = useStore((s) => s.setBackgroundOpacity)
  const backgroundDataUrl = useStore((s) => s.backgroundDataUrl)
  const settings = useStore((s) => s.settings)
  const opacity = settings?.backgroundOpacity ?? 0.3

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <h2>Background image</h2>

        <div
          className={`bg-preview${backgroundDataUrl ? '' : ' empty'}`}
          style={
            backgroundDataUrl ? { backgroundImage: `url(${backgroundDataUrl})` } : undefined
          }
          title={backgroundDataUrl ? undefined : 'No background image set'}
        >
          {!backgroundDataUrl && <span>No image set</span>}
        </div>

        <label className="field">
          <span>Visibility — {Math.round(opacity * 100)}%</span>
          <input
            type="range"
            min={5}
            max={100}
            value={Math.round(opacity * 100)}
            disabled={!backgroundDataUrl}
            onChange={(e) => void setBackgroundOpacity(Number(e.target.value) / 100)}
          />
        </label>
        <div className="field-hint">
          The image shows behind the whole app, including the terminal. Lower visibility keeps
          text easier to read.
        </div>

        <div className="modal-actions">
          {backgroundDataUrl && (
            <button
              className="btn"
              style={{ marginRight: 'auto' }}
              onClick={() => void clearBackground()}
            >
              Remove image
            </button>
          )}
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" onClick={() => void pickBackground()}>
            Choose image…
          </button>
        </div>
      </div>
    </div>
  )
}
