import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { isReadOnlyCommand } from '../src/bashReadOnly'

const READ_ONLY = [
  // Required by the spec.
  'ls -la',
  'grep -rn "a > b" src',
  'cat x | head -5',
  'ls 2>/dev/null',
  'git status && git diff',
  'cd a && ls',
  'FOO=1 rg x',
  'jq . a.json',
  // More.
  'ls >/dev/null 2>&1',
  'ls &>/dev/null',
  'echo hi >&2',
  "rg 'x|y' -g '*.ts'",
  'find . -name "*.ts" -type f',
  'git log --oneline -5; git branch',
  'git -C sub status',
  'git branch -a',
  'git config --get user.name',
  'git stash list',
  'wc -l < file.txt',
  'sort -u a',
  'uniq a',
  'command -v node',
  'env',
  '/usr/bin/grep x f',
  'echo a \\> b',
  '# only a comment',
  'ls\nwc -l f',
]

const MUTATING = [
  // Required by the spec.
  'npm test',
  'sed -i s/a/b/ f',
  'echo hi > f',
  'find . -name x -delete',
  'git commit -m x',
  'echo $(rm x)',
  'cat <<EOF',
  'sort -o f a',
  "awk '{print}' f",
  'python -c 1',
  'ls &',
  'git branch -D x',
  // More.
  'echo "$(rm x)"',
  'echo `rm x`',
  'ls >> f',
  'ls 3>/dev/null',
  'ls > /tmp/x',
  'diff <(ls a) <(ls b)',
  'echo "unterminated',
  "echo 'unterminated",
  '(cd a && rm b)',
  'xargs rm',
  'sudo ls',
  'eval ls',
  '. ./env.sh',
  'source x',
  'find . -exec rm {} \;',
  'sort --output=f a',
  'uniq a b',
  'yq -i .a f.yaml',
  'git diff --output=x',
  'git -c core.pager=rm log',
  'git stash',
  'git tag v1',
  'git config user.name x',
  'git config --unset --get x',
  'env rm x',
  'command rm x',
  './ls',
  'ls && rm x',
  'cat a | tee b',
  'ls | xargs rm',
  'touch x',
  'mkdir d',
]

describe('isReadOnlyCommand', () => {
  for (const c of READ_ONLY) test(`read-only: ${JSON.stringify(c)}`, () => assert.equal(isReadOnlyCommand(c), true))
  for (const c of MUTATING) test(`not read-only: ${JSON.stringify(c)}`, () => assert.equal(isReadOnlyCommand(c), false))
})
