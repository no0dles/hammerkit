import { buildFileSchema } from './build-file-schema'

function parse(input: unknown) {
  return buildFileSchema.safeParseAsync(input)
}

describe('buildFileSchema', () => {
  describe('container services', () => {
    it('accepts a service without ports (reachable via needs/DNS)', async () => {
      const result = await parse({
        services: { postgres: { image: 'postgres:12-alpine', healthcheck: { cmd: 'pg_isready -U postgres' } } },
      })
      expect(result.success).toBe(true)
    })

    it('accepts a service with numeric and string ports', async () => {
      const result = await parse({ services: { api: { image: 'node:alpine', ports: [':3000', 8080] } } })
      expect(result.success).toBe(true)
    })

    it('rejects a service that is neither a container nor a kubernetes service', async () => {
      const result = await parse({ services: { broken: { ports: [80] } } })
      expect(result.success).toBe(false)
    })
  })

  describe('kubernetes services', () => {
    it('accepts a service with a selector', async () => {
      const result = await parse({
        services: { db: { selector: { type: 'deployment', name: 'db' }, ports: [5432] } },
      })
      expect(result.success).toBe(true)
    })
  })

  describe('continuous tasks', () => {
    it('accepts a container task marked continuous', async () => {
      const result = await parse({ tasks: { serve: { image: 'node:16', continuous: true, cmds: ['ng serve'] } } })
      expect(result.success).toBe(true)
    })

    it('accepts a local task marked continuous', async () => {
      const result = await parse({ tasks: { serve: { continuous: true, cmds: ['ng serve'] } } })
      expect(result.success).toBe(true)
    })

    it('rejects a non-boolean continuous', async () => {
      const result = await parse({ tasks: { serve: { continuous: 'yes', cmds: ['x'] } } })
      expect(result.success).toBe(false)
    })
  })

  describe('strictness', () => {
    it('rejects unknown top-level keys', async () => {
      const result = await parse({ bogus: true })
      expect(result.success).toBe(false)
    })

    it('rejects unknown task keys', async () => {
      const result = await parse({ tasks: { build: { cmds: ['x'], bogus: 1 } } })
      expect(result.success).toBe(false)
    })

    it('accepts an empty build file', async () => {
      const result = await parse({})
      expect(result.success).toBe(true)
    })
  })
})
