import { useStore } from '../store'

/**
 * Compact level + XP bar + streak shown under the sidebar header. Hidden when
 * gamification is disabled or no snapshot has loaded yet. Clicking opens the
 * Arcade.
 */
export function XpHud(): JSX.Element | null {
  const game = useStore((s) => s.game)
  const enabled = useStore((s) => s.settings?.gamificationEnabled ?? true)
  const openArcade = useStore((s) => s.openArcade)
  if (!enabled || !game) return null

  const pct =
    game.xpForNextLevel > 0
      ? Math.max(0, Math.min(100, Math.round((game.xpIntoLevel / game.xpForNextLevel) * 100)))
      : 0
  const streak = game.streak.current

  return (
    <div
      className="xp-hud"
      onClick={openArcade}
      title={
        `Level ${game.level} — ${game.xpIntoLevel}/${game.xpForNextLevel} XP to level ${game.level + 1}` +
        (streak > 0 ? ` · 🔥 ${streak}-day streak` : '') +
        '\nOpen the Arcade'
      }
    >
      <span className="xp-level">Lv {game.level}</span>
      <div className="xp-bar">
        <div className="xp-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {streak > 0 && <span className="xp-streak">🔥{streak}</span>}
    </div>
  )
}
