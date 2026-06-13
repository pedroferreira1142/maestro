/**
 * Gamification model — the single source of truth shared by the main process
 * (which tracks + persists progress) and the renderer (which displays it).
 *
 * Pure module: NO Electron / Node imports, NO `Math.random()` in
 * selection/layout (quest picks and confetti are seeded so main + renderer
 * agree and re-renders are stable). `Date.now()`/`new Date()` are used by
 * callers only for bookkeeping timestamps and "what day is it", never for RNG.
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Every meaningful action that can grant XP / advance quests / unlock badges. */
export type GameEventType =
  | 'session.create'
  | 'session.turn'
  | 'worktree.create'
  | 'worktree.merge'
  | 'worktree.pr'
  | 'checkpoint.create'
  | 'action.run'
  | 'feature.save'
  | 'feature.merge'
  | 'conductor.turn'
  | 'factory.skill'
  | 'factory.agent'
  | 'sentinel.run'
  | 'autoexpand.done'

/** Fire-and-forget event pushed onto the main-process game bus. */
export interface GameEvent {
  type: GameEventType
  /** Optional extra signal: e.g. merge commit count, artifact name, local hour. */
  meta?: { commits?: number; name?: string; hour?: number }
}

/** Base XP per event type (worktree.merge gets a small per-commit bonus on top). */
export const XP_TABLE: Record<GameEventType, number> = {
  'session.turn': 5,
  'conductor.turn': 5,
  'action.run': 8,
  'checkpoint.create': 10,
  'sentinel.run': 12,
  'session.create': 20,
  'worktree.create': 25,
  'feature.save': 30,
  'autoexpand.done': 40,
  'worktree.pr': 50,
  'worktree.merge': 60,
  'factory.skill': 75,
  'factory.agent': 75,
  'feature.merge': 80
}

/** XP for a single event, including the merge per-commit bonus (capped). */
export function xpForEvent(e: GameEvent): number {
  let xp = XP_TABLE[e.type] ?? 0
  if (e.type === 'worktree.merge') xp += Math.min(e.meta?.commits ?? 0, 10) * 3
  return xp
}

// ---------------------------------------------------------------------------
// Level curve (derived from XP — never persisted, so it can't drift)
// ---------------------------------------------------------------------------

/** Cumulative XP required to REACH level n. L1=0, L2=100, L5=1000, L10=4500, L20=19000. */
export function xpForLevel(n: number): number {
  if (n <= 1) return 0
  const k = n - 1
  return 50 * k * k + 50 * k
}

/** The (1-based) level a given lifetime XP total sits at. */
export function levelForXp(xp: number): number {
  if (xp <= 0) return 1
  // Invert 50k² + 50k = xp  →  k = (-50 + √(2500 + 200·xp)) / 100, level = ⌊k⌋ + 1.
  return Math.max(1, Math.floor((-50 + Math.sqrt(2500 + 200 * xp)) / 100) + 1)
}

export interface LevelInfo {
  level: number
  /** XP earned within the current level. */
  xpIntoLevel: number
  /** XP span of the current level (into / forNext = progress fraction). */
  xpForNextLevel: number
}

export function levelInfo(xp: number): LevelInfo {
  const level = levelForXp(xp)
  const floor = xpForLevel(level)
  const next = xpForLevel(level + 1)
  return { level, xpIntoLevel: xp - floor, xpForNextLevel: next - floor }
}

// ---------------------------------------------------------------------------
// Persisted state + broadcast snapshot
// ---------------------------------------------------------------------------

export interface QuestProgress {
  /** Id into DAILY_QUEST_POOL (title/reward looked up there). */
  id: string
  target: number
  progress: number
  /** Reward granted once when progress first reaches target. */
  rewarded: boolean
}

/** The persisted shape (gamification.json). Level is NOT stored (derived). */
export interface GameState {
  xp: number
  streak: { current: number; longest: number; lastDay: string }
  /** Unlocked achievements keyed by id; presence == unlocked-once. */
  achievements: Record<string, { unlockedAt: number }>
  todaysQuests: QuestProgress[]
  questDay: string
  /** Lifetime, monotonic tally per event type. */
  counters: Partial<Record<GameEventType, number>>
  /** Turns finished at local hours 0–4 / 5–7 (time-of-day badges; pure over state). */
  nightTurns: number
  earlyTurns: number
  createdAt: number
}

/** What the renderer receives — GameState plus the derived level fields. */
export interface GameSnapshot extends GameState {
  level: number
  xpIntoLevel: number
  xpForNextLevel: number
}

export const DEFAULT_GAME_STATE: GameState = {
  xp: 0,
  streak: { current: 0, longest: 0, lastDay: '' },
  achievements: {},
  todaysQuests: [],
  questDay: '',
  counters: {},
  nightTurns: 0,
  earlyTurns: 0,
  createdAt: 0
}

// ---------------------------------------------------------------------------
// Celebrations (discrete events that drive the toast + confetti)
// ---------------------------------------------------------------------------

