import { parseSetArguments } from './parse-set-arguments'

describe('parseSetArguments', () => {
  it('takes --set NAME=value out of the arguments, anywhere and repeatedly', () => {
    expect(
      parseSetArguments(['node', 'hammerkit', 'run', '--set', 'SPEC=e2e/a.cy.ts', 'e2e', '--set=TENANT=b', '--verbose'])
    ).toEqual({
      args: ['node', 'hammerkit', 'run', 'e2e', '--verbose'],
      values: { SPEC: 'e2e/a.cy.ts', TENANT: 'b' },
    })
  })

  it('keeps everything after the first = as the value, including an empty one', () => {
    expect(parseSetArguments(['--set', 'URL=http://a/?x=1', '--set', 'EMPTY=']).values).toEqual({
      URL: 'http://a/?x=1',
      EMPTY: '',
    })
  })

  it('rejects a missing or invalid name', () => {
    expect(() => parseSetArguments(['--set'])).toThrow('--set expects NAME=value')
    expect(() => parseSetArguments(['--set', 'novalue'])).toThrow('got "novalue"')
    expect(() => parseSetArguments(['--set', '1A=x'])).toThrow('got "1A=x"')
  })
})
