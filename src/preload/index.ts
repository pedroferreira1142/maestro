import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
import type { Api, CreateWorktreeOpts, Unsubscribe } from '../shared/api'
import type { GameCelebration, GameSnapshot } from '../shared/gamification'
import type {
  AgentsSnapshot,
  AutoExpandRun,
  ConductorImage,
  ConductorMessage,
  ConductorTaskOptions,
  FactoryRun,
  FactoryState,
  FactorySuggestion,
  Feature,
  FsEvent,
  RepoCategory,
  ReusableAction,
  SentinelRun,
  SessionConfig,
  SessionStatus,
  Settings,
  TerminalConfig,
  TokenEfficiencyConfig,
  TokenEfficiencyOverride,
  WorktreeAutoCompleteEvent
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
  createWorktreePr: (sessionId, commitFirst) =>
    ipcRenderer.invoke('worktree:createPr', sessionId, commitFirst),
  removeWorktree: (sessionId, deleteBranch) =>
    ipcRenderer.invoke('worktree:remove', sessionId, deleteBranch),
  onWorktreeAutoCompleted: (cb) =>
    subscribe('worktree:autocompleted', (id, result) =>
      cb(id as string, result as WorktreeAutoCompleteEvent)
    ),

  gitStatus: (sessionId) => ipcRenderer.invoke('git:status', sessionId),
  gitLog: (sessionId, limit) => ipcRenderer.invoke('git:log', sessionId, limit),
  gitInit: (sessionId) => ipcRenderer.invoke('git:init', sessionId),
  gitChangedFiles: (sessionId) => ipcRenderer.invoke('git:changedFiles', sessionId),
  gitFileDiff: (sessionId, path) => ipcRenderer.invoke('git:fileDiff', sessionId, path),
  gitBranches: (sessionId) => ipcRenderer.invoke('git:branches', sessionId),

  createCheckpoint: (sessionId, label) =>
    ipcRenderer.invoke('checkpoint:create', sessionId, label),
  listCheckpoints: (sessionId) => ipcRenderer.invoke('checkpoint:list', sessionId),
  restoreCheckpoint: (sessionId, id) =>
    ipcRenderer.invoke('checkpoint:restore', sessionId, id),
  deleteCheckpoint: (sessionId, id) => ipcRenderer.invoke('checkpoint:delete', sessionId, id),

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
  ensureAutoExpandBranch: (sessionId) =>
    ipcRenderer.invoke('autoexpand:ensureBranch', sessionId),
  onAutoExpandRuns: (cb) =>
    subscribe('autoexpand:runs', (id, runs) => cb(id as string, runs as AutoExpandRun[])),

  listSentinelRuns: (sessionId) => ipcRenderer.invoke('sentinel:runs', sessionId),
  runSentinel: (sessionId, sentinelId) => ipcRenderer.invoke('sentinel:run', sessionId, sentinelId),
  onSentinelRuns: (cb) =>
    subscribe('sentinel:runs', (id, runs) => cb(id as string, runs as SentinelRun[])),

  listConductor: () => ipcRenderer.invoke('conductor:list'),
  sendConductor: (text, tagSessionId, images?: ConductorImage[]) =>
    ipcRenderer.invoke('conductor:send', text, tagSessionId ?? null, images ?? []),
  approveConductorAction: (messageId, actionId, options?: ConductorTaskOptions) =>
    ipcRenderer.invoke('conductor:approve', messageId, actionId, options),
  approveAllConductorActions: (messageId) =>
    ipcRenderer.invoke('conductor:approveAll', messageId),
  rejectConductorAction: (messageId, actionId) =>
    ipcRenderer.invoke('conductor:reject', messageId, actionId),
  clearConductor: () => ipcRenderer.invoke('conductor:clear'),
  onConductorChanged: (cb) =>
    subscribe('conductor:changed', (msgs) => cb(msgs as ConductorMessage[])),
  conductorAttachClipboardImage: () => ipcRenderer.invoke('conductor:attachClipboard'),
  conductorAttachImageFile: (srcPath) => ipcRenderer.invoke('conductor:attachFile', srcPath),
  conductorAttachImageData: (name, bytes: Uint8Array) =>
    ipcRenderer.invoke('conductor:attachData', name, bytes),
  conductorDeleteAttachment: (fileName) => ipcRenderer.invoke('conductor:attachDelete', fileName),
  getConductorTaskDefaults: (sessionId) =>
    ipcRenderer.invoke('conductor:taskDefaults', sessionId),

  listFactorySources: (refresh) => ipcRenderer.invoke('factory:listSources', refresh),
  getFactoryState: () => ipcRenderer.invoke('factory:state'),
  listFactoryRuns: () => ipcRenderer.invoke('factory:runs'),
  scanFactory: (serverKey, guidance) => ipcRenderer.invoke('factory:scan', serverKey, guidance),
  approveFactoryCandidate: (runId, candidateId) =>
    ipcRenderer.invoke('factory:approve', runId, candidateId),
  approveAllFactoryCandidates: (runId) => ipcRenderer.invoke('factory:approveAll', runId),
  rejectFactoryCandidate: (runId, candidateId) =>
    ipcRenderer.invoke('factory:reject', runId, candidateId),
  cancelFactoryRun: () => ipcRenderer.invoke('factory:cancel'),
  clearFactoryRuns: () => ipcRenderer.invoke('factory:clearRuns'),
  deleteFactoryArtifact: (id) => ipcRenderer.invoke('factory:deleteArtifact', id),
  unregisterFactoryArtifact: (id) => ipcRenderer.invoke('factory:unregisterArtifact', id),
  readFactoryArtifact: (id) => ipcRenderer.invoke('factory:readArtifact', id),
  revealFactoryArtifact: (id) => ipcRenderer.invoke('factory:revealArtifact', id),
  auditFactory: () => ipcRenderer.invoke('factory:audit'),
  adoptFactoryArtifact: (kind, name) => ipcRenderer.invoke('factory:adopt', kind, name),
  promoteFactoryTopic: (id) => ipcRenderer.invoke('factory:promoteTopic', id),
  dismissFactoryTopic: (id) => ipcRenderer.invoke('factory:dismissTopic', id),
  addFactoryLesson: (text) => ipcRenderer.invoke('factory:addLesson', text),
  deleteFactoryLesson: (id) => ipcRenderer.invoke('factory:deleteLesson', id),
  createFromSuggestion: (id, kind) =>
    ipcRenderer.invoke('factory:createFromSuggestion', id, kind),
  dismissSuggestion: (id) => ipcRenderer.invoke('factory:dismissSuggestion', id),
  getFactoryBusy: () => ipcRenderer.invoke('factory:isBusy'),
  onFactoryChanged: (cb) =>
    subscribe('factory:changed', (state) => cb(state as FactoryState)),
  onFactoryRuns: (cb) => subscribe('factory:runs', (runs) => cb(runs as FactoryRun[])),
  onFactorySuggestion: (cb) =>
    subscribe('factory:suggestion', (s) => cb(s as FactorySuggestion)),
  onFactoryBusy: (cb) => subscribe('factory:busy', (b) => cb(Boolean(b))),

  getGameState: () => ipcRenderer.invoke('gamification:get'),
  onGamificationChanged: (cb) =>
    subscribe('gamification:changed', (snap) => cb(snap as GameSnapshot)),
  onGamificationCelebrate: (cb) =>
    subscribe('gamification:celebrate', (c) => cb(c as GameCelebration)),

  getInstalledAgents: () => ipcRenderer.invoke('agents:get'),
  refreshInstalledAgents: () => ipcRenderer.invoke('agents:refresh'),
  readInstalledAgent: (filePath) => ipcRenderer.invoke('agents:read', filePath),
  revealInstalledAgent: (filePath) => ipcRenderer.invoke('agents:reveal', filePath),
  onAgentsChanged: (cb) =>
    subscribe('agents:changed', (snapshot) => cb(snapshot as AgentsSnapshot)),

  listFeatures: (sessionId) => ipcRenderer.invoke('feature:list', sessionId),
  featureForTask: (sessionId) => ipcRenderer.invoke('feature:forTask', sessionId),
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
  setSessionEnv: (sessionId, env) => ipcRenderer.invoke('session:setEnv', sessionId, env),
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
  getTokenEfficiencyStatus: (sessionId) => ipcRenderer.invoke('tokenEff:status', sessionId),
  saveTokenEfficiency: (config: TokenEfficiencyConfig) =>
    ipcRenderer.invoke('tokenEff:saveGlobal', config),
  setTokenEfficiencyRepoOverride: (sessionId, override: TokenEfficiencyOverride | null) =>
    ipcRenderer.invoke('tokenEff:setRepoOverride', sessionId, override),
  setTokenEfficiencySessionOverride: (sessionId, override: TokenEfficiencyOverride | null) =>
    ipcRenderer.invoke('tokenEff:setSessionOverride', sessionId, override),
  refreshRepoMap: (sessionId) => ipcRenderer.invoke('tokenEff:refreshRepoMap', sessionId),
  detectEfficiencyTools: (refresh) => ipcRenderer.invoke('tokenEff:detectTools', refresh),

  getUsage: () => ipcRenderer.invoke('usage:get'),
  getUsageLimits: () => ipcRenderer.invoke('usage:limits'),
  listConversations: (folder) => ipcRenderer.invoke('conversations:list', folder),
  searchConversations: (query) => ipcRenderer.invoke('conversations:search', query),

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
