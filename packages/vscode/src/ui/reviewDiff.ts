// Which editors and tabs are review diffs: shared by the surfaces that must
// not paint over VS Code's own diff colouring.

import * as vscode from 'vscode'

import { BASE_SCHEME } from './baseDocs'

export const isReviewDiffTab = (tab: vscode.Tab | undefined): tab is vscode.Tab & { input: vscode.TabInputTextDiff } =>
  tab?.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme === BASE_SCHEME

/** True when the editor is the live side of a review diff, where VS Code already colours the change. */
export const isInReviewDiff = (editor: vscode.TextEditor): boolean =>
  vscode.window.tabGroups.all.some(group => {
    const tab = group.activeTab
    return isReviewDiffTab(tab) && tab.input.modified.fsPath === editor.document.uri.fsPath && group.viewColumn === editor.viewColumn
  })

/** A hunk as a command argument: re-found by its sig nearest `start` when the action runs. */
export type HunkArg = { readonly path: string; readonly start: number; readonly sig: string }

export const commandLink = (command: string, arg: unknown): string => `command:${command}?${encodeURIComponent(JSON.stringify([arg]))}`
