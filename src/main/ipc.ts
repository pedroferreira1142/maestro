import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { dirname } from 'path'
import type { CreateWorktreeOpts } from '../shared/api'
import { RepoCategory, SessionConfig, Settings, TerminalConfig, TerminalKind } from '../shared/types'
import { detectCategory, readUserMcpServers, scanSkills } from './ClaudeEnv'
import { FsService, resolveSafe } from './FsService'
import { Persistence } from './Persistence'
import { SessionManager } from './SessionManager'
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
  ipcMain.handle('worktree:remove', (_e, sessionId: string, deleteBranch: boolean) =>
    sessions.removeWorktree(sessionId, deleteBranch)
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

  // --- repo categories (context profiles) ---
  ipcMain.handle('categories:list', () => sessions.categories)
  ipcMain.handle('categories:save', (_e, categories: RepoCategory[]) =>
    sessions.saveCategories(categories)
  )
  ipcMain.handle('session:setCategory', (_e, sessionId: string, categoryId: string | null) =>
    sessions.setSessionCategory(sessionId, categoryId)
  )
  ipcMain.handle('claude:listSkills', () => scanSkills())
  ipcMain.handle('claude:listMcpServers', () => readUserMcpServers())
  ipcMain.handle('category:detect', (_e, folder: string) =>
    detectCategory(folder, sessions.categories)
  )

  ipcMain.handle('dialog:pickFolder', async () => {
    const win = getWin()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
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

  // --- usage (token cost parsed from ~/.claude/projects transcripts) ---
  const usage = new UsageService()
  ipcMain.handle('usage:get', () => usage.snapshot())

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
