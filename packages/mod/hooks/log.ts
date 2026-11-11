import type { EngineInterface } from 'claude-code'

const logged = new Set<string>()

export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Logs `text` the first time `key` is seen in this module instance. */
export function logOnce($: EngineInterface, key: string, text: string): void {
  if (logged.has(key)) return
  logged.add(key)
  $.ui.log(`session-review: ${text}`)
}

export function log($: EngineInterface, text: string): void {
  $.ui.log(`session-review: ${text}`)
}
