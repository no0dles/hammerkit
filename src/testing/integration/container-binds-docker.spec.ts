import Dockerode from 'dockerode'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { dockerTask } from '../../executer/docker-task'
import { dockerService } from '../../executer/docker-service'
import { State } from '../../executer/state'
import { TaskState } from '../../executer/scheduler/task-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import { ExecuteOptions } from '../../runtime/runtime'

// A container of a server run binds folders of the run. Another task of the run may swap
// one for a link to a folder of the server while the engine starts the container, and put
// it back right after: the container is refused and nothing of it, nor of its image, ran
// with the server's folder.
describe('container binds of a server run (docker)', () => {
  // an image whose own `sh` writes into what it finds bound and whose `ls` lies
  const crafted = 'hammerkit-test-crafted-tools:1'
  let other: string
  beforeAll(() => {
    if (!process.env.LINUX_CONTAINERS && process.env.CI) {
      return
    }
    execFileSync('docker', ['build', '-q', '-t', crafted, '-'], {
      input: [
        'FROM alpine:3.21',
        `RUN rm /bin/ls /bin/sh && \\`,
        `    printf '#!/bin/busybox sh\\necho "1 1"\\n' > /bin/ls && \\`,
        `    printf '#!/bin/busybox sh\\n[ -d src ] && echo pid1 > src/written\\nexec /bin/busybox sh "$@"\\n' > /bin/sh && \\`,
        `    chmod +x /bin/ls /bin/sh`,
      ].join('\n'),
    })
  })
  beforeEach(() => {
    other = realpathSync(mkdtempSync(join(tmpdir(), 'hammerkit-other-')))
  })
  afterEach(() => rmSync(other, { recursive: true, force: true }))

  // docker whose containers start while `src` of the run is a link to `other`
  function swappingDocker(cwd: string): Dockerode {
    const docker = new Dockerode()
    const createContainer = docker.createContainer.bind(docker)
    docker.createContainer = (async (options: any) => {
      const container = await createContainer(options)
      const start = container.start.bind(container)
      container.start = (async () => {
        renameSync(join(cwd, 'src'), join(cwd, 'src-real'))
        symlinkSync(other, join(cwd, 'src'))
        try {
          return await start()
        } finally {
          rmSync(join(cwd, 'src'))
          renameSync(join(cwd, 'src-real'), join(cwd, 'src'))
        }
      }) as any
      return container
    }) as any
    return docker
  }

  function options<S>(state: S, daemon = false): ExecuteOptions<S> {
    return {
      state: new State<S>(state),
      stateKey: 'test',
      abort: new AbortController().signal,
      daemon,
      publishPorts: false,
      waitForReady: false,
      cache: { cached: false, stateKey: 'test', resolved: {} as any, provable: true },
    }
  }

  async function item(
    name: string,
    files: { [key: string]: any },
    fn: (cwd: string, item: any, environment: any) => Promise<void>
  ) {
    await createTestCase(name, { '.git/HEAD': 'ref: refs/heads/main\n', 'src/index.ts': 'the source', ...files }).setup(
      async (cwd, environment) => {
        const service = 'services' in files['.hammerkit.yaml']
        const cli = await createCli(
          join(cwd, '.hammerkit.yaml'),
          environment,
          service ? { serviceNames: ['db'] } : { taskName: 'build' }
        )
        const hosted = { ...environment, hosted: { catalog: {} as any } } as any
        await fn(cwd, service ? cli.service('db') : cli.task('build'), hosted)
      }
    )
  }

  it(
    'runs a task whose folders are the run’s, and refuses one that saw a link as it started',
    requiresLinuxContainers(async () => {
      for (const image of ['alpine:3.21', crafted]) {
        await item(
          `container-binds-task-${image === crafted ? 'crafted' : 'plain'}`,
          { '.hammerkit.yaml': { tasks: { build: { image, src: ['src'], cmds: ['echo cmd > src/cmd'] } } } },
          async (cwd, task, environment) => {
            const plain = options<TaskState>({ type: 'pending', stateKey: null } as any)
            await dockerTask(new Dockerode(), task, environment, plain)
            expect(existsSync(join(cwd, 'src', 'cmd'))).toBe(true)

            const swapped = options<TaskState>({ type: 'pending', stateKey: null } as any)
            await dockerTask(swappingDocker(cwd), task, environment, swapped).catch(() => undefined)
            expect(swapped.state.current.type, image).not.toBe('completed')
            expect(readdirSync(other), image).toEqual([])
          }
        )
      }
    }),
    180_000
  )

  it(
    'starts the command of a service once its folders are checked, and never one that saw a link',
    requiresLinuxContainers(async () => {
      const files = {
        '.hammerkit.yaml': {
          services: {
            db: { image: 'alpine:3.21', src: ['src'], cmd: 'sh -c "echo started > src/started; sleep 60"' },
          },
        },
      }
      await item('container-binds-service', files, async (cwd, service, environment) => {
        const plain = options<ServiceState>({ type: 'pending', stateKey: null } as any, true)
        await dockerService(new Dockerode(), service, plain, environment)
        expect(plain.state.current.type).toBe('running')
        for (let i = 0; i < 50 && !existsSync(join(cwd, 'src', 'started')); i++) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        expect(existsSync(join(cwd, 'src', 'started'))).toBe(true)
        await new Dockerode().getContainer((plain.state.current as any).dns.containerId).remove({ force: true })

        const swapped = options<ServiceState>({ type: 'pending', stateKey: null } as any, true)
        await dockerService(swappingDocker(cwd), service, swapped, environment)
        expect(swapped.state.current).toMatchObject({ type: 'end', reason: 'crash' })
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(readdirSync(other)).toEqual([])
      })
    }),
    180_000
  )
})
