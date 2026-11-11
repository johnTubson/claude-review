// One-time prompts about settings that hurt the review (§7.7), each asked once.

import * as vscode from 'vscode'

const ASKED_TIMEOUT = 'claudeReview.askedMaxComputationTime'
const ASKED_INSETS = 'claudeReview.askedInlineRemovedLines'

const removeEverywhere = async (section: string, key: string): Promise<void> => {
  const c = vscode.workspace.getConfiguration(section)
  const seen = c.inspect(key)
  if (seen?.globalValue !== undefined) await c.update(key, undefined, vscode.ConfigurationTarget.Global)
  if (seen?.workspaceValue !== undefined) await c.update(key, undefined, vscode.ConfigurationTarget.Workspace)
}

export const promptOnce = async (context: vscode.ExtensionContext): Promise<void> => {
  const diff = vscode.workspace.getConfiguration('diffEditor')
  if (!context.globalState.get<boolean>(ASKED_TIMEOUT) && diff.get<number>('maxComputationTime') === 0) {
    await context.globalState.update(ASKED_TIMEOUT, true)
    const choice = await vscode.window.showInformationMessage(
      'diffEditor.maxComputationTime is 0, so a large diff can keep VS Code busy without limit. Set it to 5 seconds?',
      'Set to 5000',
      'Leave it',
    )
    if (choice === 'Set to 5000') await diff.update('maxComputationTime', 5000, vscode.ConfigurationTarget.Global)
  }
  const old = vscode.workspace.getConfiguration('claudeReview').inspect('inlineRemovedLines')
  const isSet = old?.globalValue !== undefined || old?.workspaceValue !== undefined
  if (!context.globalState.get<boolean>(ASKED_INSETS) && isSet) {
    await context.globalState.update(ASKED_INSETS, true)
    const choice = await vscode.window.showInformationMessage(
      'Removed lines are no longer drawn inside the plain file: open a changed file in the inline diff instead, or press ⌥D to flip between the file and its diff. Open changed files in the inline diff from now on?',
      'Use the inline diff',
      'Keep opening files',
    )
    if (choice === 'Use the inline diff') await vscode.workspace.getConfiguration('claudeReview').update('openFilesAs', 'inlineDiff', vscode.ConfigurationTarget.Global)
    await removeEverywhere('claudeReview', 'inlineRemovedLines')
  }
}
