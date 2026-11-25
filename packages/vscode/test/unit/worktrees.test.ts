import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { after, describe, test } from 'node:test'

import { parseWorktrees, worktreesOf } from '../../src/ledger/worktrees'
import { rootOfFile } from '../../src/ui/grouping'
import { cleanTemps, tempDir } from './support'

after(cleanTemps)

describe('parseWorktrees', () => {
  test('reads the main, a linked, a detached and skips a bare worktree', () => {
    const text = [
      'worktree /work/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/develop',
      '',
      'worktree /work/app-push',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/push-notifications',
      '',
      'worktree /work/app-detached',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /work/app.git',
      'bare',
      '',
    ].join('\n')
    assert.deepEqual(parseWorktrees(text), [
      { root: '/work/app', branch: 'develop' },
      { root: '/work/app-push', branch: 'feat/push-notifications' },
      { root: '/work/app-detached', branch: undefined },
    ])
  })

  test('nothing in, nothing out', () => {
    assert.deepEqual(parseWorktrees(''), [])
  })
})

describe('worktreesOf', () => {
  const git = (cwd: string, ...args: string[]): void => void execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })

  test('lists a repository from the main worktree and from a linked one', async () => {
    const base = realpathSync(tempDir())
    const main = path.join(base, 'app')
    const linked = path.join(base, 'app-push')
    mkdirSync(main)
    git(main, 'init', '-b', 'develop')
    writeFileSync(path.join(main, 'a.txt'), 'a')
    git(main, 'add', '.')
    git(main, 'commit', '-m', 'init')
    git(main, 'worktree', 'add', '-b', 'feat/push', linked)
    const expected = [
      { root: main, branch: 'develop' },
      { root: linked, branch: 'feat/push' },
    ]
    assert.deepEqual(await worktreesOf(main), expected)
    assert.deepEqual(await worktreesOf(linked), expected)
  })

  test('a folder outside any repository has none', async () => {
    assert.deepEqual(await worktreesOf(realpathSync(tempDir())), [])
  })
})

describe('rootOfFile', () => {
  test('prefers the workspace folder, then the ledger root, else nothing', () => {
    assert.equal(rootOfFile('/work/repo/pkg/a.ts', ['/work/repo/pkg'], '/work/repo'), '/work/repo/pkg')
    assert.equal(rootOfFile('/work/repo-push/a.ts', ['/work/repo'], '/work/repo-push'), '/work/repo-push')
    assert.equal(rootOfFile('/work/repo-push/a.ts', ['/work/repo'], undefined), undefined)
    assert.equal(rootOfFile('/elsewhere/a.ts', ['/work/repo'], '/work/repo-push'), undefined)
  })
})
