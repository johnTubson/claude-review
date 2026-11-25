// Which root a changed file is shown under, kept free of the vscode module so it can be tested.

import * as path from 'node:path'

const within = (root: string, file: string): boolean => file.startsWith(root + path.sep)

/** The workspace folder holding the file, else the root of its ledger (its git top level), which is how a worktree outside every folder is found. */
export const rootOfFile = (file: string, workspaceRoots: readonly string[], ledgerRoot: string | undefined): string | undefined =>
  workspaceRoots.find(r => within(r, file)) ?? (ledgerRoot !== undefined && within(ledgerRoot, file) ? ledgerRoot : undefined)
