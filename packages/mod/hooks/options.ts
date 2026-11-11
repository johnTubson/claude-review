import type { PluginOptions } from 'claude-code'

export type Options = {
  readonly bash: boolean
  readonly band: boolean
  readonly maxBashFiles: number
  readonly maxFileBytes: number
  readonly maxSnapshotCandidates: number
  readonly dataDir: string
  readonly debugTimings: boolean
}

export const DEFAULT_OPTIONS: Options = {
  bash: true,
  band: true,
  maxBashFiles: 200,
  maxFileBytes: 2_097_152,
  maxSnapshotCandidates: 2000,
  dataDir: '',
  debugTimings: false,
}

const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const count = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : fallback)

/** The engine validates userConfig against the manifest; this narrows the loose record to what that promised. */
export const parseOptions = (raw: PluginOptions): Options => ({
  bash: bool(raw.bash, DEFAULT_OPTIONS.bash),
  band: bool(raw.band, DEFAULT_OPTIONS.band),
  maxBashFiles: count(raw.maxBashFiles, DEFAULT_OPTIONS.maxBashFiles),
  maxFileBytes: count(raw.maxFileBytes, DEFAULT_OPTIONS.maxFileBytes),
  maxSnapshotCandidates: count(raw.maxSnapshotCandidates, DEFAULT_OPTIONS.maxSnapshotCandidates),
  dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : DEFAULT_OPTIONS.dataDir,
  debugTimings: bool(raw.debugTimings, DEFAULT_OPTIONS.debugTimings),
})
