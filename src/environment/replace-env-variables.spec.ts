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

    it('treats a variable set to an empty string as set', () => {
      const result = buildEnvironmentVariables({ IID: '$MR_IID' }, env({ MR_IID: '' }), ctx({}))
      expect(result.replacements).toEqual([{ key: 'IID', name: 'MR_IID', available: true, value: '' }])
    })

    it('prefers an empty process variable over an env file value', () => {
      const result = buildEnvironmentVariables(
        { IID: '$MR_IID' },
        env({ MR_IID: '' }),
        ctx({ '/proj': { MR_IID: '7' } })
      )
      expect(result.replacements).toEqual([{ key: 'IID', name: 'MR_IID', available: true, value: '' }])
    })

    it('interpolates ${NAME} inside a value from the process environment', () => {
      const result = buildEnvironmentVariables(
        { URL: 'amqp://${QUEUE_USER}@queue:5672/' },
        env({ QUEUE_USER: 'app' }),
        ctx({})
      )
      expect(result.variables).toEqual({ URL: 'amqp://app@queue:5672/' })
      expect(result.replacements).toEqual([])
    })

    it('uses the :- default when the variable is unset, and the value when it is set', () => {
      const spec = { SPEC: '${E2E_SPEC:-e2e/all.cy.ts}' }
      expect(buildEnvironmentVariables(spec, env({}), ctx({})).variables).toEqual({ SPEC: 'e2e/all.cy.ts' })
      expect(buildEnvironmentVariables(spec, env({ E2E_SPEC: 'e2e/one.cy.ts' }), ctx({})).variables).toEqual({
        SPEC: 'e2e/one.cy.ts',
      })
      expect(buildEnvironmentVariables({ IID: '${MR_IID:-}' }, env({}), ctx({})).variables).toEqual({ IID: '' })
    })

    it('reads a literal from the same envs before the default', () => {
      const envs = { TOKEN: 'abc', HEADER: 'Bearer ${TOKEN}', URL: 'http://${HOST:-localhost}:${PORT:-80}' }
      expect(buildEnvironmentVariables(envs, env({}), ctx({})).variables).toEqual({
        TOKEN: 'abc',
        HEADER: 'Bearer abc',
        URL: 'http://localhost:80',
      })
    })

    it('reports the first missing ${NAME} without a default as unavailable', () => {
      const result = buildEnvironmentVariables({ URL: 'http://${HOST}:${PORT}' }, env({ PORT: '80' }), ctx({}))
      expect(result.variables).toEqual({})
      expect(result.replacements).toEqual([{ key: 'URL', name: 'HOST', available: false, value: null }])
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
