import { useEffect, useMemo, useState } from 'react'
import type {
  FactoryArtifact,
  FactoryArtifactKind,
  FactoryCandidate,
  FactoryRun
} from '../../../shared/types'
import { useStore } from '../store'
import { FactoryGraph } from './FactoryGraph'

const KIND_LABEL: Record<FactoryCandidate['kind'], string> = { skill: 'skill', agent: 'agent' }

const RUN_STATUS_LABEL: Record<FactoryRun['status'], string> = {
  running: 'running',
  done: 'done',
  error: 'failed',
  cancelled: 'cancelled'
}

type FactoryTab = 'scans' | 'registry' | 'backlog' | 'lessons' | 'graph'

function timeAgo(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function duration(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 90) return `${s}s`
  return `${Math.round(s / 60)}m`
}

/** One proposed/authored candidate with approve/reject/retry controls. */
function CandidateCard({ runId, candidate }: { runId: string; candidate: FactoryCandidate }): JSX.Element {
  const approve = useStore((s) => s.approveFactoryCandidate)
  const reject = useStore((s) => s.rejectFactoryCandidate)
  return (
    <div className={`factory-candidate kind-${candidate.kind} status-${candidate.status}`}>
      <div className="factory-candidate-head">
        <span className={`kind-chip kind-${candidate.kind}`}>{KIND_LABEL[candidate.kind]}</span>
        <span className="factory-candidate-name">{candidate.name}</span>
        {candidate.existing && (
          <span className="factory-enrich" title={`Enriches ${candidate.existing}`}>
            enrich → {candidate.existing}
          </span>
        )}
        {candidate.status !== 'proposed' && (
          <span className={`factory-cand-status status-${candidate.status}`}>
            {candidate.status === 'authoring' ? '⟳ authoring…' : candidate.status}
          </span>
        )}
      </div>
      <div className="factory-candidate-desc">{candidate.description}</div>
      {candidate.topics.length > 0 && (
        <div className="factory-tags">
          {candidate.topics.map((t) => (
            <span key={t} className="factory-tag">
              {t}
            </span>
          ))}
        </div>
      )}
      {candidate.rationale && <div className="factory-rationale">{candidate.rationale}</div>}
      {candidate.result && (
        <div className={`factory-candidate-result status-${candidate.status}`}>{candidate.result}</div>
      )}
      {candidate.status === 'proposed' && (
        <div className="factory-candidate-buttons">
          <button className="btn primary" onClick={() => void approve(runId, candidate.id)}>
            Approve & build
          </button>
          <button className="btn ghost" onClick={() => void reject(runId, candidate.id)}>
            Reject
          </button>
        </div>
      )}
      {candidate.status === 'error' && (
        <div className="factory-candidate-buttons">
          <button className="btn" onClick={() => void approve(runId, candidate.id)}>
            Retry build
          </button>
          <button className="btn ghost" onClick={() => void reject(runId, candidate.id)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

function RunView({ run, defaultOpen }: { run: FactoryRun; defaultOpen: boolean }): JSX.Element {
  const approveAll = useStore((s) => s.approveAllFactoryCandidates)
  const cancel = useStore((s) => s.cancelFactoryRun)
  const proposed = run.candidates.filter((c) => c.status === 'proposed')
  const [open, setOpen] = useState(defaultOpen || proposed.length > 0)
  // Ticks once a second while running so the elapsed counter stays live.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (run.status !== 'running') return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [run.status])

  const phaseLabel =
    run.phase === 'discovering' ? 'Exploring the source…' : 'Proposing candidates…'
  const built = run.candidates.filter((c) => c.status === 'active').length

  return (
    <div className={`factory-run status-${run.status}`}>
      <div className="factory-run-head" onClick={() => setOpen((o) => !o)}>
        <span className="factory-run-toggle">{open ? '▾' : '▸'}</span>
        <span className="factory-run-source">{run.sourceLabel}</span>
        {run.guidance && (
          <span className="factory-run-guidance" title={run.guidance}>
            “{run.guidance}”
          </span>
        )}
        <span className="factory-run-meta">
          {run.status === 'running'
            ? `⟳ ${phaseLabel} ${duration(run.startedAt, Date.now())}`
            : `${timeAgo(run.startedAt)}${run.finishedAt ? ` · ${duration(run.startedAt, run.finishedAt)}` : ''}`}
        </span>
        <span className={`factory-run-status status-${run.status}`}>
          {RUN_STATUS_LABEL[run.status]}
          {run.status !== 'running' &&
            run.candidates.length > 0 &&
            ` · ${built}/${run.candidates.length} built`}
        </span>
        {run.status === 'running' && (
          <button
            className="btn ghost"
            title="Cancel this scan"
            onClick={(e) => {
              e.stopPropagation()
              void cancel()
            }}
          >
            Cancel
          </button>
        )}
      </div>
      {open && (
        <>
          {run.summary && <div className="factory-run-summary">{run.summary}</div>}
          {proposed.length > 1 && (
            <button className="btn" onClick={() => void approveAll(run.id)}>
              Approve & build all ({proposed.length})
            </button>
          )}
          <div className="factory-candidates">
            {run.candidates.map((c) => (
              <CandidateCard key={c.id} runId={run.id} candidate={c} />
            ))}
            {run.status === 'done' && run.candidates.length === 0 && (
              <div className="factory-empty-row">No candidates proposed.</div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** One registry row; click opens the detail panel. */
function ArtifactRow({
  artifact,
  selected,
  missing,
  onSelect
}: {
  artifact: FactoryArtifact
  selected: boolean
  missing: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <div
      className={`factory-artifact kind-${artifact.kind}${selected ? ' selected' : ''}`}
      onClick={onSelect}
    >
      <span className={`kind-chip kind-${artifact.kind}`}>{KIND_LABEL[artifact.kind]}</span>
      <div className="factory-artifact-main">
        <div className="factory-artifact-name">
          {artifact.name}
          {artifact.adopted && (
            <span className="factory-badge adopted" title="Adopted pre-existing artifact — its file is never deleted by the factory">
              adopted
            </span>
          )}
          {missing && (
            <span className="factory-badge missing" title={`File not found:\n${artifact.filePath}`}>
              file missing
            </span>
          )}
        </div>
        <div className="factory-artifact-desc">{artifact.description}</div>
      </div>
      <span className="factory-artifact-age" title={new Date(artifact.updatedAt).toLocaleString()}>
        {timeAgo(artifact.updatedAt)}
      </span>
    </div>
  )
}

/** Right-hand detail panel: metadata + the artifact's file content. */
function ArtifactDetail({
  artifact,
  missing,
  onOpenRelated,
  onClose
}: {
  artifact: FactoryArtifact
  missing: boolean
  onOpenRelated: (name: string) => void
  onClose: () => void
}): JSX.Element {
  const del = useStore((s) => s.deleteFactoryArtifact)
  const unregister = useStore((s) => s.unregisterFactoryArtifact)
  const showNotice = useStore((s) => s.showNotice)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setContent(null)
    window.api
      .readFactoryArtifact(artifact.id)
      .then((c) => {
        if (!cancelled) setContent(c)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [artifact.id, artifact.updatedAt])

  return (
    <div className="factory-detail">
      <div className="factory-detail-head">
        <span className={`kind-chip kind-${artifact.kind}`}>{KIND_LABEL[artifact.kind]}</span>
        <span className="factory-detail-name">{artifact.name}</span>
        <button className="btn ghost factory-detail-close" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="factory-detail-desc">{artifact.description}</div>
      <div className="factory-detail-meta">
        <span title="MCP source it was grounded on">source: {artifact.source}</span>
        <span title={new Date(artifact.createdAt).toLocaleString()}>created {timeAgo(artifact.createdAt)}</span>
        <span title={new Date(artifact.updatedAt).toLocaleString()}>updated {timeAgo(artifact.updatedAt)}</span>
      </div>
      {artifact.topics.length > 0 && (
        <div className="factory-tags">
          {artifact.topics.map((t) => (
            <span key={t} className="factory-tag">
              {t}
            </span>
          ))}
        </div>
      )}
      {artifact.relatedArtifacts.length > 0 && (
        <div className="factory-detail-related">
          related:
          {artifact.relatedArtifacts.map((r) => (
            <button key={r} className="factory-related-link" onClick={() => onOpenRelated(r)}>
              {r}
            </button>
          ))}
        </div>
      )}
      <div className="factory-detail-actions">
        <button
          className="btn ghost"
          title={`Copy path:\n${artifact.filePath}`}
          onClick={() => {
            window.api.clipboardWrite(artifact.filePath)
            showNotice('Path copied')
          }}
        >
          ⧉ Copy path
        </button>
        <button
          className="btn ghost"
          disabled={missing}
          title="Reveal the file in the file manager"
          onClick={() => void window.api.revealFactoryArtifact(artifact.id)}
        >
          📂 Reveal
        </button>
        {artifact.adopted ? (
          <button
            className="btn ghost danger"
            title="Remove from the registry (the file is kept)"
            onClick={() => void unregister(artifact.id)}
          >
            ✕ Unregister
          </button>
        ) : (
          <button
            className="btn ghost danger"
            title="Delete the artifact and its file"
            onClick={() => void del(artifact.id)}
          >
            ✕ Delete
          </button>
        )}
      </div>
      <div className="factory-detail-file">
        {loading ? (
          <div className="factory-empty-row">Loading…</div>
        ) : content === null ? (
          <div className="factory-empty-row">
            The file could not be read{missing ? ' — it no longer exists on disk.' : '.'}
          </div>
        ) : (
          <pre>{content}</pre>
        )}
      </div>
    </div>
  )
}

/**
 * The Agent & Skill Factory surface: mine a connected MCP source for reusable
 * Claude skills and sub-agents (propose→confirm), browse/audit the generated
 * registry, manage the topics-to-pursue backlog and lessons learned, and see
 * the artifact connection graph. State lives in the store; main pushes changes
 * via onFactoryChanged / onFactoryRuns.
 */
export function FactoryPane(): JSX.Element {
  const sources = useStore((s) => s.factorySources)
  const sourcesLoading = useStore((s) => s.factorySourcesLoading)
  const runs = useStore((s) => s.factoryRuns)
  const state = useStore((s) => s.factoryState)
  const audit = useStore((s) => s.factoryAudit)
  const loadSources = useStore((s) => s.loadFactorySources)
  const scan = useStore((s) => s.scanFactory)
  const clearRuns = useStore((s) => s.clearFactoryRuns)
  const promoteTopic = useStore((s) => s.promoteFactoryTopic)
  const dismissTopic = useStore((s) => s.dismissFactoryTopic)
  const addLesson = useStore((s) => s.addFactoryLesson)
  const deleteLesson = useStore((s) => s.deleteFactoryLesson)
  const adopt = useStore((s) => s.adoptFactoryArtifact)

  const [tab, setTab] = useState<FactoryTab>('scans')
  const [serverKey, setServerKey] = useState('')
  const [guidance, setGuidance] = useState('')
  const [lessonText, setLessonText] = useState('')
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<'all' | FactoryArtifactKind>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showUnregistered, setShowUnregistered] = useState(false)

  // Default the source picker to the first discovered source.
  useEffect(() => {
    if (!serverKey && sources.length > 0) setServerKey(sources[0].server)
  }, [sources, serverKey])

  const busy = useMemo(
    () => runs.some((r) => r.status === 'running' || r.candidates.some((c) => c.status === 'authoring')),
    [runs]
  )
  const openTopics = state.topics.filter((t) => t.status === 'open')
  const missingIds = useMemo(() => new Set(audit?.missingFileIds ?? []), [audit])
  const unregistered = audit?.unregistered ?? []
  const finishedRuns = runs.filter((r) => r.status !== 'running').length

  const filteredArtifacts = useMemo(() => {
    const q = search.trim().toLowerCase()
    return state.artifacts
      .filter((a) => kindFilter === 'all' || a.kind === kindFilter)
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          a.topics.some((t) => t.toLowerCase().includes(q)) ||
          a.keywords.some((k) => k.toLowerCase().includes(q))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [state.artifacts, search, kindFilter])

  const selected = state.artifacts.find((a) => a.id === selectedId) ?? null
  const skillCount = state.artifacts.filter((a) => a.kind === 'skill').length
  const agentCount = state.artifacts.length - skillCount
  const proposedCount = runs.reduce(
    (n, r) => n + r.candidates.filter((c) => c.status === 'proposed').length,
    0
  )

  const doScan = (): void => {
    if (!serverKey || busy) return
    void scan(serverKey, guidance)
    setGuidance('')
  }

  /** Open an artifact (by name) in the Registry tab — used by graph & related links. */
  const openArtifact = (name: string): void => {
    const artifact = state.artifacts.find((a) => a.name === name)
    if (!artifact) return
    setTab('registry')
    setSearch('')
    setKindFilter('all')
    setSelectedId(artifact.id)
  }

  const tabs: { key: FactoryTab; label: string; badge?: string; alert?: boolean }[] = [
    {
      key: 'scans',
      label: 'Scans',
      badge: busy ? '⟳' : proposedCount > 0 ? String(proposedCount) : undefined,
      alert: proposedCount > 0
    },
    {
      key: 'registry',
      label: 'Registry',
      badge: String(state.artifacts.length),
      alert: missingIds.size > 0
    },
    { key: 'backlog', label: 'Backlog', badge: openTopics.length ? String(openTopics.length) : undefined },
    { key: 'lessons', label: 'Lessons', badge: state.lessons.length ? String(state.lessons.length) : undefined },
    { key: 'graph', label: 'Graph' }
  ]

  return (
    <div className="factory-pane">
      <div className="factory-header">
        <div className="factory-title">⚒ Agent &amp; Skill Factory</div>
        <div className="factory-tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`factory-tab${tab === t.key ? ' active' : ''}${t.alert ? ' alert' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.badge && <span className="factory-tab-badge">{t.badge}</span>}
            </button>
          ))}
        </div>
        <button
          className="btn ghost"
          title="Re-discover connected MCP sources"
          disabled={sourcesLoading}
          onClick={() => void loadSources(true)}
        >
          {sourcesLoading ? '⟳ Discovering…' : '⟳ Sources'}
        </button>
      </div>

      {tab === 'scans' && (
        <>
          <div className="factory-scanbar">
            <select
              className="factory-source-select"
              value={serverKey}
              disabled={sources.length === 0}
              onChange={(e) => setServerKey(e.target.value)}
            >
              {sources.length === 0 && <option value="">No MCP sources found</option>}
              {sources.map((s) => (
                <option key={s.server} value={s.server}>
                  {s.label}
                </option>
              ))}
            </select>
            <input
              className="factory-guidance"
              placeholder="Optional: steer the scan (e.g. “Confluence space MILES; focus on billing”)"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doScan()
              }}
            />
            <button className="btn primary" disabled={!serverKey || busy} onClick={doScan}>
              {busy ? 'Working…' : 'Scan'}
            </button>
          </div>
          <div className="factory-body">
            {sources.length === 0 && !sourcesLoading && (
              <div className="factory-note">
                No connected MCP sources were found. Connect an integration (e.g. Atlassian, GitHub)
                in Claude Code, then click “⟳ Sources”.
              </div>
            )}
            {runs.length === 0 ? (
              <div className="factory-empty-state">
                <div className="factory-empty-icon">⚒</div>
                <div className="factory-empty-title">Mine a source for skills &amp; agents</div>
                <div className="factory-empty-text">
                  Pick a connected MCP source above and scan it. The factory explores what's there,
                  proposes skills and sub-agents grounded in real content, and builds the ones you
                  approve into <code>~/.claude</code>.
                </div>
              </div>
            ) : (
              <section className="factory-section">
                <div className="factory-section-head">
                  <h3>Scans</h3>
                  {finishedRuns > 0 && (
                    <button
                      className="btn ghost"
                      title="Remove finished runs from the history"
                      onClick={() => void clearRuns()}
                    >
                      Clear finished
                    </button>
                  )}
                </div>
                {runs.map((r, i) => (
                  <RunView key={r.id} run={r} defaultOpen={i === 0} />
                ))}
              </section>
            )}
          </div>
        </>
      )}

      {tab === 'registry' && (
        <div className="factory-registry">
          <div className="factory-registry-toolbar">
            <input
              className="factory-search"
              placeholder="Search name, description, topics…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="factory-filter-chips">
              <button
                className={`factory-chip${kindFilter === 'all' ? ' on' : ''}`}
                onClick={() => setKindFilter('all')}
              >
                all {state.artifacts.length}
              </button>
              <button
                className={`factory-chip kind-skill${kindFilter === 'skill' ? ' on' : ''}`}
                onClick={() => setKindFilter('skill')}
              >
                skills {skillCount}
              </button>
              <button
                className={`factory-chip kind-agent${kindFilter === 'agent' ? ' on' : ''}`}
                onClick={() => setKindFilter('agent')}
              >
                agents {agentCount}
              </button>
            </div>
          </div>

          <div className="factory-registry-body">
            <div className="factory-registry-list">
              {missingIds.size > 0 && (
                <div className="factory-drift-banner">
                  ⚠ {missingIds.size} registry {missingIds.size === 1 ? 'entry has' : 'entries have'} a
                  missing file — open {missingIds.size === 1 ? 'it' : 'them'} to remove or rebuild.
                </div>
              )}
              {state.artifacts.length === 0 ? (
                <div className="factory-empty-state">
                  <div className="factory-empty-icon">▤</div>
                  <div className="factory-empty-title">The registry is empty</div>
                  <div className="factory-empty-text">
                    Approved candidates land here. Scan a source, or adopt artifacts already
                    installed on disk below.
                  </div>
                </div>
              ) : filteredArtifacts.length === 0 ? (
                <div className="factory-empty-row">No artifacts match the current filter.</div>
              ) : (
                filteredArtifacts.map((a) => (
                  <ArtifactRow
                    key={a.id}
                    artifact={a}
                    selected={a.id === selectedId}
                    missing={missingIds.has(a.id)}
                    onSelect={() => setSelectedId(a.id === selectedId ? null : a.id)}
                  />
                ))
              )}

              {unregistered.length > 0 && (
                <div className="factory-unregistered">
                  <button
                    className="factory-unregistered-toggle"
                    onClick={() => setShowUnregistered((v) => !v)}
                  >
                    {showUnregistered ? '▾' : '▸'} On disk, not in the registry ({unregistered.length})
                  </button>
                  {showUnregistered && (
                    <div className="factory-unregistered-list">
                      {unregistered.map((u) => (
                        <div key={`${u.kind}:${u.name}`} className="factory-artifact unregistered">
                          <span className={`kind-chip kind-${u.kind}`}>{KIND_LABEL[u.kind]}</span>
                          <div className="factory-artifact-main">
                            <div className="factory-artifact-name">{u.name}</div>
                            <div className="factory-artifact-desc">{u.description}</div>
                          </div>
                          <button
                            className="btn ghost"
                            title="Track this pre-existing artifact in the registry (its file is left as-is)"
                            onClick={() => void adopt(u.kind, u.name)}
                          >
                            Adopt
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {selected && (
              <ArtifactDetail
                artifact={selected}
                missing={missingIds.has(selected.id)}
                onOpenRelated={openArtifact}
                onClose={() => setSelectedId(null)}
              />
            )}
          </div>
        </div>
      )}

      {tab === 'backlog' && (
        <div className="factory-body">
          <section className="factory-section">
            <h3>Topics to pursue ({openTopics.length})</h3>
            {openTopics.length === 0 ? (
              <div className="factory-empty-state">
                <div className="factory-empty-icon">☰</div>
                <div className="factory-empty-title">No parked topics</div>
                <div className="factory-empty-text">
                  While scanning, the factory parks adjacent topics worth their own artifact here —
                  the self-extending backlog.
                </div>
              </div>
            ) : (
              openTopics.map((t) => (
                <div key={t.id} className="factory-topic">
                  <div className="factory-topic-main">
                    <div className="factory-topic-title">{t.title}</div>
                    {t.note && <div className="factory-topic-note">{t.note}</div>}
                    <div className="factory-topic-meta">
                      from {t.source} · {timeAgo(t.addedAt)}
                    </div>
                  </div>
                  <button
                    className="btn"
                    disabled={busy}
                    title="Build this topic (runs a focused scan)"
                    onClick={() => {
                      setTab('scans')
                      void promoteTopic(t.id)
                    }}
                  >
                    Build
                  </button>
                  <button className="btn ghost" title="Dismiss" onClick={() => void dismissTopic(t.id)}>
                    ✕
                  </button>
                </div>
              ))
            )}
          </section>
        </div>
      )}

      {tab === 'lessons' && (
        <div className="factory-body">
          <section className="factory-section">
            <h3>Lessons learned ({state.lessons.length})</h3>
            <div className="factory-lesson-add">
              <input
                placeholder="Add a lesson the factory should respect on future runs…"
                value={lessonText}
                onChange={(e) => setLessonText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && lessonText.trim()) {
                    void addLesson(lessonText)
                    setLessonText('')
                  }
                }}
              />
              <button
                className="btn"
                disabled={!lessonText.trim()}
                onClick={() => {
                  void addLesson(lessonText)
                  setLessonText('')
                }}
              >
                Add
              </button>
            </div>
            {state.lessons.length === 0 && (
              <div className="factory-empty-row">
                Lessons are fed into every future scan and build — the factory's running memory of
                mistakes-not-to-repeat.
              </div>
            )}
            {state.lessons.map((l) => (
              <div key={l.id} className="factory-lesson">
                <span className="factory-lesson-text">{l.text}</span>
                <span className="factory-lesson-age">{timeAgo(l.addedAt)}</span>
                <button className="btn ghost" title="Delete lesson" onClick={() => void deleteLesson(l.id)}>
                  ✕
                </button>
              </div>
            ))}
          </section>
        </div>
      )}

      {tab === 'graph' && <FactoryGraph artifacts={state.artifacts} onOpen={openArtifact} />}
    </div>
  )
}
