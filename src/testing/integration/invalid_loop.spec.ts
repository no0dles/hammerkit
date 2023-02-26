import { createTestCase } from '../test-case'

describe('invalid', () => {
  it('should detect loop in execution', async () => {
    const testCase = createTestCase('invalid_loop', {
      '.hammerkit.yaml': {
        tasks: {
          bar: {
            deps: ['foo'],
            cmds: ['echo bar'],
          },
          foo: {
            deps: ['bar'],
            cmds: ['echo foo'],
          },
        },
      },
    })
    await testCase.cli({ taskName: 'foo' }, async (cli) => {
      const result = await cli.runExec()
      expect(result.success).toBeFalsy()
    })
  })

  it('should detect loop in services', async () => {
    const testCase = createTestCase('invalid_loop', {
      '.hammerkit.yaml': {
        services: {
          foodb: {
            image: 'postgres:12-alpine',
            volumes: ['foo:/var/lib/postgresql/data'],
            needs: ['bardb'],
            ports: [':5432'],
          },
          bardb: {
            image: 'postgres:12-alpine',
            volumes: ['bar:/var/lib/postgresql/data'],
            needs: ['foodb'],
            ports: [':5432'],
          },
        },
        tasks: {
          example: {
            needs: ['foodb'],
            cmds: ['echo bar'],
          },
        },
      },
    })
    await testCase.cli({ taskName: 'example' }, async (cli) => {
      const result = await cli.runExec()
      expect(result.success).toBeFalsy()
    })
  })
})
