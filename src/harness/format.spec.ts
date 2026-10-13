import { capOutput } from './format'

describe('command output', () => {
  it('stays whole while it is short', () => {
    expect(capOutput('one\ntwo', 'more')).toBe('one\ntwo')
  })

  it('keeps the first and last lines of a long output and says how to read the rest', () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index + 1}`)
    const capped = capOutput(lines.join('\n'), 'read more with run_logs').split('\n')
    expect(capped).toHaveLength(251)
    expect(capped[0]).toBe('line 1')
    expect(capped[49]).toBe('line 50')
    expect(capped[50]).toBe('… the output is cut here, it has 10000 lines in all: read more with run_logs')
    expect(capped[51]).toBe('line 9801')
    expect(capped[250]).toBe('line 10000')
  })

  it('cuts long lines to about 30 KB, keeping more of the end', () => {
    const capped = capOutput(`${'a'.repeat(100_000)}${'z'.repeat(100_000)}`, 'more')
    expect(capped.length).toBeLessThan(31_000)
    expect(capped.startsWith('a'.repeat(7_500))).toBe(true)
    expect(capped.endsWith('z'.repeat(22_500))).toBe(true)
  })
})
