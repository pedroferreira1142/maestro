import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { FactoryArtifactKind, SkillInfo } from '../shared/types'
import { parseFrontmatter } from './ClaudeEnv'

const CLAUDE_HOME = join(homedir(), '.claude')
const SKILLS_DIR = join(CLAUDE_HOME, 'skills')
const AGENTS_DIR = join(CLAUDE_HOME, 'agents')

/** A kebab-case slug safe to use as a file/dir name (no traversal, no spaces). */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

/** Atomic text write: tmp file + rename, so a reader never sees a half-written file. */
function writeTextAtomic(file: string, content: string): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, content.endsWith('\n') ? content : content + '\n', 'utf8')
  renameSync(tmp, file)
}

/** Absolute path of a generated artifact's file on disk. */
export function artifactPath(kind: FactoryArtifactKind, name: string): string {
  const slug = slugify(name)
  return kind === 'skill' ? join(SKILLS_DIR, slug, 'SKILL.md') : join(AGENTS_DIR, `${slug}.md`)
}

/** Write a skill to ~/.claude/skills/<name>/SKILL.md; returns the absolute path. */
export function writeSkill(name: string, markdown: string): string {
  const slug = slugify(name)
  if (!slug) throw new Error('Invalid skill name.')
  const dir = join(SKILLS_DIR, slug)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  writeTextAtomic(file, markdown)
  return file
}

/** Write a sub-agent to ~/.claude/agents/<name>.md; returns the absolute path. */
export function writeAgent(name: string, markdown: string): string {
  const slug = slugify(name)
  if (!slug) throw new Error('Invalid agent name.')
  mkdirSync(AGENTS_DIR, { recursive: true })
  const file = join(AGENTS_DIR, `${slug}.md`)
  writeTextAtomic(file, markdown)
  return file
}

/** Remove a generated artifact's file (skill dir, or agent .md). Best-effort. */
export function deleteArtifactFile(kind: FactoryArtifactKind, name: string): void {
  const slug = slugify(name)
  if (!slug) return
  const target = kind === 'skill' ? join(SKILLS_DIR, slug) : join(AGENTS_DIR, `${slug}.md`)
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // already gone / locked — nothing more we can do here
  }
}

/**
 * All sub-agents installed under ~/.claude/agents, parsed for name/description.
 * Mirrors scanSkills() in ClaudeEnv — the factory uses it for the "what already
 * exists" snapshot so the scan agent can enrich rather than duplicate.
 */
export function scanAgents(): SkillInfo[] {
  if (!existsSync(AGENTS_DIR)) return []
  let entries: string[]
  try {
    entries = readdirSync(AGENTS_DIR)
  } catch {
    return []
  }
  const out: SkillInfo[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const file = join(AGENTS_DIR, entry)
    const base = entry.replace(/\.md$/, '')
    try {
      const fm = parseFrontmatter(readFileSync(file, 'utf8'))
      out.push({ name: fm.name?.trim() || base, description: fm.description ?? '', source: 'user' })
    } catch {
      out.push({ name: base, description: '', source: 'user' })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
