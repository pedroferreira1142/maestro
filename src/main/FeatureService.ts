import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Feature, SessionInfo } from '../shared/types'
import { slugify } from './GitService'
import { Persistence } from './Persistence'
import { SessionManager } from './SessionManager'

/** Repo-relative location of a feature's generated spec file. */
function specRelPath(feature: Feature): string {
  return join('.maestro', 'specs', `${slugify(feature.title)}.md`)
}

/** Render a feature + its specs as the markdown spec file claude reads. */
function specMarkdown(feature: Feature): string {
  const specs = feature.specs.length
    ? feature.specs.map((s) => `- [${s.done ? 'x' : ' '}] ${s.text}`).join('\n')
    : '_(no specs listed)_'
  return (
    `# ${feature.title}\n\n` +
    `${feature.description.trim() || '_(no description)_'}\n\n` +
    `## Specs\n\n${specs}\n`
  )
}

/** The first prompt typed (and auto-submitted) into the task's claude terminal. */
function implementPrompt(feature: Feature): string {
  return (
    `This worktree was created to implement a feature. Its spec lives at:\n` +
    `  ${specRelPath(feature).replace(/\\/g, '/')}\n\n` +
    `Feature: ${feature.title}\n\n` +
    `Read that spec file in full, then implement every spec it lists. Make your ` +
    `changes in this worktree and commit them as each part works. If any spec is ` +
    `ambiguous, ask before guessing.`
  )
}

/**
 * CRUD over the persisted feature list plus the one orchestration action,
 * `implement`, which spins off a worktree task session to build a feature's
 * specs. Features are pure data; the worktree/PTY work is delegated to
 * SessionManager (mirrors how SentinelService leans on it).
 */
export class FeatureService {
  constructor(
    private persistence: Persistence,
    private sessions: SessionManager
  ) {}

  private get features(): Feature[] {
    return this.persistence.state.features
  }

  /** Features for one session, oldest first (creation order). */
  list(sessionId: string): Feature[] {
    return this.features
      .filter((f) => f.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * The feature a worktree task session was spun off to implement, or null when
   * the session isn't tied to one. Lets the UI surface a session's feature/specs
   * from the task side (the feature itself belongs to the parent session).
   */
  forTask(taskSessionId: string): Feature | null {
    return this.features.find((f) => f.taskSessionId === taskSessionId) ?? null
  }

  /** Create or update one feature (upsert by id). */
  save(feature: Feature): void {
    const list = this.features
    const idx = list.findIndex((f) => f.id === feature.id)
    if (idx >= 0) list[idx] = feature
    else list.push(feature)
    this.persistence.scheduleSave()
  }

  delete(id: string): void {
    this.persistence.state.features = this.features.filter((f) => f.id !== id)
    this.persistence.scheduleSave()
  }

  /**
   * Spin off a worktree task session that implements `featureId`'s specs:
   * create the worktree (branch `feature/<slug>`), write the spec file into it
   * so claude can read it, and auto-submit a prompt pointing claude at the file.
   * Links the feature to the spawned session and flips it to 'implementing'.
   * Throws (with git's message) if the parent isn't a repo or the worktree fails.
   * `baseBranch` overrides which branch the task forks from and merges back
   * into (used by auto-expand to keep its growth on a dedicated branch);
   * `model` pins the task claude's model (used by the Conductor's approval card).
   */
  async implement(
    featureId: string,
    baseBranch?: string,
    model?: 'opus' | 'sonnet' | 'haiku'
  ): Promise<SessionInfo> {
    const feature = this.features.find((f) => f.id === featureId)
    if (!feature) throw new Error('Unknown feature')
    const parent = this.sessions.getConfig(feature.sessionId)
    if (!parent) throw new Error('The feature’s session no longer exists.')

    const info = await this.sessions.getWorktreeInfo(feature.sessionId)
    if (!info.isRepo) throw new Error('This feature’s folder is not a git repository.')

    const branch = `feature/${slugify(feature.title)}`
    const session = await this.sessions.createWorktreeSession(feature.sessionId, {
      name: feature.title,
      branch,
      baseBranch: baseBranch ?? info.branch ?? 'HEAD',
      initialPrompt: implementPrompt(feature),
      // Carry the feature's PR/merge preference onto the implementing task.
      completion: feature.completion,
      autoComplete: feature.autoComplete,
      model
    })

    // The worktree folder exists once createWorktreeSession resolves; the prompt
    // is auto-submitted a few seconds later, so writing the spec file now ensures
    // it is on disk well before claude reads it.
    try {
      const specAbs = join(session.config.folder, specRelPath(feature))
      mkdirSync(join(session.config.folder, '.maestro', 'specs'), { recursive: true })
      writeFileSync(specAbs, specMarkdown(feature), 'utf8')
    } catch (err) {
      console.error('Failed to write feature spec file:', err)
    }

    feature.taskSessionId = session.config.id
    feature.status = 'implementing'
    this.save(feature)
    return session
  }
}
