import { showBundle, visible } from './bundle-text'

describe('visible', () => {
  it('shows control and reordering characters as ?, and keeps long lines whole', () => {
    expect(visible('a\u001b[2Jb‮c​d')).toBe('a?[2Jb?c?d')
    expect(visible('\tx')).toBe('  x')
    expect(visible('x'.repeat(1000))).toHaveLength(1000)
  })
})

describe('showBundle', () => {
  it('shows every file whole, in path order, and marks the entry file', () => {
    const lines = showBundle({
      entry: '.hammerkit.yaml',
      files: { 'b.yaml': 'tasks: {}\n', '.hammerkit.yaml': 'includes:\n  b: ./b.yaml\n', 'empty.yaml': '' },
    })
    expect(lines).toEqual([
      '--- .hammerkit.yaml (entry)',
      '  includes:',
      '    b: ./b.yaml',
      '--- b.yaml',
      '  tasks: {}',
      '--- empty.yaml',
    ])
  })

  it('hides nothing in a file name or its content', () => {
    expect(showBundle({ entry: 'a‮.yaml', files: { 'a‮.yaml': 'x\u001b[2J' } })).toEqual([
      '--- a?.yaml (entry)',
      '  x?[2J',
    ])
  })
})
