# Token efficiency — research notes & recommendations

A survey of the current (mid-2026) tools and techniques for cutting Claude Code token
usage, and what Maestro does about each. This backs the **Settings → Token Efficiency**
page: every recommendation marked *adopted* maps to a toggle there.

Maestro's constraint set, which shapes every recommendation below:

- Maestro hosts the **interactive `claude` CLI in a PTY** — it cannot intercept the
  tool calls Claude makes internally (Bash/Read/MCP run inside the CLI process, not
  through the PTY byte stream). The only supported interception points are the ones
  Claude Code itself exposes: **hooks** (`.claude/settings.local.json`), **environment
  variables** read at startup, and **context files**.
- Maestro already materializes per-repo config (`.claude/settings.local.json`,
  `.mcp.json`) before launching claude (see `ContextProfile.ts`), so hook/config-based
  techniques slot into an existing, reversible managed-namespace mechanism.
- No native Node modules beyond node-pty (no C++ toolchain guaranteed on user
  machines), which rules out in-process tree-sitter bindings.

## 1. rtk-style command output compression

**What it is.** `rtk` is a community CLI proxy for agent workflows: you run
`rtk git status` instead of `git status` and it emits a compact, agent-oriented
rendering of the output (deduplicated, de-noised, often 60–90 % smaller). The same
idea generalizes: most of the tokens an agent burns on `git log`, `npm install`,
test runs and builds are progress bars, repeated warnings and banner noise.

**How it integrates with Claude Code.** Two mechanisms work:

1. Prompt-level: tell the model (CLAUDE.md) to prefix commands with `rtk`. Fragile —
   depends on model cooperation, decays over a long session.
2. **PreToolUse hook with `updatedInput`** (generally available in current Claude
   Code): a hook matched on `Bash` receives the command on stdin and can rewrite it
   before it runs. Deterministic, no model cooperation needed.

**Recommendation — adopted (toggle: “Output compression”).** Maestro registers a
PreToolUse(Bash) hook that:

- prefixes `git <noisy-subcommand>` with `rtk` when rtk is detected on PATH;
- otherwise (and for non-git noisy commands: npm/pnpm/yarn/bun installs and test/build
  runs, cargo, go, maven/gradle, pytest, tsc, make, dotnet) pipes the command through
  Maestro's **built-in output filter** (`output-filter.mjs`): strips ANSI, collapses
  repeated lines and progress noise, and keeps head + tail + error/warning lines of
  very long output. `set -o pipefail` preserves the real exit code.
- Commands that already pipe, redirect, use heredocs or already mention rtk/the filter
  are left untouched. Maestro does **not** auto-install rtk; the settings page shows
  detection status and falls back to the built-in filter.

The filter logs original/compressed sizes, which feeds the savings indicator in the UI.

## 2. Code graph / repo map providers

**Surveyed options.**

- **Serena MCP server** — language-server-backed symbol navigation (find_symbol,
  references) as MCP tools. Excellent quality, but heavyweight: a Python runtime plus
  language servers per repo, and an extra MCP server in every session's context.
- **Generic code-graph MCP servers** — same trade-off; each adds tool-definition
  tokens to every request and another process to babysit per session (Maestro runs
  many sessions at once).
- **Aider-style repo map** — a compact, ranked “file: symbols” map injected as
  context. Aider builds it with tree-sitter; the key insight is the *format* (one
  line per file listing its top-level symbols) rather than the parser. It lets the
  model jump straight to `Grep`/targeted reads instead of exploratory full-file reads.
- **ast-grep** — structural search CLI. Great when the *model* knows about it, but it
  is an on-demand tool, not a persistent token saver; best delivered as a skill, not
  as platform plumbing.

