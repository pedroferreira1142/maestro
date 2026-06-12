import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import type { Api, CreateWorktreeOpts, Unsubscribe } from '../shared/api'
import type {
  AutoExpandRun,
  ConductorMessage,
  Feature,
  FsEvent,
  RepoCategory,
  ReusableAction,
  SentinelRun,
  SessionConfig,
  SessionStatus,
  Settings,
  TerminalConfig
} from '../shared/types'

function subscribe(
  channel: string,
  handler: (...args: unknown[]) => void
): Unsubscribe {
  const wrapped = (_e: IpcRendererEvent, ...args: unknown[]): void => handler(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: Api = {
  platform: process.platform,

  createSession: (folder, opts?) => ipcRenderer.invoke('session:create', folder, opts),
  closeSession: (id) => ipcRenderer.invoke('session:close', id),
  updateSession: (id, patch: Partial<SessionConfig>) =>
    ipcRenderer.invoke('session:update', id, patch),
  listSessions: () => ipcRenderer.invoke('session:list'),
  setActiveSession: (id) => ipcRenderer.invoke('session:setActive', id),
  getActiveSession: () => ipcRenderer.invoke('session:getActive'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),

  worktreeInfo: (sessionId) => ipcRenderer.invoke('worktree:info', sessionId),
  createWorktree: (parentSessionId, opts: CreateWorktreeOpts) =>
    ipcRenderer.invoke('worktree:create', parentSessionId, opts),
  worktreeState: (sessionId) => ipcRenderer.invoke('worktree:state', sessionId),
  mergeWorktree: (sessionId, commitFirst) =>
    ipcRenderer.invoke('worktree:merge', sessionId, commitFirst),
  startConflictedMerge: (sessionId) => ipcRenderer.invoke('worktree:mergeResolve', sessionId),
  removeWorktree: (sessionId, deleteBranch) =>
    ipcRenderer.invoke('worktree:remove', sessionId, deleteBranch),

  gitStatus: (sessionId) => ipcRenderer.invoke('git:status', sessionId),
  gitLog: (sessionId, limit) => ipcRenderer.invoke('git:log', sessionId, limit),
  gitInit: (sessionId) => ipcRenderer.invoke('git:init', sessionId),
  gitChangedFiles: (sessionId) => ipcRenderer.invoke('git:changedFiles', sessionId),
  gitFileDiff: (sessionId, path) => ipcRenderer.invoke('git:fileDiff', sessionId, path),

  addTerminal: (sessionId, kind) => ipcRenderer.invoke('terminal:add', sessionId, kind),
  closeTerminal: (sessionId, terminalId) =>
    ipcRenderer.invoke('terminal:close', sessionId, terminalId),
  restartTerminal: (terminalId, mode) =>
    ipcRenderer.invoke('terminal:restart', terminalId, mode),
  updateTerminal: (terminalId, patch: Partial<TerminalConfig>) =>
    ipcRenderer.invoke('terminal:update', terminalId, patch),
  setActiveTerminal: (sessionId, terminalId) =>
    ipcRenderer.invoke('terminal:setActive', sessionId, terminalId),

  ptyWrite: (terminalId, data) => ipcRenderer.send('pty:write', terminalId, data),
  ptyResize: (terminalId, cols, rows) => ipcRenderer.send('pty:resize', terminalId, cols, rows),
  ptyAttach: (terminalId) => ipcRenderer.invoke('pty:attach', terminalId),
  onPtyData: (cb) =>
    subscribe('pty:data', (id, data) => cb(id as string, data as string)),

  listAutoExpandRuns: (sessionId) => ipcRenderer.invoke('autoexpand:runs', sessionId),
  runAutoExpand: (sessionId) => ipcRenderer.invoke('autoexpand:run', sessionId),
  onAutoExpandRuns: (cb) =>
    subscribe('autoexpand:runs', (id, runs) => cb(id as string, runs as AutoExpandRun[])),

  listSentinelRuns: (sessionId) => ipcRenderer.invoke('sentinel:runs', sessionId),
  runSentinel: (sessionId, sentinelId) => ipcRenderer.invoke('sentinel:run', sessionId, sentinelId),
  onSentinelRuns: (cb) =>
    subscribe('sentinel:runs', (id, runs) => cb(id as string, runs as SentinelRun[])),

  listConductor: () => ipcRenderer.invoke('conductor:list'),
  sendConductor: (text) => ipcRenderer.invoke('conductor:send', text),
  approveConductorAction: (messageId, actionId) =>
    ipcRenderer.invoke('conductor:approve', messageId, actionId),
  approveAllConductorActions: (messageId) =>
    ipcRenderer.invoke('conductor:approveAll', messageId),
  rejectConductorAction: (messageId, actionId) =>
    ipcRenderer.invoke('conductor:reject', messageId, actionId),
  clearConductor: () => ipcRenderer.invoke('conductor:clear'),
  onConductorChanged: (cb) =>
    subscribe('conductor:changed', (msgs) => cb(msgs as ConductorMessage[])),

  listFeatures: (sessionId) => ipcRenderer.invoke('feature:list', sessionId),
  saveFeature: (feature: Feature) => ipcRenderer.invoke('feature:save', feature),
  deleteFeature: (id) => ipcRenderer.invoke('feature:delete', id),
  implementFeature: (id) => ipcRenderer.invoke('feature:implement', id),

  listActions: () => ipcRenderer.invoke('actions:list'),
  saveActions: (actions: ReusableAction[]) => ipcRenderer.invoke('actions:save', actions),
  runAction: (sessionId, actionId) => ipcRenderer.invoke('actions:run', sessionId, actionId),

  queueAdd: (sessionId, text) => ipcRenderer.invoke('queue:add', sessionId, text),
  queueRemove: (sessionId, itemId) => ipcRenderer.invoke('queue:remove', sessionId, itemId),
  queueMove: (sessionId, itemId, delta) =>
    ipcRenderer.invoke('queue:move', sessionId, itemId, delta),

  listCategories: () => ipcRenderer.invoke('categories:list'),
  saveCategories: (categories: RepoCategory[]) =>
    ipcRenderer.invoke('categories:save', categories),
  setSessionCategory: (sessionId, categoryId) =>
    ipcRenderer.invoke('session:setCategory', sessionId, categoryId),
  listClaudeSkills: () => ipcRenderer.invoke('claude:listSkills'),
  listUserMcpServers: () => ipcRenderer.invoke('claude:listMcpServers'),
  detectCategory: (folder) => ipcRenderer.invoke('category:detect', folder),

  onSessionsChanged: (cb) => subscribe('session:changed', () => cb()),
  onStatusChange: (cb) =>
    subscribe('session:status', (id, status) => cb(id as string, status as SessionStatus)),
  onFocusSession: (cb) =>
    subscribe('app:focus-session', (id, terminalId) =>
      cb(id as string, terminalId as string | undefined)
    ),

  readDir: (id, relPath) => ipcRenderer.invoke('fs:readDir', id, relPath),
  readFile: (id, relPath) => ipcRenderer.invoke('fs:readFile', id, relPath),
  watchPath: (id, relPath) => ipcRenderer.invoke('fs:watch', id, relPath),
  unwatchPath: (id, relPath) => ipcRenderer.invoke('fs:unwatch', id, relPath),
  onFsEvents: (cb) =>
    subscribe('fs:events', (id, events) => cb(id as string, events as FsEvent[])),
  openInEditor: (id, relPath) => ipcRenderer.invoke('fs:openInEditor', id, relPath),
  revealInExplorer: (id, relPath) => ipcRenderer.invoke('fs:reveal', id, relPath),

  attachClipboardImage: (sessionId) => ipcRenderer.invoke('attachments:clipboard', sessionId),
  attachImageFile: (sessionId, srcPath) =>
    ipcRenderer.invoke('attachments:file', sessionId, srcPath),
  attachImageData: (sessionId, name, bytes: Uint8Array) =>
    ipcRenderer.invoke('attachments:data', sessionId, name, bytes),
  listAttachments: (sessionId) => ipcRenderer.invoke('attachments:list', sessionId),
  readAttachment: (sessionId, fileName) =>
    ipcRenderer.invoke('attachments:read', sessionId, fileName),
  deleteAttachment: (sessionId, fileName) =>
    ipcRenderer.invoke('attachments:delete', sessionId, fileName),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  getUsage: () => ipcRenderer.invoke('usage:get'),

  pickBackgroundImage: () => ipcRenderer.invoke('background:pick'),
  getBackgroundImage: () => ipcRenderer.invoke('background:get'),
  clearBackgroundImage: () => ipcRenderer.invoke('background:clear'),

  exportTranscript: (sessionId, fileName, content) =>
    ipcRenderer.invoke('transcript:export', sessionId, fileName, content),

  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.send('clipboard:write', text),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:set', patch)
}

contextBridge.exposeInMainWorld('api', api)
