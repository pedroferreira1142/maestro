import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { CreateWorktreeOpts } from '../shared/api'
import {
  ConductorImage,
  ConductorTaskOptions,
  FactoryArtifactKind,
  Feature,
  RepoCategory,
  ReusableAction,
  SessionConfig,
  Settings,
  TerminalConfig,
  TerminalKind,
  TokenEfficiencyConfig,
  TokenEfficiencyOverride,
  TranscriptExportResult
} from '../shared/types'
import {
  attachClipboardImage,
  attachImageData,
  attachImageFile,
  deleteAttachment,
  listAttachments,
  readAttachment
} from './Attachments'
import { AgentRegistryService } from './AgentRegistryService'
import { AutoExpandService } from './AutoExpand'
import { clearBackgroundImage, readBackgroundImage, saveBackgroundImage } from './Background'
import { ConductorService } from './ConductorService'
import { detectCategory, readUserMcpServers, scanSkills } from './ClaudeEnv'
import { FactoryService } from './FactoryService'
import { FeatureService } from './FeatureService'
import { FsService, resolveSafe } from './FsService'
import { Persistence } from './Persistence'
import { SentinelService } from './Sentinels'
import { SessionManager } from './SessionManager'
import { TokenEfficiencyService } from './TokenEfficiency'
import { UsageLimitsService } from './UsageLimits'
import { UsageService } from './UsageService'

/** Attachment scope (folder name) for images pasted into the Conductor chat. */
const CONDUCTOR_ATTACH_SCOPE = 'conductor'

/** Tokenize a command template respecting double quotes. */
function tokenize(template: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template))) tokens.push(m[1] ?? m[2])
  return tokens
}

