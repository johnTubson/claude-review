// followEdits: 'openDiff' — each file Claude edits opens in its review diff as
// a preview tab, without taking focus.

import * as vscode from 'vscode'

import type { Ledger } from '@core/ledger'

import type { ReviewModel } from '../review/model'
import { openDiff } from './diffEditors'

/** Paths whose newest change (its last entry's `after`) moved between two folds. */
export const editedPaths = (previous: Ledger, current: Ledger): string[] => {
  const out: string[] = []
  for (const [p, record] of current.files) {
    const before = previous.files.get(p)
    if (before === record) continue
    const lastAfter = (r: typeof record | undefined): string | null | undefined => r?.entries[r.entries.length - 1]?.after
    if (lastAfter(before) !== lastAfter(record) || (before?.entries.length ?? 0) !== record.entries.length) out.push(p)
  }
  return out
}

export const follow = async (model: ReviewModel, paths: readonly string[]): Promise<void> => {
  for (const p of paths) await openDiff(model, vscode.Uri.file(p), undefined, { preview: true, preserveFocus: true })
}