export type GameCelebration =
  | { kind: 'level-up'; seed: string; level: number }
  | { kind: 'achievement'; seed: string; id: string; title: string; icon: string; xp: number }
  | { kind: 'quest'; seed: string; id: string; title: string; xp: number }
  | { kind: 'streak'; seed: string; current: number }

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export type AchievementCategory =
  | 'sessions'
  | 'merges'
  | 'turns'
  | 'factory'
  | 'streak'
  | 'time'
  | 'level'

/** Read-only view the predicates evaluate (all monotonic → re-eval is safe). */
export interface AchievementCtx {
  counters: Partial<Record<GameEventType, number>>
  nightTurns: number
  earlyTurns: number
  streakLongest: number
  level: number
}

export interface Achievement {
  id: string
  title: string
  desc: string
  icon: string
  category: AchievementCategory
  predicate: (ctx: AchievementCtx) => boolean
}

const c = (ctx: AchievementCtx, t: GameEventType): number => ctx.counters[t] ?? 0

export const ACHIEVEMENTS: Achievement[] = [
  // sessions
  { id: 'first-session', title: 'Hello, Maestro', desc: 'Start your first session.', icon: '🎬', category: 'sessions', predicate: (x) => c(x, 'session.create') >= 1 },
  { id: 'ten-sessions', title: 'Regular', desc: 'Start 10 sessions.', icon: '📁', category: 'sessions', predicate: (x) => c(x, 'session.create') >= 10 },
  { id: 'worktree-novice', title: 'Branching Out', desc: 'Create your first parallel task.', icon: '🌱', category: 'sessions', predicate: (x) => c(x, 'worktree.create') >= 1 },
  { id: 'worktree-adept', title: 'Multitasker', desc: 'Create 10 parallel tasks.', icon: '🌳', category: 'sessions', predicate: (x) => c(x, 'worktree.create') >= 10 },
  // merges
  { id: 'first-merge', title: 'Merge One', desc: 'Merge your first worktree.', icon: '🔀', category: 'merges', predicate: (x) => c(x, 'worktree.merge') >= 1 },
  { id: 'ten-merges', title: 'Merge Maestro', desc: 'Merge 10 worktrees.', icon: '🧬', category: 'merges', predicate: (x) => c(x, 'worktree.merge') >= 10 },
  { id: 'fifty-merges', title: 'Merge Machine', desc: 'Merge 50 worktrees.', icon: '⚙️', category: 'merges', predicate: (x) => c(x, 'worktree.merge') >= 50 },
  { id: 'pr-opener', title: 'Pull Request', desc: 'Open your first PR.', icon: '📤', category: 'merges', predicate: (x) => c(x, 'worktree.pr') >= 1 },
  { id: 'pr-prolific', title: 'PR Prolific', desc: 'Open 10 PRs.', icon: '🚀', category: 'merges', predicate: (x) => c(x, 'worktree.pr') >= 10 },
  { id: 'feature-shipper', title: 'Ship It', desc: 'Merge a feature you specced.', icon: '📦', category: 'merges', predicate: (x) => c(x, 'feature.merge') >= 1 },
  // turns
  { id: 'first-turn', title: 'First Light', desc: 'Finish your first Claude turn.', icon: '✶', category: 'turns', predicate: (x) => c(x, 'session.turn') >= 1 },
  { id: 'hundred-turns', title: 'Century', desc: 'Finish 100 turns.', icon: '💯', category: 'turns', predicate: (x) => c(x, 'session.turn') >= 100 },
  { id: 'thousand-turns', title: 'Marathoner', desc: 'Finish 1,000 turns.', icon: '🏃', category: 'turns', predicate: (x) => c(x, 'session.turn') >= 1000 },
  { id: 'conductor-curious', title: 'Conductor Curious', desc: 'Have your first Conductor turn.', icon: '✦', category: 'turns', predicate: (x) => c(x, 'conductor.turn') >= 1 },
  { id: 'conductor-regular', title: 'Maestro of Maestro', desc: 'Have 50 Conductor turns.', icon: '🎼', category: 'turns', predicate: (x) => c(x, 'conductor.turn') >= 50 },
  // factory
  { id: 'first-skill', title: 'Skill Smith', desc: 'Create your first skill.', icon: '🛠', category: 'factory', predicate: (x) => c(x, 'factory.skill') >= 1 },
  { id: 'first-agent', title: 'Agent Architect', desc: 'Create your first agent.', icon: '🤖', category: 'factory', predicate: (x) => c(x, 'factory.agent') >= 1 },
  { id: 'toolsmith', title: 'Toolsmith', desc: 'Create 5 skills/agents.', icon: '⚒', category: 'factory', predicate: (x) => c(x, 'factory.skill') + c(x, 'factory.agent') >= 5 },
  { id: 'master-toolsmith', title: 'Master Toolsmith', desc: 'Create 20 skills/agents.', icon: '🏭', category: 'factory', predicate: (x) => c(x, 'factory.skill') + c(x, 'factory.agent') >= 20 },
  // streak
  { id: 'streak-3', title: 'Warmed Up', desc: 'Keep a 3-day streak.', icon: '🔥', category: 'streak', predicate: (x) => x.streakLongest >= 3 },
  { id: 'streak-7', title: 'On Fire', desc: 'Keep a 7-day streak.', icon: '🔥', category: 'streak', predicate: (x) => x.streakLongest >= 7 },
  { id: 'streak-30', title: 'Unstoppable', desc: 'Keep a 30-day streak.', icon: '☄️', category: 'streak', predicate: (x) => x.streakLongest >= 30 },
  // time of day
  { id: 'night-owl', title: 'Night Owl', desc: 'Finish a turn between midnight and 5am.', icon: '🦉', category: 'time', predicate: (x) => x.nightTurns >= 1 },
  { id: 'early-bird', title: 'Early Bird', desc: 'Finish a turn between 5 and 8am.', icon: '🌅', category: 'time', predicate: (x) => x.earlyTurns >= 1 },
  // level
  { id: 'level-10', title: 'Double Digits', desc: 'Reach level 10.', icon: '⭐', category: 'level', predicate: (x) => x.level >= 10 },
  { id: 'level-25', title: 'Maestro Prime', desc: 'Reach level 25.', icon: '🌟', category: 'level', predicate: (x) => x.level >= 25 }
]

