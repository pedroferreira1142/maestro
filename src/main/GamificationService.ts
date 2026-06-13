import { BrowserWindow } from 'electron'
import {
  ACHIEVEMENTS,
  AchievementCtx,
  dayKey,
  GameCelebration,
  GameEvent,
  GameSnapshot,
  GameState,
  levelForXp,
  levelInfo,
  pickDailyQuests,
  prevDayKey,
  questDef,
  TOKENS_PER_XP,
  xpForEvent
} from '../shared/gamification'
import { GamificationStore } from './GamificationStore'

/** Flat XP bonus for unlocking an achievement. */
const ACHIEVEMENT_XP = 25

/** How often to reconcile burned tokens into XP (cheap: UsageService is cached). */
const TOKEN_POLL_MS = 60_000

/**
 * Tracks and persists gamification progress. Services push a `GameEvent` here
 * (via the main-process game bus); this is the single place XP, levels,
 * achievements, streaks and daily quests are computed — so all dedupe lives in
 * one method. Broadcasts a full snapshot on every change and discrete
 * celebration events for level-ups / unlocks. Always tracks (regardless of the
 * gamification setting); the renderer decides whether to display.
 */
export class GamificationService {
  private store = new GamificationStore()
  private state: GameState
  private tokenTimer: NodeJS.Timeout | null = null

  /**
   * @param getUsageTokens returns the lifetime input+output token total (from
   *   UsageService). Polled to award XP for tokens burned since the last check.
   */
  constructor(
    private getWin: () => BrowserWindow | null,
    private getUsageTokens?: () => number
  ) {
    this.state = this.store.load()
  }

  /** Begin polling burned tokens (baselined on the first tick, so historical
   *  usage is never retroactively dumped into XP). */
  start(): void {
    if (this.tokenTimer || !this.getUsageTokens) return
    this.pollTokenBurn()
    this.tokenTimer = setInterval(() => this.pollTokenBurn(), TOKEN_POLL_MS)
  }

  /** GameState + derived level fields (for the initial renderer fetch). */
  snapshot(): GameSnapshot {
    return { ...this.state, ...levelInfo(this.state.xp) }
  }

  dispose(): void {
    if (this.tokenTimer) {
      clearInterval(this.tokenTimer)
      this.tokenTimer = null
    }
    this.store.saveNow()
  }

  /**
   * Reconcile burned tokens into XP. The first observation only records the
   * baseline (no award). Afterward, each whole `TOKENS_PER_XP` of new input+
   * output tokens grants 1 XP via a `tokens.burn` event; the sub-unit remainder
   * is carried (the baseline advances only by tokens actually converted), so
   * even light usage eventually counts. A drop in the total (pruned transcripts)
   * silently re-baselines.
   */
  private pollTokenBurn(): void {
    if (!this.getUsageTokens) return
    try {
      const total = this.getUsageTokens()
      if (!Number.isFinite(total) || total < 0) return
      const seen = this.state.usageTokensSeen
      if (seen < 0 || total < seen) {
        this.state.usageTokensSeen = total
        this.store.set(this.state)
        return
      }
      const units = Math.floor((total - seen) / TOKENS_PER_XP)
      if (units <= 0) return
      const consumed = units * TOKENS_PER_XP
      this.state.usageTokensSeen = seen + consumed
      // award() persists (incl. the advanced baseline) and broadcasts.
      this.award({ type: 'tokens.burn', meta: { tokens: consumed } })
    } catch (err) {
      console.error('Token-burn poll failed (ignored):', err)
    }
  }

