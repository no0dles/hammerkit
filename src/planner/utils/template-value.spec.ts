import { templateValue } from './template-value'

describe('template-value', () => {
  it('should template string value', () => {
    const value = templateValue('echo $VAR', { variables: { VAR: 'hello' }, replacements: [] })
    expect(value).toEqual('echo hello')
  })

  it('should leave missing envs', () => {
    const value = templateValue('echo $VAR', { variables: {}, replacements: [] })
    expect(value).toEqual('echo $VAR')
  })

  it('should template the ${VAR} form', () => {
    const value = templateValue('node:${VERSION}-alpine', { variables: { VERSION: '24' }, replacements: [] })
    expect(value).toEqual('node:24-alpine')
  })
})
