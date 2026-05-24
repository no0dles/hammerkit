import { tokenizeCommand } from './parse-work-command'

describe('tokenizeCommand', () => {
  it('splits a plain command on whitespace', () => {
    expect(tokenizeCommand('node server.js')).toEqual(['node', 'server.js'])
  })

  it('keeps a double-quoted argument as one token and strips the quotes', () => {
    expect(tokenizeCommand('sh -c "echo hi && sleep 3600"')).toEqual(['sh', '-c', 'echo hi && sleep 3600'])
  })

  it('handles single quotes', () => {
    expect(tokenizeCommand("sh -c 'echo hi'")).toEqual(['sh', '-c', 'echo hi'])
  })

  it('collapses repeated whitespace instead of emitting empty tokens', () => {
    expect(tokenizeCommand('a   b\tc')).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty list for a blank command', () => {
    expect(tokenizeCommand('   ')).toEqual([])
  })
})
