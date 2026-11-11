export type FileRow = { path: string; rel: string; added: number; removed: number; status: 'new' | 'deleted' | 'modified'; ledger: string }
export type TurnRow = { key: string; n: number; prompt: string; session: string; paths: string[] }
export type SessionRow = { id: string; n: number; title: string; turnKeys: string[] }
export type Summary = { files: FileRow[]; turns: TurnRow[]; sessions: SessionRow[]; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'session-review': { summary: Summary; selected: string | null; page: number; currentTurn: { id: string; prompt: string } | null }
  }
}
