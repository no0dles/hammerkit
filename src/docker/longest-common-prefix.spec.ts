import { sep } from 'path'
import { longestCommonPrefix } from './package'

// helper to build OS-correct absolute-ish paths
const p = (...segs: string[]) => sep + segs.join(sep)

describe('longestCommonPrefix (package build context root)', () => {
  it('returns the directory of a single source, not the file itself', () => {
    // regression: a single source used to yield the full file path, so the
    // build-context copy targeted a directory and failed with EISDIR.
    expect(longestCommonPrefix([p('a', 'b', 'hello.txt')])).toBe(p('a', 'b'))
  })

  it('returns the common parent of files in the same directory', () => {
    expect(longestCommonPrefix([p('a', 'x.txt'), p('a', 'y.txt')])).toBe(p('a'))
  })

  it('returns the common ancestor across nested directories', () => {
    expect(longestCommonPrefix([p('a', 'x.txt'), p('a', 'b', 'y.txt')])).toBe(p('a'))
  })

  it('compares per path segment, not per character', () => {
    expect(longestCommonPrefix([p('a', 'foo'), p('a', 'foobar')])).toBe(p('a'))
  })

  it('returns empty for no sources', () => {
    expect(longestCommonPrefix([])).toBe('')
  })
})
