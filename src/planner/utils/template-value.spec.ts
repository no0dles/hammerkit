import { templateValue } from './template-value'

describe('template-value', () => {
  it('should template string value', () => {
    const value = templateValue('echo $VAR', { VAR: 'hello' })
    expect(value).toEqual('echo hello')
  })

  it('should leave missing envs', () => {
    const value = templateValue('echo $VAR', {})
    expect(value).toEqual('echo $VAR')
  })
})
