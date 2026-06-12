/**
 * Pure parsing/rewriting of the `--model` flag inside a terminal's
 * `claudeArgs` array. Both the inline (`--model opus`) and joined
 * (`--model=opus`) forms are understood; every other argument is left
 * untouched and in its original order.
 */

/** The model aliases the per-terminal switcher offers (beyond Default). */
export type ClaudeModelAlias = 'opus' | 'sonnet' | 'haiku'

const MODEL_ALIASES: readonly ClaudeModelAlias[] = ['opus', 'sonnet', 'haiku']

const MODEL_EQ = '--model='

/**
 * The raw value of the first `--model` flag in `args`, or null when none is
 * present. Handles `--model x` and `--model=x`; a trailing `--model` with no
 * value reads as null.
 */
export function getModelArg(args: string[] | undefined): string | null {
  const a = args ?? []
  for (let i = 0; i < a.length; i++) {
    const tok = a[i]
    if (tok === '--model') return a[i + 1] ?? null
    if (tok.startsWith(MODEL_EQ)) return tok.slice(MODEL_EQ.length)
  }
  return null
}

/**
 * The selected model as one of the switcher's known aliases, or null (= the
 * Default option) when no `--model` is set or its value isn't one we offer.
 */
export function getModelAlias(args: string[] | undefined): ClaudeModelAlias | null {
  const value = getModelArg(args)
  return value && (MODEL_ALIASES as readonly string[]).includes(value)
    ? (value as ClaudeModelAlias)
    : null
}

/**
 * Return a copy of `args` whose `--model` is exactly `alias` (one inline
 * `--model <alias>` pair appended), or with every `--model` flag removed when
 * `alias` is null. All other arguments keep their value and relative order.
 */
export function setModelAlias(
  args: string[] | undefined,
  alias: ClaudeModelAlias | null
): string[] {
  const out: string[] = []
  const a = args ?? []
  for (let i = 0; i < a.length; i++) {
    const tok = a[i]
    if (tok === '--model') {
      i++ // drop the flag and its value
      continue
    }
    if (tok.startsWith(MODEL_EQ)) continue // drop the joined form
    out.push(tok)
  }
  if (alias) out.push('--model', alias)
  return out
}
