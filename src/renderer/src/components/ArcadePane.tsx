import { useEffect, useMemo, useState } from 'react'
import {
  ACHIEVEMENTS,
  type AchievementCategory,
  type GameEventType,
  questDef
} from '../../../shared/gamification'
import type { UsageSnapshot } from '../../../shared/types'
import { useStore } from '../store'

const CATEGORY_LABEL: Record<AchievementCategory, string> = {
  sessions: 'Sessions',
  merges: 'Merges & PRs',
  turns: 'Turns',
  factory: 'Factory',
  streak: 'Streaks',
  time: 'Time of day',
  level: 'Levels'
}

const COUNTER_LABEL: Partial<Record<GameEventType, string>> = {
  'session.create': 'Sessions started',
  'session.turn': 'Claude turns',
  'worktree.create': 'Parallel tasks',
  'worktree.merge': 'Worktrees merged',
  'worktree.pr': 'PRs opened',
  'checkpoint.create': 'Checkpoints',
  'conductor.turn': 'Conductor turns',
  'factory.skill': 'Skills created',
  'factory.agent': 'Agents created',
  'feature.save': 'Feature specs',
  'feature.merge': 'Features shipped',
  'action.run': 'Actions run'
}

const COUNTER_ORDER: GameEventType[] = [
  'session.turn',
  'worktree.merge',
  'worktree.create',
  'session.create',
  'worktree.pr',
  'factory.skill',
  'factory.agent',
  'conductor.turn',
  'feature.save',
  'feature.merge',
  'checkpoint.create',
  'action.run'
]

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function ArcadePane(): JSX.Element {
  const game = useStore((s) => s.game)
  const loadGame = useStore((s) => s.loadGame)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)

  useEffect(() => {
    let alive = true
    void loadGame()
    void window.api
      .getUsage()
      .then((u) => alive && setUsage(u))
      .catch(() => alive && setUsage(null))
    return () => {
      alive = false
    }
  }, [loadGame])

  const byCategory = useMemo(() => {
    const groups = new Map<AchievementCategory, typeof ACHIEVEMENTS>()
    for (const a of ACHIEVEMENTS) {
      const list = groups.get(a.category) ?? []
      list.push(a)
      groups.set(a.category, list)
    }
    return [...groups.entries()]
  }, [])

  if (!game) {
    return (
      <div className="arcade-pane">
        <div className="arcade-empty">Loading your progress…</div>
      </div>
    )
  }

  const xpPct =
    game.xpForNextLevel > 0
      ? Math.max(0, Math.min(100, Math.round((game.xpIntoLevel / game.xpForNextLevel) * 100)))
      : 0
  const unlocked = Object.keys(game.achievements).length

  return (
    <div className="arcade-pane">
      <div className="arcade-header">
        <h2>🎮 Arcade</h2>
        <span className="arcade-sub">Your Maestro progress</span>
      </div>

      <div className="arcade-grid">
        {/* Level / XP hero */}
        <section className="arcade-card arcade-hero">
          <div className="arcade-level-badge">Lv {game.level}</div>
          <div className="arcade-hero-main">
            <div className="arcade-xp-row">
              <span>{fmt(game.xpIntoLevel)} / {fmt(game.xpForNextLevel)} XP</span>
              <span className="arcade-dim">{fmt(game.xp)} total</span>
            </div>
            <div className="xp-bar lg">
              <div className="xp-bar-fill" style={{ width: `${xpPct}%` }} />
            </div>
            <div className="arcade-dim">
              {fmt(Math.max(0, game.xpForNextLevel - game.xpIntoLevel))} XP to level {game.level + 1}
            </div>
          </div>
        </section>

        {/* Streak */}
        <section className="arcade-card arcade-streak">
          <div className="arcade-streak-flame">🔥</div>
          <div>
            <div className="arcade-streak-num">{game.streak.current}</div>
            <div className="arcade-dim">day streak</div>
            <div className="arcade-dim small">best: {game.streak.longest}</div>
          </div>
        </section>
      </div>

      {/* Daily quests */}
      <section className="arcade-card">
        <div className="arcade-card-head">
          <h3>Today’s quests</h3>
          <span className="arcade-dim">resets daily</span>
        </div>
        {game.todaysQuests.length === 0 ? (
          <div className="arcade-dim">Do anything in Maestro to roll today’s quests.</div>
        ) : (
          <div className="arcade-quests">
            {game.todaysQuests.map((q) => {
              const def = questDef(q.id)
              const pct = q.target > 0 ? Math.min(100, Math.round((q.progress / q.target) * 100)) : 0
              return (
                <div key={q.id} className={`quest-row${q.rewarded ? ' done' : ''}`}>
                  <div className="quest-top">
                    <span className="quest-title">{def?.title ?? q.id}</span>
                    <span className="quest-reward">{q.rewarded ? '✓' : `+${def?.reward ?? 0} XP`}</span>
                  </div>
                  <div className="xp-bar">
                    <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="arcade-dim small">
                    {Math.min(q.progress, q.target)} / {q.target}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Achievements */}
      <section className="arcade-card">
        <div className="arcade-card-head">
          <h3>Achievements</h3>
          <span className="arcade-dim">
            {unlocked} / {ACHIEVEMENTS.length}
          </span>
        </div>
        {byCategory.map(([cat, list]) => (
          <div key={cat} className="arcade-ach-group">
            <div className="arcade-ach-cat">{CATEGORY_LABEL[cat]}</div>
            <div className="arcade-ach-grid">
              {list.map((a) => {
                const got = !!game.achievements[a.id]
                return (
                  <div
                    key={a.id}
                    className={`achievement${got ? ' unlocked' : ' locked'}`}
                    title={`${a.title} — ${a.desc}${got ? '' : ' (locked)'}`}
                  >
                    <span className="achievement-icon">{got ? a.icon : '🔒'}</span>
                    <span className="achievement-title">{a.title}</span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Stats */}
      <section className="arcade-card">
        <div className="arcade-card-head">
          <h3>Lifetime stats</h3>
        </div>
        <div className="arcade-stats">
          {COUNTER_ORDER.filter((t) => (game.counters[t] ?? 0) > 0).map((t) => (
            <div key={t} className="arcade-stat">
              <div className="arcade-stat-num">{fmt(game.counters[t] ?? 0)}</div>
              <div className="arcade-dim small">{COUNTER_LABEL[t]}</div>
            </div>
          ))}
          {usage && (
            <>
              <div className="arcade-stat">
                <div className="arcade-stat-num">${usage.total.costUSD.toFixed(0)}</div>
                <div className="arcade-dim small">All-time spend</div>
              </div>
              <div className="arcade-stat">
                <div className="arcade-stat-num">
                  {fmt(usage.total.inputTokens + usage.total.outputTokens)}
                </div>
                <div className="arcade-dim small">Tokens used</div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