**Recommendation — adopted (toggle: “Code graph / repo map”).** Ship a built-in,
dependency-free repo-map generator: a fast regex symbol extractor (functions, classes,
types, exported symbols for the mainstream languages) producing an aider-style compact
map, capped (~24 kB) and cached per git HEAD, written to
`.claude/maestro-repo-map.md` (kept out of git via `info/exclude`). A
**SessionStart hook** prints it into Claude's context at startup/resume/compact, with
a nudge to navigate by symbols + Grep instead of full-file reads. Refresh: HEAD is
polled and the map regenerated on git changes, plus a manual refresh button.

Regex extraction is deliberately chosen over tree-sitter (native module constraint)
and over an MCP server (per-session process + tool-token overhead). Accuracy is
lower than tree-sitter but the map is advisory navigation context, not ground truth.

## 3. Tool-output truncation (“PostToolUse-style” limits)

**Findings.** PostToolUse hooks historically could not replace tool output; current
Claude Code documents `updatedToolOutput`, but the env-var path is older, simpler and
unambiguous:

- `BASH_MAX_OUTPUT_LENGTH` — max characters of Bash output forwarded to the model.
- `MAX_MCP_OUTPUT_TOKENS` — cap on MCP tool results.
- The `Read` tool self-caps (2000 lines) but giant single-line files (lockfiles,
  minified bundles, logs) still hurt.

**Recommendation — adopted (toggle: “Output truncation”).** Two layers:

1. Env vars injected when claude spawns: `BASH_MAX_OUTPUT_LENGTH` and
   `MAX_MCP_OUTPUT_TOKENS`, both configurable on the settings page.
2. A PreToolUse(Read) **read guard** hook that denies whole-file reads of well-known
   token sinks above a configurable size (lockfiles, `node_modules/`, `dist/`,
   minified/sourcemap files, logs) with a denial reason steering Claude to `Grep` or
   an offset/limit read. Each blocked read is logged for the savings indicator.

## 4. Prompt caching

**Findings.** Claude Code uses prompt caching automatically; there is nothing to
“turn on”. What *loses* cache hits: environments that set `DISABLE_PROMPT_CACHING=1`,
and workflows that needlessly restart conversations (every fresh start re-writes the
cache). Cache reads cost ~0.1× input, so keeping it healthy matters more than any
other single setting.

**Recommendation — adopted (toggle: “Prompt-caching hints”).** Maestro strips
`DISABLE_PROMPT_CACHING` from the environment it spawns claude with (an inherited
shell/profile setting would otherwise silently 10× input cost), and Maestro's restart
flows already default to `--continue` so conversations resume instead of restarting.
No further action is possible from outside the CLI.

## 5. Small-model delegation

**Findings.** Claude Code already delegates internally (Haiku for lightweight
classification). The user-controllable levers are per-terminal `--model` (Maestro has
a model switcher) and skills/subagents that route work to cheaper models.

**Recommendation — not a toggle.** Already served by the existing per-terminal model
switcher; a forced global downgrade would degrade output quality unpredictably.
Revisit if Claude Code exposes a “background model” setting.

## 6. Context hygiene (skills/MCP slimming)

Maestro's repo categories already cap which skills load (`name-only` floor) and which
MCP servers a repo gets — each enabled MCP server costs tool-definition tokens in
every request. This is the same lever the Token Efficiency page's status indicator
surfaces, but it stays configured on the Repo categories tab.

## Summary of adopted tools

| Toggle | Mechanism | Default |
| --- | --- | --- |
| Output compression | PreToolUse(Bash) rewrite → rtk or built-in filter | on (when master on) |
| Code graph / repo map | regex symbol map + SessionStart context hook | on |
| Output truncation | `BASH_MAX_OUTPUT_LENGTH` / `MAX_MCP_OUTPUT_TOKENS` env + Read guard hook | on |
| Prompt-caching hints | strip `DISABLE_PROMPT_CACHING` at spawn | on |

All of it is materialized per repo right before a claude terminal spawns and removed
again when toggled off (managed-namespace edits, like repo categories). Because hooks
and env are read at startup, **running terminals pick changes up on restart** — the
settings page shows which sessions are pending a restart.
