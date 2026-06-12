import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { UsageLimits, UsageLimitWindow } from '../shared/types'

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')

/**
 * Anthropic's subscription usage endpoint — the same one Claude Code's
 * `/usage` queries. Returns five-hour and seven-day rate-limit utilization for
 * the authenticated subscription.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** OAuth beta header Claude Code sends on subscription-scoped requests. */
const OAUTH_BETA = 'oauth-2025-04-20'

/** Bound the network call so a hung request can't stall the poll. */
const FETCH_TIMEOUT_MS = 8000

/**
 * Cache the last successful fetch briefly. The widget polls once a minute, but
 * this also absorbs popup re-opens and guards against hammering the endpoint.
 */
const CACHE_TTL_MS = 20_000

interface RawWindow {
  utilization?: unknown
  resets_at?: unknown
}

interface RawUsage {
  five_hour?: RawWindow | null
  seven_day?: RawWindow | null
  seven_day_opus?: RawWindow | null
  seven_day_sonnet?: RawWindow | null
}

function readAccessToken(): string | null {
  let raw: string
  try {
    raw = readFileSync(CREDENTIALS_PATH, 'utf8')
  } catch {
    return null
  }
  try {
    const oauth = (JSON.parse(raw) as Record<string, unknown>).claudeAiOauth as
      | Record<string, unknown>
      | undefined
    const token = oauth?.accessToken
    if (typeof token !== 'string' || token.length === 0) return null
    // Skip a call we know will 401. Claude Code refreshes this file on use, so
    // a live token reappears here on its own — we never refresh it ourselves.
    const expiresAt = oauth?.expiresAt
    if (typeof expiresAt === 'number' && Date.now() >= expiresAt) return null
    return token
  } catch {
    return null
  }
}

function mapWindow(w: RawWindow | null | undefined): UsageLimitWindow | null {
  if (!w || typeof w.utilization !== 'number' || !isFinite(w.utilization)) return null
  const resetsAt =
    typeof w.resets_at === 'string' ? Date.parse(w.resets_at) || null : null
  return { utilization: w.utilization, resetsAt }
}

/**
 * Reads the OAuth token Claude Code stores and fetches the subscription usage
 * limits. Returns null on any failure (no token, expired token, network error,
 * non-200, unparseable body, or a response without a five-hour window) so the
 * renderer can simply omit the limits section. Successful results are cached
 * for a short TTL.
 */
export class UsageLimitsService {
  private cache: { at: number; value: UsageLimits | null } | null = null
  private inFlight: Promise<UsageLimits | null> | null = null

  async limits(): Promise<UsageLimits | null> {
    const now = Date.now()
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.value
    if (this.inFlight) return this.inFlight
    this.inFlight = this.fetchLimits()
      .then((value) => {
        this.cache = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  private async fetchLimits(): Promise<UsageLimits | null> {
    const token = readAccessToken()
    if (!token) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    let raw: RawUsage
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA
        },
        signal: controller.signal
      })
      if (!res.ok) return null
      raw = (await res.json()) as RawUsage
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }

    const session = mapWindow(raw.five_hour)
    const week = mapWindow(raw.seven_day)
    // Without at least the session window the payload isn't usable.
    if (!session || !week) return null
    return {
      session,
      week,
      weekOpus: mapWindow(raw.seven_day_opus),
      weekSonnet: mapWindow(raw.seven_day_sonnet),
      fetchedAt: Date.now()
    }
  }
}
