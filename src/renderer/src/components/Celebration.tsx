import { useEffect, type CSSProperties } from 'react'
import { confettiBurst, type GameCelebration } from '../../../shared/gamification'
import { useStore } from '../store'

/** A short, non-intrusive blip via WebAudio (no asset file). Best-effort. */
let audioCtx: AudioContext | null = null
function playBlip(high: boolean): void {
  try {
    audioCtx = audioCtx ?? new AudioContext()
    const ctx = audioCtx
    const now = ctx.currentTime
    const notes = high ? [660, 880, 1320] : [520, 700]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = freq
      const t = now + i * 0.09
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.18)
    })
  } catch {
    // audio is a nice-to-have; never throw
  }
}

function describe(c: GameCelebration): { icon: string; title: string; sub: string; xp: number } {
  switch (c.kind) {
    case 'level-up':
      return { icon: '⭐', title: `Level ${c.level}!`, sub: 'You leveled up', xp: 0 }
    case 'achievement':
      return { icon: c.icon, title: 'Achievement unlocked', sub: c.title, xp: c.xp }
    case 'quest':
      return { icon: '✅', title: 'Quest complete', sub: c.title, xp: c.xp }
    case 'streak':
      return { icon: '🔥', title: `${c.current}-day streak!`, sub: 'Keep it going', xp: 0 }
  }
}

/**
 * Renders the active celebration as a toast card plus a confetti burst. The
 * whole layer is pointer-events:none so it never blocks the terminal; it
 * auto-clears via the store timeout. Confetti + sound respect the user's
 * reduce-motion / sound settings (gating to show at all is done in App).
 */
export function Celebration(): JSX.Element | null {
  const c = useStore((s) => s.celebration)
  const reduceMotion = useStore((s) => s.settings?.gamificationReduceMotion ?? false)
  const sound = useStore((s) => s.settings?.gamificationSound ?? false)

  useEffect(() => {
    if (!c || !sound) return
    if (c.kind === 'level-up' || c.kind === 'achievement') playBlip(c.kind === 'level-up')
  }, [c, sound])

  if (!c) return null
  const info = describe(c)
  const particles = reduceMotion ? [] : confettiBurst(c.seed)

  return (
    <div className={`celebration kind-${c.kind}`} aria-hidden>
      {!reduceMotion && (
        <div className="confetti">
          {particles.map((p, i) => (
            <span
              key={i}
              className={`confetti-bit hue-${p.hue}`}
              style={
                {
                  left: `${p.x * 100}%`,
                  '--dx': p.dx,
                  '--dy': p.dy,
                  '--rot': `${p.rot}deg`,
                  animationDelay: `${p.delay}s`
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
      <div className="celebration-card">
        <span className="celebration-icon">{info.icon}</span>
        <div className="celebration-text">
          <div className="celebration-title">{info.title}</div>
          <div className="celebration-sub">{info.sub}</div>
        </div>
        {info.xp > 0 && <span className="celebration-xp">+{info.xp} XP</span>}
      </div>
    </div>
  )
}
