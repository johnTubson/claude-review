// The live text of a tracked file: the open document when there is one, else
// the file on disk. Probing gives the size and version without reading the
// text, so a file over the limit is never read (§7.5.1).

import type { LineEdit } from '@core/plan'

import type { LiveVersion } from './model'

export type { LineEdit }

export type LiveProbe = {
  readonly version: LiveVersion
  /** UTF-16 code units for an open document, bytes on disk; 0 when missing. */
  readonly size: number
  /** The text, read now and not kept: null when the file does not exist. */
  readonly read: () => Promise<string | null>
}

export type LiveTexts = {
  probe(path: string): Promise<LiveProbe>
}

/** What actions write through: one undoable edit, then saves (VS Code), or a fake in tests. */
export type LiveEdit =
  | { readonly kind: 'lines'; readonly path: string; readonly edits: readonly LineEdit[] }
  | { readonly kind: 'create'; readonly path: string; readonly text: string }
  | { readonly kind: 'delete'; readonly path: string }

export type LiveWriter = {
  /** Applies every edit as one undo step and saves the touched files. */
  apply(edits: readonly LiveEdit[]): Promise<void>
}
