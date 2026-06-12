import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { CreateWorktreeOpts } from '../shared/api'
import {
  Feature,
  RepoCategory,
  ReusableAction,
  SessionConfig,
  Settings,
  TerminalConfig,
  TerminalKind,
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
import { AutoExpandService } from './AutoExpand'
import { clearBackgroundImage, readBackgroundImage, saveBackgroundImage } from './Background'
import { ConductorService } from './ConductorService'
import { detectCategory, readUserMcpServers, scanSkills } from './ClaudeEnv'
import { FeatureService } from './FeatureService'
import { FsService, resolveSafe } from './FsService'
import { Persistence } from './Persistence'
import { SentinelService } from './Sentinels'
import { SessionManager } from './SessionManager'
import { UsageLimitsService } from './UsageLimits'
import { UsageService } from './UsageService'

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
  ipcMain.handle('conductor:send', (_e, text: string, tagSessionId?: string | null) =>
    conductor.send(text, tagSessionId ?? null)
  )
  ipcMain.handle('conductor:approve', (_e, messageId: string, actionId: string) =>
    conductor.approve(messageId, actionId)
  )
  ipcMain.handle('conductor:approveAll', (_e, messageId: string) =>
    conductor.approveAll(messageId)
  )
  ipcMain.handle('conductor:reject', (_e, messageId: string, actionId: string) =>
    conductor.reject(messageId, actionId)
  )
  ipcMain.handle('conductor:clear', () => conductor.clear())

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
  })
}
