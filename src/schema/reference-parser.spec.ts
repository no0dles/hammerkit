import { parseReferences } from './reference-parser'
import { ParseScope } from './parse-context'
import { environmentMock } from '../executer/environment-mock'

describe('reference-parser', () => {
  it('should', async () => {
    const npmScope: ParseScope = {
      namePrefix: 'npm',
      fileName: '/build.npm.yaml',
      cwd: '/best-practices',
      schema: {
        tasks: {
          install: {
            cmds: ['npm install'],
          },
        },
      },
      references: {},
    }
    const postgresScope: ParseScope = {
      namePrefix: 'postgres',
      fileName: '/build.postgres.yaml',
      cwd: '/best-practices',
      schema: {
        services: {
          db: {
            image: 'postgres',
            envs: {},
            ports: ['5432'],
          },
        },
      },
      references: {},
    }
    const buildScope: ParseScope = {
      namePrefix: '',
      schema: {
        services: {
          api: {
            image: 'node',
            needs: [{ name: 'postgres', service: 'postgres:db' }],
            deps: ['npm:install', 'build:common'],
            cmd: 'npm start',
            ports: ['3000'],
          },
        },
        tasks: {
          'build:common': {
            deps: ['npm:install'],
            cmds: ['tsc -b common'],
          },
        },
        includes: {
          npm: './build.npm.yaml',
          postgres: './build.postgres.yaml',
        },
      },
      fileName: '/build.yaml',
      cwd: '/',
      references: { npm: { scope: npmScope, type: 'include' }, postgres: { scope: postgresScope, type: 'include' } },
    }
    const refs = await parseReferences(
      {
        files: {
          '/build.npm.yaml': npmScope,
          '/build.postgres.yaml': postgresScope,
          '/build.yaml': buildScope,
        },
      },
      environmentMock('/')
    )
    for (const task of Object.values(refs.tasks)) {
      for (const dep of task.deps) {
        expect(dep.task).toBeDefined()
      }
      for (const need of task.needs) {
        expect(need.service).toBeDefined()
      }
    }
    for (const service of Object.values(refs.services)) {
      for (const dep of service.deps) {
        expect(dep.task).toBeDefined()
      }
      for (const need of service.needs) {
        expect(need.service).toBeDefined()
      }
    }
    console.log(refs)
  })
})