// ---------------------------------------------------------------------------
// Daily quests
// ---------------------------------------------------------------------------

export interface QuestDef {
  id: string
  title: string
  target: number
  reward: number
  /** Event types whose occurrence advances this quest. */
  events: GameEventType[]
}

export const DAILY_QUEST_POOL: QuestDef[] = [
  { id: 'q-turns-5', title: 'Finish 5 Claude turns', target: 5, reward: 30, events: ['session.turn'] },
  { id: 'q-merge-1', title: 'Merge a worktree', target: 1, reward: 40, events: ['worktree.merge'] },
  { id: 'q-merge-3', title: 'Merge 3 worktrees', target: 3, reward: 100, events: ['worktree.merge'] },
  { id: 'q-create-1', title: 'Start a session', target: 1, reward: 20, events: ['session.create'] },
  { id: 'q-worktree-2', title: 'Spin up 2 parallel tasks', target: 2, reward: 50, events: ['worktree.create'] },
  { id: 'q-checkpoint', title: 'Make a checkpoint', target: 1, reward: 20, events: ['checkpoint.create'] },
  { id: 'q-conductor-3', title: 'Have 3 Conductor turns', target: 3, reward: 30, events: ['conductor.turn'] },
  { id: 'q-factory-1', title: 'Create a skill or agent', target: 1, reward: 75, events: ['factory.skill', 'factory.agent'] },
  { id: 'q-feature-1', title: 'Save a feature spec', target: 1, reward: 30, events: ['feature.save'] },
  { id: 'q-pr-1', title: 'Open a pull request', target: 1, reward: 50, events: ['worktree.pr'] }
]

export const questDef = (id: string): QuestDef | undefined => DAILY_QUEST_POOL.find((q) => q.id === id)

// ---------------------------------------------------------------------------
// Deterministic helpers (seeded — no Math.random in selection/layout)
// ---------------------------------------------------------------------------

/** FNV-1a string hash → uint32 seed. */
export function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32 PRNG — deterministic [0,1) generator from a uint32 seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick today's quests deterministically from the day key (stable across reloads). */
export function pickDailyQuests(dayKey: string, n = 3): QuestProgress[] {
  const rnd = mulberry32(hashStr('quest:' + dayKey))
  const pool = [...DAILY_QUEST_POOL]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, Math.min(n, pool.length)).map((q) => ({
    id: q.id,
    target: q.target,
    progress: 0,
    rewarded: false
  }))
}

export interface ConfettiParticle {
  /** Start x as a fraction of width (0..1). */
  x: number
  /** Horizontal drift (-1..1). */
  dx: number
  /** Fall distance factor (0.5..1). */
  dy: number
  /** Initial rotation in degrees. */
  rot: number
  /** Stagger in seconds (0..0.3). */
  delay: number
  /** Palette index for color variety. */
  hue: number
}

/** Deterministic confetti layout for a celebration `seed` (no per-render RNG). */
export function confettiBurst(seed: string, count = 60): ConfettiParticle[] {
  const rnd = mulberry32(hashStr('confetti:' + seed))
  return Array.from({ length: count }, () => ({
    x: rnd(),
    dx: rnd() * 2 - 1,
    dy: 0.5 + rnd() * 0.5,
    rot: rnd() * 360,
    delay: rnd() * 0.3,
    hue: Math.floor(rnd() * 6)
  }))
}

// ---------------------------------------------------------------------------
// Day keys (callers pass a real Date; this is "what day", not RNG)
// ---------------------------------------------------------------------------

/** Local YYYY-M-D key (matches the existing localDay() format elsewhere). */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** The day-key for the day before `d` (month/year-safe). */
export function prevDayKey(d: Date): string {
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  return dayKey(y)
}
