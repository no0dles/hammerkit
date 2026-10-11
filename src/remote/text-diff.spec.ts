import { diffBundles, diffLines, visible } from './text-diff'

const bundle = (files: Record<string, string>, entry = '.hammerkit.yaml') => ({ entry, files })

describe('visible', () => {
  it('shows control and reordering characters as ?, and keeps long lines whole', () => {
    expect(visible('a\u001b[2Jb‮c​d')).toBe('a?[2Jb?c?d')
    expect(visible('\tx')).toBe('  x')
    expect(visible('x'.repeat(1000))).toHaveLength(1000)
  })
})

describe('diffLines', () => {
  it('marks what was removed and added with its context', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h']
    expect(diffLines(before, after, 1)).toEqual([
      { type: ' ', text: 'c' },
      { type: '-', text: 'd' },
      { type: '+', text: 'D' },
      { type: ' ', text: 'e' },
    ])
  })

  it('gives up on what is too large to compare', () => {
    const big = Array.from({ length: 3000 }, (_, i) => String(i))
    expect(diffLines(big, big)).toBeUndefined()
  })
})

describe('diffBundles', () => {
  it('lists added, removed and changed files', () => {
    const base = bundle({ 'a.yaml': 'tasks:\n  build:\n    cmds: [echo]\n', 'old.yaml': 'x\n' })
    const proposed = bundle({ 'a.yaml': 'tasks:\n  build:\n    cmds: [curl evil]\n', 'new.yaml': 'y\n' })
    expect(diffBundles(base, proposed)).toEqual([
      '--- a.yaml (changed)',
      '  tasks:',
      '    build:',
      '-     cmds: [echo]',
      '+     cmds: [curl evil]',
      '--- new.yaml (added)',
      '+ y',
      '--- old.yaml (removed)',
      '- x',
    ])
  })

  it('shows everything when there is nothing to compare with, and nothing when it is the same', () => {
    expect(diffBundles(undefined, bundle({ 'a.yaml': 'one\ntwo\n' }))).toEqual(['--- a.yaml (added)', '+ one', '+ two'])
    expect(diffBundles(bundle({ 'a.yaml': 'x' }), bundle({ 'a.yaml': 'x' }))).toEqual([])
  })

  it('says when the entry file changes, and hides nothing in a file name', () => {
    const out = diffBundles(bundle({ 'a.yaml': 'x' }, 'a.yaml'), bundle({ 'a.yaml': 'x', 'b‮.yaml': 'y' }, 'b.yaml'))
    expect(out[0]).toBe('entry file: a.yaml -> b.yaml')
    expect(out).toContain('--- b?.yaml (added)')
  })

  it('shows the old and the new file in full when it is too large to compare', () => {
    const lines = (prefix: string) => Array.from({ length: 2500 }, (_, i) => `${prefix}${i}`).join('\n')
    const out = diffBundles(bundle({ 'a.yaml': lines('o') }), bundle({ 'a.yaml': lines('n') }))
    expect(out).toHaveLength(1 + 2500 + 2500)
    expect(out[1]).toBe('- o0')
    expect(out[2501]).toBe('+ n0')
  })
})
