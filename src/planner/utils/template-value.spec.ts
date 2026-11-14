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

  it('reads a name with regular expression characters as the text it is', () => {
    const envs = { variables: { 'A.B': 'dot', '(a+)+b': 'group' }, replacements: [] }
    expect(templateValue('$A.B $AxB ${A.B}', envs)).toEqual('dot $AxB dot')
    const started = Date.now()
    const long = `$${'a'.repeat(40)}!`
    expect(templateValue(long, envs)).toEqual(long)
    expect(templateValue('$(a+)+b', envs)).toEqual('group')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('puts values in as they are written', () => {
    const written = ['$', '$', ' $', '&', ' $', '1'].join('')
    const envs = { variables: { A: written, B: 'b' }, replacements: [] }
    expect(templateValue('$A', envs)).toEqual(written)
  })

  it('does not read a value it put in again', () => {
    const variables: { [key: string]: string } = {}
    for (let i = 0; i < 40; i++) {
      variables[`V${i}`] = `$V${i + 1}$V${i + 1}`
    }
    expect(templateValue('$V0', { variables, replacements: [] })).toEqual('$V1$V1')
  })

  it('takes the first name that matches, in any case', () => {
    const envs = { variables: { VAR: 'short', VARX: 'long', var: 'lower' }, replacements: [] }
    expect(templateValue('$VARX ${VARX} $var', envs)).toEqual('shortX long short')
  })
})
