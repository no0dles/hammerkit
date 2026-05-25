import { buildEnvironmentVariables, getEnvironmentVariables } from './replace-env-variables'
import { Environment } from '../executer/environment'
import { ReferencedContext } from '../schema/reference-parser'

function env(processEnvs: { [key: string]: string | undefined }): Environment {
  return { processEnvs } as unknown as Environment
}

function ctx(envFiles: { [key: string]: { [key: string]: string } }): ReferencedContext {
  return { envFiles } as unknown as ReferencedContext
}

describe('replace-env-variables', () => {
  describe('buildEnvironmentVariables', () => {
    it('keeps literal values as variables', () => {
      const result = buildEnvironmentVariables({ NODE_ENV: 'production' }, env({}), ctx({}))
      expect(result.variables).toEqual({ NODE_ENV: 'production' })
      expect(result.replacements).toEqual([])
    })

    it('resolves $NAME references from processEnvs', () => {
      const result = buildEnvironmentVariables({ TOKEN: '$SECRET' }, env({ SECRET: 'abc' }), ctx({}))
      expect(result.variables).toEqual({})
      expect(result.replacements).toEqual([{ key: 'TOKEN', name: 'SECRET', available: true, value: 'abc' }])
    })

    it('falls back to env files when not in processEnvs', () => {
      const result = buildEnvironmentVariables({ TOKEN: '$SECRET' }, env({}), ctx({ '/proj': { SECRET: 'from-file' } }))
      expect(result.replacements).toEqual([{ key: 'TOKEN', name: 'SECRET', available: true, value: 'from-file' }])
    })

    it('marks unresolved references as unavailable', () => {
      const result = buildEnvironmentVariables({ TOKEN: '$MISSING' }, env({}), ctx({}))
      expect(result.replacements).toEqual([{ key: 'TOKEN', name: 'MISSING', available: false, value: null }])
    })
  })

  describe('getEnvironmentVariables', () => {
    it('merges variables with resolved replacements', () => {
      const result = getEnvironmentVariables({
        variables: { NODE_ENV: 'production' },
        replacements: [{ key: 'TOKEN', name: 'SECRET', available: true, value: 'abc' }],
      })
      expect(result).toEqual({ NODE_ENV: 'production', TOKEN: 'abc' })
    })

    it('throws when a replacement is unavailable', () => {
      expect(() =>
        getEnvironmentVariables({
          variables: {},
          replacements: [{ key: 'TOKEN', name: 'SECRET', available: false, value: null }],
        })
      ).toThrow('missing environment variable SECRET')
    })
  })
})