export function registerIpc(
  sessions: SessionManager,
  fs: FsService,
  persistence: Persistence,
  sentinels: SentinelService,
  features: FeatureService,
  autoExpand: AutoExpandService,
  conductor: ConductorService,
  factory: FactoryService,
  agents: AgentRegistryService,
  tokenEff: TokenEfficiencyService,
  getWin: () => BrowserWindow | null
): void {
  const rootOf = (id: string): string => {
    const config = sessions.getConfig(id)
    if (!config) throw new Error(`Unknown session: ${id}`)
    return config.folder
  }

  // --- sessions ---
  ipcMain.handle('session:create', (_e, folder: string, opts?: Partial<SessionConfig>) =>
    sessions.create(folder, opts)
  )
  ipcMain.handle('session:close', (_e, id: string) => sessions.close(id))
  ipcMain.handle('session:update', (_e, id: string, patch: Partial<SessionConfig>) =>
    sessions.update(id, patch)
  )
  ipcMain.handle('session:list', () => sessions.list())
  ipcMain.handle('session:setActive', (_e, id: string | null) => sessions.setActive(id))
  ipcMain.handle('session:getActive', () => persistence.state.activeSessionId)

  // --- parallel tasks (git worktrees) ---
  ipcMain.handle('worktree:info', (_e, sessionId: string) => sessions.getWorktreeInfo(sessionId))
  ipcMain.handle('worktree:create', (_e, parentSessionId: string, opts: CreateWorktreeOpts) =>
    sessions.createWorktreeSession(parentSessionId, opts)
  )
  ipcMain.handle('worktree:state', (_e, sessionId: string) =>
    sessions.getWorktreeTaskState(sessionId)
  )
  ipcMain.handle('worktree:merge', (_e, sessionId: string, commitFirst: boolean) =>
    sessions.mergeWorktree(sessionId, commitFirst)
  )
  ipcMain.handle('worktree:mergeResolve', (_e, sessionId: string) =>
    sessions.startConflictedMerge(sessionId)
  )
  ipcMain.handle('worktree:createPr', (_e, sessionId: string, commitFirst: boolean) =>
    sessions.createWorktreePr(sessionId, commitFirst)
  )
  ipcMain.handle('worktree:remove', (_e, sessionId: string, deleteBranch: boolean) =>
    sessions.removeWorktree(sessionId, deleteBranch)
  )

  // --- git (status + history for the session's repo) ---
  ipcMain.handle('git:status', (_e, sessionId: string) => sessions.getGitStatus(sessionId))
  ipcMain.handle('git:log', (_e, sessionId: string, limit?: number) =>
    sessions.getGitLog(sessionId, limit)
  )
  ipcMain.handle('git:init', (_e, sessionId: string) => sessions.initRepo(sessionId))
  ipcMain.handle('git:changedFiles', (_e, sessionId: string) =>
    sessions.getGitChangedFiles(sessionId)
  )
  ipcMain.handle('git:fileDiff', (_e, sessionId: string, path: string) =>
    sessions.getGitFileDiff(sessionId, path)
  )
  ipcMain.handle('git:branches', (_e, sessionId: string) => sessions.listBranches(sessionId))

  // --- repo checkpoints (working-tree safety net) ---
  ipcMain.handle('checkpoint:create', (_e, sessionId: string, label: string) =>
    sessions.createCheckpoint(sessionId, label)
  )
  ipcMain.handle('checkpoint:list', (_e, sessionId: string) =>
    sessions.listCheckpoints(sessionId)
  )
  ipcMain.handle('checkpoint:restore', (_e, sessionId: string, id: string) =>
    sessions.restoreCheckpoint(sessionId, id)
  )
  ipcMain.handle('checkpoint:delete', (_e, sessionId: string, id: string) =>
    sessions.deleteCheckpoint(sessionId, id)
  )

  // --- terminals (within a session's folder) ---
  ipcMain.handle('terminal:add', (_e, sessionId: string, kind: TerminalKind) =>
    sessions.addTerminal(sessionId, kind)
  )
  ipcMain.handle('terminal:close', (_e, sessionId: string, terminalId: string) =>
    sessions.closeTerminal(sessionId, terminalId)
  )
  ipcMain.handle('terminal:restart', (_e, terminalId: string, mode: 'fresh' | 'resume') =>
    sessions.restartTerminal(terminalId, mode)
  )
  ipcMain.handle('terminal:update', (_e, terminalId: string, patch: Partial<TerminalConfig>) =>
    sessions.updateTerminal(terminalId, patch)
  )
  ipcMain.handle('terminal:setActive', (_e, sessionId: string, terminalId: string) =>
    sessions.setActiveTerminal(sessionId, terminalId)
  )

  // --- prompt queue (auto-sent to claude when the terminal sits idle) ---
  ipcMain.handle('queue:add', (_e, sessionId: string, text: string) =>
    sessions.queueAdd(sessionId, text)
  )
  ipcMain.handle('queue:remove', (_e, sessionId: string, itemId: string) =>
    sessions.queueRemove(sessionId, itemId)
  )
  ipcMain.handle('queue:move', (_e, sessionId: string, itemId: string, delta: -1 | 1) =>
    sessions.queueMove(sessionId, itemId, delta)
  )

  // --- repo categories (context profiles) ---
  ipcMain.handle('categories:list', () => sessions.categories)
  ipcMain.handle('categories:save', (_e, categories: RepoCategory[]) =>
    sessions.saveCategories(categories)
  )
  ipcMain.handle('session:setCategory', (_e, sessionId: string, categoryId: string | null) =>
    sessions.setSessionCategory(sessionId, categoryId)
  )
  ipcMain.handle('session:setEnv', (_e, sessionId: string, env: Record<string, string>) =>
    sessions.setSessionEnv(sessionId, env)
  )
  ipcMain.handle('claude:listSkills', () => scanSkills())
  ipcMain.handle('claude:listMcpServers', () => readUserMcpServers())
  ipcMain.handle('category:detect', (_e, folder: string) =>
    detectCategory(folder, sessions.categories)
  )

  // --- sentinels (background watcher agents) ---
  ipcMain.handle('sentinel:runs', (_e, sessionId: string) => sentinels.listRuns(sessionId))
  ipcMain.handle('sentinel:run', (_e, sessionId: string, sentinelId: string) =>
    sentinels.runNow(sessionId, sentinelId)
  )

  // --- features & specs ---
  ipcMain.handle('feature:list', (_e, sessionId: string) => features.list(sessionId))
  ipcMain.handle('feature:forTask', (_e, sessionId: string) => features.forTask(sessionId))
  ipcMain.handle('feature:save', (_e, feature: Feature) => features.save(feature))
  ipcMain.handle('feature:delete', (_e, id: string) => features.delete(id))
  ipcMain.handle('feature:implement', (_e, id: string) => features.implement(id))

  // --- auto-expand (self-expanding features pipeline) ---
  ipcMain.handle('autoexpand:runs', (_e, sessionId: string) => autoExpand.listRuns(sessionId))
  ipcMain.handle('autoexpand:run', (_e, sessionId: string) => autoExpand.runNow(sessionId))
  ipcMain.handle('autoexpand:ensureBranch', (_e, sessionId: string) =>
    autoExpand.prepareBranch(sessionId)
  )

  // --- conductor (app-level AI chat over all sessions) ---
  ipcMain.handle('conductor:list', () => conductor.list())
  ipcMain.handle(
    'conductor:send',
    (_e, text: string, tagSessionId?: string | null, images?: ConductorImage[]) =>
      conductor.send(text, tagSessionId ?? null, images ?? [])
  )
  ipcMain.handle(
    'conductor:approve',
    (_e, messageId: string, actionId: string, options?: ConductorTaskOptions) =>
      conductor.approve(messageId, actionId, options)
  )
  ipcMain.handle('conductor:approveAll', (_e, messageId: string) =>
    conductor.approveAll(messageId)
  )
  ipcMain.handle('conductor:reject', (_e, messageId: string, actionId: string) =>
    conductor.reject(messageId, actionId)
  )
  ipcMain.handle('conductor:clear', () => conductor.clear())
  ipcMain.handle('conductor:taskDefaults', (_e, sessionId: string) =>
    conductor.getTaskDefaults(sessionId)
  )
  // Conductor chat image attachments. They live under their own fixed scope
  // ('conductor', a name UUID session ids can never collide with) inside the
  // same userData/attachments root the per-session chat images use.
  ipcMain.handle('conductor:attachClipboard', () => attachClipboardImage(CONDUCTOR_ATTACH_SCOPE))
  ipcMain.handle('conductor:attachFile', (_e, srcPath: string) =>
    attachImageFile(CONDUCTOR_ATTACH_SCOPE, srcPath)
  )
  ipcMain.handle('conductor:attachData', (_e, name: string, bytes: Uint8Array) =>
    attachImageData(CONDUCTOR_ATTACH_SCOPE, name, bytes)
  )
  ipcMain.handle('conductor:attachDelete', (_e, fileName: string) =>
    deleteAttachment(CONDUCTOR_ATTACH_SCOPE, fileName)
  )

  // --- agent & skill factory (generate skills/agents from MCP sources) ---
  ipcMain.handle('factory:listSources', (_e, refresh?: boolean) => factory.listSources(refresh))
  ipcMain.handle('factory:state', () => factory.getState())
  ipcMain.handle('factory:runs', () => factory.listRuns())
  ipcMain.handle('factory:isBusy', () => factory.isBusy())
  ipcMain.handle('factory:scan', (_e, serverKey: string, guidance: string) =>
    factory.scan(serverKey, guidance)
  )
  ipcMain.handle('factory:approve', (_e, runId: string, candidateId: string) =>
    factory.approve(runId, candidateId)
  )
  ipcMain.handle('factory:approveAll', (_e, runId: string) => factory.approveAll(runId))
  ipcMain.handle('factory:reject', (_e, runId: string, candidateId: string) =>
    factory.reject(runId, candidateId)
  )
  ipcMain.handle('factory:cancel', () => factory.cancel())
  ipcMain.handle('factory:clearRuns', () => factory.clearRuns())
  ipcMain.handle('factory:deleteArtifact', (_e, id: string) => factory.deleteArtifact(id))
  ipcMain.handle('factory:unregisterArtifact', (_e, id: string) => factory.unregister(id))
  ipcMain.handle('factory:readArtifact', (_e, id: string) => factory.readArtifact(id))
  ipcMain.handle('factory:revealArtifact', (_e, id: string) => factory.revealArtifact(id))
  ipcMain.handle('factory:audit', () => factory.audit())
  ipcMain.handle('factory:adopt', (_e, kind: FactoryArtifactKind, name: string) =>
    factory.adopt(kind, name)
  )
  ipcMain.handle('factory:promoteTopic', (_e, id: string) => factory.promoteTopic(id))
  ipcMain.handle('factory:dismissTopic', (_e, id: string) => factory.dismissTopic(id))
  ipcMain.handle('factory:addLesson', (_e, text: string) => factory.addLesson(text))
  ipcMain.handle('factory:deleteLesson', (_e, id: string) => factory.deleteLesson(id))
  // self-growth suggestions
  ipcMain.handle('factory:createFromSuggestion', (_e, id: string, kind?: FactoryArtifactKind) =>
    factory.createFromSuggestion(id, kind)
  )
  ipcMain.handle('factory:dismissSuggestion', (_e, id: string) => factory.dismissSuggestion(id))

  // --- installed agents + external agent-factory registry (Factory → Agents tab) ---
  ipcMain.handle('agents:get', () => agents.snapshot())
  ipcMain.handle('agents:refresh', () => agents.refresh())
  ipcMain.handle('agents:read', (_e, filePath: string) => agents.readAgentFile(filePath))
  ipcMain.handle('agents:reveal', (_e, filePath: string) => agents.revealAgentFile(filePath))

  // --- reusable actions (saved shell commands) ---
  ipcMain.handle('actions:list', () => sessions.actions)
  ipcMain.handle('actions:save', (_e, actions: ReusableAction[]) => sessions.saveActions(actions))
  ipcMain.handle('actions:run', (_e, sessionId: string, actionId: string) =>
    sessions.runAction(sessionId, actionId)
  )

  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWin()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // --- custom app background image ---
  ipcMain.handle('background:pick', async () => {
    const win = getWin()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const fileName = await saveBackgroundImage(result.filePaths[0])
    if (!fileName) return null
    persistence.state.settings.backgroundImage = fileName
    persistence.scheduleSave()
    return readBackgroundImage(fileName)
  })
  ipcMain.handle('background:get', () =>
    readBackgroundImage(persistence.state.settings.backgroundImage)
  )
  ipcMain.handle('background:clear', async () => {
    await clearBackgroundImage()
    persistence.state.settings.backgroundImage = null
    persistence.scheduleSave()
  })

  // --- terminal data plane ---
  ipcMain.on('pty:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) =>
    sessions.resize(id, cols, rows)
  )
  ipcMain.handle('pty:attach', (_e, id: string) => sessions.attach(id))

  // --- filesystem ---
  ipcMain.handle('fs:readDir', (_e, id: string, relPath: string) =>
    fs.readDir(rootOf(id), relPath)
  )
  ipcMain.handle('fs:readFile', (_e, id: string, relPath: string) =>
    fs.readFile(rootOf(id), relPath)
  )
  ipcMain.handle('fs:watch', (_e, id: string, relPath: string) => {
    rootOf(id) // validates session exists
    fs.watchPath(id, relPath)
  })
  ipcMain.handle('fs:unwatch', (_e, id: string, relPath: string) => {
    rootOf(id)
    fs.unwatchPath(id, relPath)
  })
  ipcMain.handle('fs:openInEditor', (_e, id: string, relPath: string) => {
    const root = rootOf(id)
    const abs = resolveSafe(root, relPath)
    const template = persistence.state.settings.editorCommand
    const tokens = tokenize(template).map((t) =>
      t.replace(/\$\{path\}/g, abs).replace(/\$\{dir\}/g, dirname(abs))
    )
    if (tokens.length === 0) return
    // shell:true because editors on Windows are usually .cmd shims (code.cmd)
    const quoted = tokens.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ')
    spawn(quoted, { shell: true, detached: true, stdio: 'ignore' }).unref()
  })
  ipcMain.handle('fs:reveal', (_e, id: string, relPath: string) => {
    shell.showItemInFolder(resolveSafe(rootOf(id), relPath))
  })

  // --- chat image attachments ---
  ipcMain.handle('attachments:clipboard', (_e, id: string) => {
    rootOf(id) // validates session exists
    return attachClipboardImage(id)
  })
  ipcMain.handle('attachments:file', (_e, id: string, srcPath: string) => {
    rootOf(id)
    return attachImageFile(id, srcPath)
  })
  ipcMain.handle('attachments:data', (_e, id: string, name: string, bytes: Uint8Array) => {
    rootOf(id)
    return attachImageData(id, name, bytes)
  })
  ipcMain.handle('attachments:list', (_e, id: string) => listAttachments(id))
  ipcMain.handle('attachments:read', (_e, id: string, fileName: string) =>
    readAttachment(id, fileName)
  )
  ipcMain.handle('attachments:delete', (_e, id: string, fileName: string) =>
    deleteAttachment(id, fileName)
  )
  // --- token efficiency (token-saving toolkit + settings page) ---
  ipcMain.handle('tokenEff:status', (_e, sessionId: string) => tokenEff.status(sessionId))
  ipcMain.handle('tokenEff:saveGlobal', (_e, config: TokenEfficiencyConfig) => {
    tokenEff.saveGlobal(config)
    getWin()?.webContents.send('session:changed')
  })
  ipcMain.handle(
    'tokenEff:setRepoOverride',
    (_e, sessionId: string, override: TokenEfficiencyOverride | null) => {
      tokenEff.setRepoOverride(sessionId, override)
      getWin()?.webContents.send('session:changed')
    }
  )
  ipcMain.handle(
    'tokenEff:setSessionOverride',
    (_e, sessionId: string, override: TokenEfficiencyOverride | null) => {
      tokenEff.setSessionOverride(sessionId, override)
      getWin()?.webContents.send('session:changed')
    }
  )
  ipcMain.handle('tokenEff:refreshRepoMap', (_e, sessionId: string) =>
    tokenEff.refreshRepoMap(sessionId)
  )
  ipcMain.handle('tokenEff:detectTools', (_e, refresh?: boolean) =>
    tokenEff.detectTools(refresh ?? false)
  )

  // --- usage (token cost parsed from ~/.claude/projects transcripts) ---
  const usage = new UsageService()
  ipcMain.handle('usage:get', () => usage.snapshot())
  // Subscription plan limits (the figures Claude Code's `/usage` shows).
  const usageLimits = new UsageLimitsService()
  ipcMain.handle('usage:limits', () => usageLimits.limits())

  // --- transcript export (save dialog + file write, on the renderer's behalf) ---
  ipcMain.handle(
    'transcript:export',
    async (
      _e,
      sessionId: string,
      fileName: string,
      content: string
    ): Promise<TranscriptExportResult> => {
      const win = getWin()
      if (!win) return { canceled: true }
      const result = await dialog.showSaveDialog(win, {
        title: 'Export transcript',
        defaultPath: join(rootOf(sessionId), fileName),
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      try {
        await writeFile(result.filePath, content, 'utf8')
        return { canceled: false, path: result.filePath }
      } catch (err) {
        return { canceled: false, error: (err as Error).message }
      }
    }
  )

  // --- misc ---
  ipcMain.on('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle('settings:get', () => persistence.state.settings)
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    Object.assign(persistence.state.settings, patch)
    persistence.scheduleSave()
    getWin()?.webContents.send('session:changed')
    // The agents view depends on the registry path — re-snapshot + re-arm watchers.
    if (patch.agentRegistryPath !== undefined) agents.refresh()
  })
}
