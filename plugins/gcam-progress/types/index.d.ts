export type Row = {
  kind: 'running' | 'starting' | 'valid' | 'invalid' | 'aborted' | 'queued'
  run: string
  lane: string
  thr: string
  cpu?: string
  unsolved: string[]
  nUnsolved: number
  endedAgo?: number
  period: string
  iters: string
  itersBand?: string
  elapsed: string
  eta?: string
  startAt?: number
  verdict?: string
  status: string
}
export type Snapshot = {
  at: string
  rows: Row[]
  note: string
}
// What the plugin remembers about the run it last saw in an exe folder (key: the folder).
export type SeenRun = {
  run: string
  startAt: number
  procStart: number
  thr: string
  cpu?: string
  lastSeen: number
  cur?: string
  curAt?: number
  curFull?: boolean
  durs?: number[]
  cwd?: string // the run's folder
  log?: string // main_log's path when the log configuration names another file than logs/main_log.txt
}
export type Seen = Record<string, SeenRun>

declare module 'claude-code' {
  interface PluginState {
    'gcam-progress': { snap: Shaped<Snapshot>; seen: Shaped<Seen>; tick: Shaped<number> }
  }
}
