import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { Environment } from '../../executer/environment'
import { getSecretDirectory } from '../../executer/container-secrets'
import { getWorkInstanceId } from '../../planner/work-instance-id'
import { WorkItem } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'

const TOKEN = 'integration-token-7f3a'

function collectLogs(environment: Environment): string[] {
  const logs: string[] = []
  environment.status.on((message) => {
    logs.push(message.message)
  })
  return logs
}

// A credential reaches the container as an env variable or a read-only file,
// from the host env or a host file; hammerkit masks the value in its logs and
// leaves no file of it behind.
describe('secrets', () => {
  it(
    'hands env and file secrets to a container task and masks them in the logs',
    requiresLinuxContainers(async () => {
      await createTestCase('secrets-container-task', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            check: {
              image: 'alpine:3.19',
              generates: [{ path: 'out', export: true }],
              secrets: [
                { from: 'env:HK_SECRET_TOKEN', env: 'TOKEN' },
                { from: 'env:HK_SECRET_TOKEN', path: '/run/secrets/token' },
                { from: 'file:host-key.txt', path: '/run/secrets/key' },
              ],
              cmds: [
                'mkdir -p out',
                'echo "token is $TOKEN"',
                'test "$TOKEN" = "' + TOKEN + '"',
                'cat /run/secrets/token > out/token.txt',
                'cat /run/secrets/key > out/key.txt',
                'touch /run/secrets/key 2>/dev/null && exit 9 || true',
              ],
            },
          },
        },
        'host-key.txt': 'key-from-host-file',
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, HK_SECRET_TOKEN: TOKEN }
        const logs = collectLogs(environment)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.state.tasks['check'].state.current.type).toEqual('completed')
        expect(readFileSync(join(cwd, 'out', 'token.txt'), 'utf8')).toEqual(TOKEN)
        expect(readFileSync(join(cwd, 'out', 'key.txt'), 'utf8')).toEqual('key-from-host-file')
        expect(logs).toContain('token is ***')
        expect(logs.some((log) => log.includes(TOKEN))).toBe(false)
        const item = cli.task('check') as unknown as WorkItem<WorkTask>
        expect(existsSync(getSecretDirectory(getWorkInstanceId(item)))).toBe(false)
      })
    }),
    120000
  )

  it(
    'hands secrets to a service and to its init task',
    requiresLinuxContainers(async () => {
      await createTestCase('secrets-service', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            api: {
              image: 'alpine:3.19',
              cmd: 'sleep 300',
              secrets: [{ from: 'env:HK_SECRET_TOKEN', path: '/run/secrets/token' }],
              healthcheck: { cmd: 'cat /run/secrets/token' },
              init: 'seed',
            },
          },
          tasks: {
            seed: {
              image: 'alpine:3.19',
              secrets: [{ from: 'env:HK_SECRET_TOKEN', env: 'TOKEN' }],
              cmds: ['test "$TOKEN" = "' + TOKEN + '"'],
            },
            check: {
              image: 'alpine:3.19',
              needs: ['api'],
              cmds: ['true'],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, HK_SECRET_TOKEN: TOKEN }
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.state.tasks['check'].state.current.type).toEqual('completed')
        const service = cli.service('api') as unknown as WorkItem<WorkService>
        expect(existsSync(getSecretDirectory(getWorkInstanceId(service)))).toBe(false)
      })
    }),
    120000
  )

  it(
    'fails naming the secret before the container starts when its source is missing',
    requiresLinuxContainers(async () => {
      await createTestCase('secrets-missing', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            check: {
              image: 'alpine:3.19',
              secrets: [{ from: 'env:HK_SECRET_UNSET', env: 'TOKEN' }],
              cmds: ['true'],
            },
          },
        },
      }).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs }
        delete environment.processEnvs['HK_SECRET_UNSET']
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.state.tasks['check'].state.current).toMatchObject({
          type: 'error',
          errorMessage: 'secret TOKEN: environment variable HK_SECRET_UNSET is not set',
        })
      })
    }),
    120000
  )

  it('hands an env secret to a local task', async () => {
    await createTestCase('secrets-local-task', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          check: {
            secrets: [{ from: 'env:HK_SECRET_TOKEN', env: 'TOKEN' }],
            cmds: ['test "$TOKEN" = "' + TOKEN + '"'],
          },
        },
      },
    }).setup(async (cwd, environment) => {
      environment.processEnvs = { ...environment.processEnvs, HK_SECRET_TOKEN: TOKEN }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
      await cli.clean({ cache: true })
      const result = await cli.runExec()
      expect(result.state.tasks['check'].state.current.type).toEqual('completed')
    })
  })
})
