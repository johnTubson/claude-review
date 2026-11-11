// The "Claude Review" output channel. Traces go out at trace level:
// "Developer: Set Log Level…" → Claude Review → Trace.

import * as vscode from 'vscode'

/** What the code below logs through; the data layer takes it without the vscode module. */
export type Log = {
  error(what: string, err: unknown): void
  warn(message: string): void
  info(message: string): void
  trace(message: string): void
}

export const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The channel is created on the first line logged: creating it costs activation time (E1). */
export const createLog = (): Log & vscode.Disposable => {
  let channel: vscode.LogOutputChannel | undefined
  const out = (): vscode.LogOutputChannel => (channel ??= vscode.window.createOutputChannel('Claude Review', { log: true }))
  return {
    error: (what, err) => out().error(`${what}: ${reasonOf(err)}`),
    warn: message => out().warn(message),
    info: message => out().info(message),
    trace: message => {
      if (channel?.logLevel === vscode.LogLevel.Trace) channel.trace(message)
    },
    dispose: () => channel?.dispose(),
  }
}