  /**
   * Apply one event: bump counters, roll the day (streak + quests), add XP,
   * advance quests, unlock achievements — each guarded so nothing double-counts.
   * Wrapped so a gamification failure can never break the caller's turn/merge.
   */
  award(e: GameEvent): void {
    try {
      const s = this.state
      const now = new Date()
      const today = dayKey(now)
      const celebrations: GameCelebration[] = []

      // (1) Day rollover — runs at most once per local day (keyed on lastDay).
      if (s.streak.lastDay !== today) {
        s.streak.current = s.streak.lastDay === prevDayKey(now) ? s.streak.current + 1 : 1
        s.streak.longest = Math.max(s.streak.longest, s.streak.current)
        s.streak.lastDay = today
        s.todaysQuests = pickDailyQuests(today)
        s.questDay = today
        // Only celebrate a streak of 2+ days — a brand-new "1-day streak" on first
        // use is just noise.
        if (s.streak.current >= 2) {
          celebrations.push({
            kind: 'streak',
            seed: `streak:${today}:${s.streak.current}`,
            current: s.streak.current
          })
        }
      }

      // (2) Lifetime counter + time-of-day pseudo-counters. `tokens.burn` is a
      // synthetic, variable-magnitude event: it accrues tokens (not a +1 tally),
      // so token achievements read `tokensBurned` rather than a counter.
      if (e.type === 'tokens.burn') {
        s.tokensBurned += Math.max(0, e.meta?.tokens ?? 0)
      } else {
        s.counters[e.type] = (s.counters[e.type] ?? 0) + 1
      }
      if (e.type === 'session.turn' || e.type === 'conductor.turn') {
        const hour = e.meta?.hour ?? now.getHours()
        if (hour >= 0 && hour < 5) s.nightTurns += 1
        else if (hour >= 5 && hour < 8) s.earlyTurns += 1
      }

      // (3) Base XP (level-up computed once at the end, over the full delta).
      const beforeLevel = levelForXp(s.xp)
      s.xp += xpForEvent(e)

      // (4) Advance matching quests; reward once when first completed.
      for (const q of s.todaysQuests) {
        if (q.rewarded) continue
        const def = questDef(q.id)
        if (!def || !def.events.includes(e.type)) continue
        q.progress = Math.min(q.target, q.progress + 1)
        if (q.progress >= q.target) {
          q.rewarded = true
          s.xp += def.reward
          celebrations.push({
            kind: 'quest',
            seed: `quest:${today}:${q.id}`,
            id: q.id,
            title: def.title,
            xp: def.reward
          })
        }
      }

      // (5) Achievements — unlock each at most once (presence == flag). Run to a
      // fixed point, recomputing `level` each pass, so a level achievement whose
      // boundary is crossed by another achievement's bonus XP this same award
      // still unlocks now (not one event later). Terminates: each pass either
      // unlocks ≥1 new achievement or stops (bounded by ACHIEVEMENTS.length).
      let unlockedThisPass = true
      while (unlockedThisPass) {
        unlockedThisPass = false
        const ctx: AchievementCtx = {
          counters: s.counters,
          nightTurns: s.nightTurns,
          earlyTurns: s.earlyTurns,
          streakLongest: s.streak.longest,
          level: levelForXp(s.xp),
          tokensBurned: s.tokensBurned
        }
        for (const a of ACHIEVEMENTS) {
          if (s.achievements[a.id]) continue
          if (a.predicate(ctx)) {
            s.achievements[a.id] = { unlockedAt: Date.now() }
            s.xp += ACHIEVEMENT_XP
            unlockedThisPass = true
            celebrations.push({
              kind: 'achievement',
              seed: `ach:${a.id}`,
              id: a.id,
              title: a.title,
              icon: a.icon,
              xp: ACHIEVEMENT_XP
            })
          }
        }
      }

      // (6) Level-up celebration — one per crossed level, only on a real increase.
      const afterLevel = levelForXp(s.xp)
      for (let l = beforeLevel + 1; l <= afterLevel; l++) {
        celebrations.push({ kind: 'level-up', seed: `level:${l}`, level: l })
      }

      this.store.set(s)
      this.broadcast()
      for (const c of celebrations) this.celebrate(c)
    } catch (err) {
      console.error('Gamification award failed (ignored):', err)
    }
  }

  private broadcast(): void {
    this.getWin()?.webContents.send('gamification:changed', this.snapshot())
  }

  private celebrate(c: GameCelebration): void {
    this.getWin()?.webContents.send('gamification:celebrate', c)
  }
}
