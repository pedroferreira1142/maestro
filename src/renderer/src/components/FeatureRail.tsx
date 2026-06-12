import { useRef, useState } from 'react'
import type { Feature, FeatureStatus } from '../../../shared/types'
import { useStore } from '../store'

const STATUS_LABEL: Record<FeatureStatus, string> = {
  draft: 'Draft',
  implementing: 'Implementing',
  merged: 'Done'
}

/**
 * Read-only flyout summarising the feature a task session implements: title,
 * status, description and its specs (with their satisfied state). Fixed-
 * positioned to the left of the rail button, mirroring QueuePopover — the rail
 * is narrow, so an absolutely-positioned child would be clipped.
 */
function FeatureFlyout({
  feature,
  anchor,
  onClose
}: {
  feature: Feature
  anchor: DOMRect
  onClose: () => void
}): JSX.Element {
  const openFeatures = useStore((s) => s.openFeatures)

  // Sit to the LEFT of the rail; clamp so a tall card stays on screen.
  const right = Math.round(window.innerWidth - anchor.left + 8)
  const top = Math.min(anchor.top, Math.max(8, window.innerHeight - 420))

  const done = feature.specs.filter((s) => s.done).length

  return (
    <div
      className="feature-flyout-overlay"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div
        className={`feature-flyout status-${feature.status}`}
        style={{ top, right }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="feature-flyout-head">
          <span className="feature-flyout-title" title={feature.title}>
            {feature.title}
          </span>
          <span className={`feature-status status-${feature.status}`}>
            {STATUS_LABEL[feature.status]}
            {feature.auto && ' · auto'}
          </span>
        </div>

        <div className="feature-flyout-desc">
          {feature.description.trim() || <span className="dim">No description.</span>}
        </div>

        <div className="feature-flyout-specs-head">
          Specs{feature.specs.length > 0 && ` · ${done}/${feature.specs.length} satisfied`}
        </div>
        <div className="feature-flyout-specs">
          {feature.specs.length === 0 ? (
            <div className="dim">No specs listed.</div>
          ) : (
            feature.specs.map((spec) => (
              <div className={`feature-flyout-spec${spec.done ? ' done' : ''}`} key={spec.id}>
                <span className="feature-flyout-check">{spec.done ? '☑' : '☐'}</span>
                <span className="feature-flyout-spec-text">{spec.text}</span>
              </div>
            ))
          )}
        </div>

        <div className="feature-flyout-actions">
          <button
            className="btn"
            title="Open the full Features & Specs editor for this repo"
            onClick={() => {
              onClose()
              void openFeatures(feature.sessionId)
            }}
          >
            Edit feature…
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Right-edge vertical icon rail, shown only when the active session is a task
 * session tied to a feature. Its first icon opens a popup with that feature and
 * its specs; more session-context icons can hang off the same rail later.
 */
export function FeatureRail(): JSX.Element | null {
  const feature = useStore((s) => s.linkedFeature)
  const [open, setOpen] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  // Nothing to show for sessions not implementing a feature.
  if (!feature) return null

  return (
    <div className="feature-rail">
      <button
        ref={btnRef}
        className={`feature-rail-btn${open ? ' on' : ''}`}
        title={`Feature: ${feature.title}`}
        onClick={() => setOpen(open ? null : (btnRef.current?.getBoundingClientRect() ?? null))}
      >
        ✦
      </button>
      {open && <FeatureFlyout feature={feature} anchor={open} onClose={() => setOpen(null)} />}
    </div>
  )
}
