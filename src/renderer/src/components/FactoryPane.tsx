import { useEffect, useMemo, useState } from 'react'
import type { FactoryArtifact, FactoryCandidate, FactoryRun } from '../../../shared/types'
import { useStore } from '../store'

const KIND_LABEL: Record<FactoryCandidate['kind'], string> = { skill: 'skill', agent: 'agent' }

/** One proposed/authored candidate with approve/reject controls. */
function CandidateCard({ runId, candidate }: { runId: string; candidate: FactoryCandidate }): JSX.Element {
  const approve = useStore((s) => s.approveFactoryCandidate)
  const reject = useStore((s) => s.rejectFactoryCandidate)
  const proposed = candidate.status === 'proposed'
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
          <span className={`factory-cand-status status-${candidate.status}`}>{candidate.status}</span>
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
      {candidate.result && <div className="factory-candidate-result">{candidate.result}</div>}
      {proposed && (
        <div className="factory-candidate-buttons">
          <button className="btn primary" onClick={() => void approve(runId, candidate.id)}>
            Approve & build
          </button>
          <button className="btn ghost" onClick={() => void reject(runId, candidate.id)}>
            Reject
          </button>
        </div>
      )}
    </div>
  )
}

function RunView({ run }: { run: FactoryRun }): JSX.Element {
  const approveAll = useStore((s) => s.approveAllFactoryCandidates)
  const proposed = run.candidates.filter((c) => c.status === 'proposed')
  const phaseLabel =
    run.status === 'running'
      ? run.phase === 'discovering'
        ? 'Exploring the source…'
        : 'Proposing candidates…'
      : ''
  return (
    <div className={`factory-run status-${run.status}`}>
      <div className="factory-run-head">
        <span className="factory-run-source">{run.sourceLabel}</span>
        {run.guidance && <span className="factory-run-guidance" title={run.guidance}>“{run.guidance}”</span>}
        {run.status === 'running' && <span className="factory-run-phase">⟳ {phaseLabel}</span>}
      </div>
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
    </div>
  )
}

function ArtifactRow({ artifact }: { artifact: FactoryArtifact }): JSX.Element {
  const del = useStore((s) => s.deleteFactoryArtifact)
  const showNotice = useStore((s) => s.showNotice)
  return (
    <div className={`factory-artifact kind-${artifact.kind}`}>
      <span className={`kind-chip kind-${artifact.kind}`}>{KIND_LABEL[artifact.kind]}</span>
      <div className="factory-artifact-main">
        <div className="factory-artifact-name">{artifact.name}</div>
        <div className="factory-artifact-desc">{artifact.description}</div>
        {artifact.relatedArtifacts.length > 0 && (
          <div className="factory-artifact-related">↔ {artifact.relatedArtifacts.join(', ')}</div>
        )}
      </div>
      <button
        className="btn ghost"
        title={`Copy path:\n${artifact.filePath}`}
        onClick={() => {
          window.api.clipboardWrite(artifact.filePath)
          showNotice('Path copied')
        }}
      >
        ⧉
      </button>
      <button className="btn ghost" title="Delete artifact (removes its file)" onClick={() => void del(artifact.id)}>
        ✕
      </button>
    </div>
  )
}

/**
 * The Agent & Skill Factory surface: mine a connected MCP source for reusable
 * Claude skills and sub-agents (propose→confirm), and manage the self-extending
 * registry, the topics-to-pursue backlog, and lessons learned. State lives in
 * the store; main pushes changes via onFactoryChanged / onFactoryRuns.
 */
export function FactoryPane(): JSX.Element {
  const sources = useStore((s) => s.factorySources)
  const sourcesLoading = useStore((s) => s.factorySourcesLoading)
  const runs = useStore((s) => s.factoryRuns)
  const state = useStore((s) => s.factoryState)
  const loadSources = useStore((s) => s.loadFactorySources)
  const scan = useStore((s) => s.scanFactory)
  const promoteTopic = useStore((s) => s.promoteFactoryTopic)
  const dismissTopic = useStore((s) => s.dismissFactoryTopic)
  const addLesson = useStore((s) => s.addFactoryLesson)
  const deleteLesson = useStore((s) => s.deleteFactoryLesson)

  const [serverKey, setServerKey] = useState('')
  const [guidance, setGuidance] = useState('')
  const [lessonText, setLessonText] = useState('')

  // Default the source picker to the first discovered source.
  useEffect(() => {
    if (!serverKey && sources.length > 0) setServerKey(sources[0].server)
  }, [sources, serverKey])

  const busy = useMemo(
    () => runs.some((r) => r.status === 'running' || r.candidates.some((c) => c.status === 'authoring')),
    [runs]
  )
  const openTopics = state.topics.filter((t) => t.status === 'open')

  const doScan = (): void => {
    if (!serverKey || busy) return
    void scan(serverKey, guidance)
    setGuidance('')
  }

  return (
    <div className="factory-pane">
      <div className="factory-header">
        <div className="factory-title">⚒ Agent &amp; Skill Factory</div>
        <button
          className="btn ghost"
          title="Re-discover connected MCP sources"
          disabled={sourcesLoading}
          onClick={() => void loadSources(true)}
        >
          {sourcesLoading ? '⟳ Discovering…' : '⟳ Sources'}
        </button>
      </div>

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
            No connected MCP sources were found. Connect an integration (e.g. Atlassian, GitHub) in
            Claude Code, then click “⟳ Sources”.
          </div>
        )}

        {/* Runs (candidates) */}
        {runs.length > 0 && (
          <section className="factory-section">
            <h3>Scans</h3>
            {runs.map((r) => (
              <RunView key={r.id} run={r} />
            ))}
          </section>
        )}

        {/* Registry / coverage */}
        <section className="factory-section">
          <h3>Generated artifacts ({state.artifacts.length})</h3>
          {state.artifacts.length === 0 ? (
            <div className="factory-empty-row">
              Nothing generated yet. Pick a source above and scan it to propose skills and agents.
            </div>
          ) : (
            state.artifacts
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((a) => <ArtifactRow key={a.id} artifact={a} />)
          )}
        </section>

        {/* Backlog */}
        {openTopics.length > 0 && (
          <section className="factory-section">
            <h3>Topics to pursue ({openTopics.length})</h3>
            {openTopics.map((t) => (
              <div key={t.id} className="factory-topic">
                <div className="factory-topic-main">
                  <div className="factory-topic-title">{t.title}</div>
                  {t.note && <div className="factory-topic-note">{t.note}</div>}
                </div>
                <button
                  className="btn ghost"
                  disabled={busy}
                  title="Build this topic (runs a focused scan)"
                  onClick={() => void promoteTopic(t.id)}
                >
                  Build
                </button>
                <button className="btn ghost" title="Dismiss" onClick={() => void dismissTopic(t.id)}>
                  ✕
                </button>
              </div>
            ))}
          </section>
        )}

        {/* Lessons */}
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
          {state.lessons.map((l) => (
            <div key={l.id} className="factory-lesson">
              <span className="factory-lesson-text">{l.text}</span>
              <button className="btn ghost" title="Delete lesson" onClick={() => void deleteLesson(l.id)}>
                ✕
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
  )
}
