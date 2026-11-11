// The fixture both sides of the integration test agree on.

const lines = (n: number, tag = ''): string => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}\n`).join('')

export const A_BASE = lines(30)
export const A_LIVE = A_BASE.replace('line 3\n', 'line 3 changed\n').replace('line 20\n', '').replace('line 28\n', 'line 28\nnew line\n')
const B_BASE = lines(10, ' of b')
const B_LIVE = B_BASE.replace('line 5 of b\n', 'line 5 of b, edited\n')
const D_BASE = lines(12, ' of d')
const D_T1 = D_BASE.replace('line 2 of d\n', 'line 2 of d by s2\n')
const D_LIVE = D_T1.replace('line 11 of d\n', 'line 11 of d by s2 again\n')

export const FIXTURE = {
  sessions: [
    {
      id: 's1',
      title: 'first session',
      turns: [
        { id: 't1', prompt: 'edit a', edits: [{ file: 'a.ts', before: A_BASE, after: A_LIVE }] },
        { id: 't2', prompt: 'edit b', edits: [{ file: 'b.ts', before: B_BASE, after: B_LIVE }] },
      ],
    },
    {
      id: 's2',
      title: 'second session',
      turns: [
        { id: 't1', prompt: 'make c, touch d', edits: [{ file: 'c.ts', before: null, after: 'brand new\n' }, { file: 'd.ts', before: D_BASE, after: D_T1 }] },
        { id: 't2', prompt: 'touch d again', edits: [{ file: 'd.ts', before: D_T1, after: D_LIVE }] },
      ],
    },
  ],
  live: { 'a.ts': A_LIVE, 'b.ts': B_LIVE, 'c.ts': 'brand new\n', 'd.ts': D_LIVE },
  bases: { 'b.ts': B_BASE, 'd.ts': D_BASE },
} as const
