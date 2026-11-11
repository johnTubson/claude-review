// Messages between the extension host and the diff worker, validated with zod
// on both sides (§7.5.2).

import { z } from 'zod'

import type { HunkView } from '@core/view'

const lineSchema = z.object({ op: z.enum([' ', '-', '+']), text: z.string() })
const hunkSchema = z.object({
  oldIdx: z.number().int(),
  oldLen: z.number().int(),
  newIdx: z.number().int(),
  newLen: z.number().int(),
  lines: z.array(lineSchema),
})
const hunkViewSchema = z.object({
  index: z.number().int(),
  hunk: hunkSchema,
  startLine: z.number().int(),
  endLine: z.number().int(),
  added: z.array(z.number().int()),
  removed: z.array(z.object({ line: z.number().int(), text: z.array(z.string()) })),
  sig: z.string(),
})

export const requestSchema = z.object({
  t: z.literal('diff'),
  id: z.number().int(),
  /** Identifies `base` across requests: `${ledgerDir}|${ref}`, or '' for a text sent every time. */
  baseKey: z.string(),
  base: z.string().optional(),
  live: z.string(),
})
export type DiffRequest = z.infer<typeof requestSchema>

export const responseSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ok'), id: z.number().int(), hunks: z.array(hunkViewSchema), added: z.number().int(), removed: z.number().int(), lineCount: z.number().int(), layout: z.string() }),
  z.object({ t: z.literal('needBase'), id: z.number().int() }),
  z.object({ t: z.literal('err'), id: z.number().int(), message: z.string() }),
])
export type DiffResponse = z.infer<typeof responseSchema>
export type DiffOutput = {
  readonly hunks: readonly HunkView[]
  readonly added: number
  readonly removed: number
  readonly lineCount: number
  readonly layout: string
}

/** What the worker posts: a DiffResponse, typed from core so its readonly hunks need no copy. */
export type WorkerResponse =
  | ({ readonly t: 'ok'; readonly id: number } & DiffOutput)
  | { readonly t: 'needBase'; readonly id: number }
  | { readonly t: 'err'; readonly id: number; readonly message: string }
