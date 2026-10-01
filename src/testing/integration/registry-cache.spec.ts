import Dockerode from 'dockerode'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Stream } from 'stream'
import { createRegistryCacheBackend } from '../../cache/backends/registry-cache-backend'
import { Environment } from '../../executer/environment'
import { environmentMock } from '../../executer/environment-mock'
import { getFileContext } from '../../file/get-file-context'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { runProgram } from '../../run-program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { memoryStream } from '../test-streams'
import { listVolume } from '../read-volume'
import { prunable } from '../prunable-backend'

// The registry cache backend against a real registry:2 with basic auth (the
// credentials come from a docker config, exactly as `docker login` writes it)
// and deletion enabled. The registry port is published on the host loopback so
// this (host) process talks to it directly.

const USER = 'hammerkit'
const PASSWORD = 's3cret'
// `htpasswd -Bbn hammerkit s3cret`
const HTPASSWD = 'hammerkit:$2y$05$SCjSUAymt3iUPiqm1x5JhugaeTLDaO6eSiJ9h3lAITgwkNotaqhA2\n'

async function ensureImage(docker: Dockerode, image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect()
    return
  } catch {
    // pull below
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: unknown, stream: NodeJS.ReadableStream | undefined) => {
      if (err || !stream) {
        reject(err ?? new Error('no pull stream'))
        return
      }
      docker.modem.followProgress(stream as unknown as Stream, (e: unknown) => (e ? reject(e) : resolve()))
    })
  })
}

describe('registry cache backend', () => {
  const docker = new Dockerode()
  let container: Dockerode.Container | null = null
  let host = ''
  let configDir = ''

  beforeAll(
    requiresLinuxContainers(async () => {
      await ensureImage(docker, 'registry:2')
      container = await docker.createContainer({
        Image: 'registry:2',
        Env: [
          'REGISTRY_AUTH=htpasswd',
          'REGISTRY_AUTH_HTPASSWD_REALM=hammerkit',
          'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd',
          'REGISTRY_STORAGE_DELETE_ENABLED=true',
        ],
        Entrypoint: [
          'sh',
          '-c',
          `mkdir -p /auth && printf '%s' '${HTPASSWD}' > /auth/htpasswd && exec registry serve /etc/docker/registry/config.yml`,
        ],
        Labels: { app: 'hammerkit' },
        ExposedPorts: { '5000/tcp': {} },
        HostConfig: { AutoRemove: true, PortBindings: { '5000/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
      })
      await container.start()
      const info = await container.inspect()
      const port = info.NetworkSettings.Ports['5000/tcp'][0].HostPort
      host = `127.0.0.1:${port}`
      for (let attempt = 0; attempt < 50; attempt++) {
        const ready = await fetch(`http://${host}/v2/`).then(
          (r) => r.status === 401,
          () => false
        )
        if (ready) break
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      configDir = mkdtempSync(join(tmpdir(), 'hammerkit-registry-auth-'))
      writeFileSync(
        join(configDir, 'config.json'),
        JSON.stringify({ auths: { [host]: { auth: Buffer.from(`${USER}:${PASSWORD}`).toString('base64') } } })
      )
    })
  )

  afterAll(async () => {
    if (container) {
      await container.stop().catch(() => undefined)
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  function authenticated(cwd: string): Environment {
    return { ...environmentMock(cwd), file: getFileContext(cwd), processEnvs: { DOCKER_CONFIG: configDir } }
  }

  it(
    'round-trips an entry: push, has, pull, clear',
    requiresLinuxContainers(async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'hammerkit-registry-entry-'))
      try {
        const environment = authenticated(scratch)
        const backend = createRegistryCacheBackend({ type: 'registry', repository: `${host}/cache/roundtrip` })
        const from = join(scratch, 'from')
        await environment.file.createDirectory(from)
        await environment.file.writeFile(join(from, 'stats.json'), '{"files":{}}')
        await environment.file.writeFile(join(from, 'out-generates.tgz'), 'x'.repeat(1024 * 1024))

        expect(await backend.has('task1', 'state1', environment)).toBe(false)
        expect(await backend.pull('task1', 'state1', join(scratch, 'missing'), environment)).toBe(false)

        await backend.push('task1', 'state1', from, environment)
        await backend.push('task1', 'state1', from, environment) // idempotent re-push
        expect(await backend.has('task1', 'state1', environment)).toBe(true)

        const into = join(scratch, 'into')
        expect(await backend.pull('task1', 'state1', into, environment)).toBe(true)
        expect((await environment.file.listFiles(into)).sort()).toEqual(['out-generates.tgz', 'stats.json'])
        expect(await environment.file.read(join(into, 'out-generates.tgz'))).toBe('x'.repeat(1024 * 1024))

        await backend.clear('task1', environment)
        expect(await backend.has('task1', 'state1', environment)).toBe(false)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  )

  it(
    'lists and removes entries for retention',
    requiresLinuxContainers(async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'hammerkit-registry-retention-'))
      try {
        const environment = authenticated(scratch)
        const backend = createRegistryCacheBackend({ type: 'registry', repository: `${host}/cache/retention` })
        const from = join(scratch, 'from')
        await environment.file.createDirectory(from)
        await environment.file.writeFile(join(from, 'stats.json'), '{"files":{}}')
        await environment.file.writeFile(join(from, 'out-generates.tgz'), 'x'.repeat(2048))
        const taskId = 'a'.repeat(40)
        await backend.push(taskId, 'state1', from, environment)
        await backend.push(taskId, 'state2', from, environment)

        const entries = await prunable(backend).list(environment)
        expect(entries.map((e) => e.stateKey).sort()).toEqual(['state1', 'state2'])
        expect(entries[0].size).toBeGreaterThan(2048)
        expect(entries[0].createdAt).toBeGreaterThan(Date.now() - 60_000)

        await prunable(backend).remove(taskId, 'state1', environment)
        expect(await backend.has(taskId, 'state1', environment)).toBe(false)
        expect(await backend.has(taskId, 'state2', environment)).toBe(true)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  )

  it(
    'reports missing credentials as an error rather than a miss',
    requiresLinuxContainers(async () => {
      const scratch = mkdtempSync(join(tmpdir(), 'hammerkit-registry-noauth-'))
      try {
        const environment = { ...authenticated(scratch), processEnvs: { DOCKER_CONFIG: scratch } }
        const backend = createRegistryCacheBackend({ type: 'registry', repository: `${host}/cache/noauth` })
        await expect(backend.has('task1', 'state1', environment)).rejects.toThrow(/401/)
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  )

  it(
    'restores a task in another checkout from the registry without executing it',
    requiresLinuxContainers(async () => {
      const files = (localCache: string) => ({
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          caches: {
            default: { method: 'checksum', backend: { type: 'local', path: localCache } },
            registry: { method: 'checksum', backend: { type: 'registry', repository: `${host}/cache/flow` } },
          },
          tasks: {
            build: {
              image: 'alpine:3.19',
              src: ['input.txt'],
              generates: ['out'],
              cmds: ['mkdir -p out', 'cp input.txt out/result.txt', 'echo ran >> out/runs.txt'],
            },
          },
        },
        'input.txt': 'hello\n',
      })

      // CI: build, then push to the registry
      const ciCache = join(process.cwd(), 'temp', 'registry-flow-ci-local')
      await createTestCase('registry-flow-ci', files(ciCache)).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, DOCKER_CONFIG: configDir }
        await environment.file.remove(ciCache)
        await runProgram(environment, ['hammerkit', 'run', 'build', '--no-summary'], true)
        await runProgram(environment, ['hammerkit', 'cache', 'push', 'build', '--remote', 'registry'], true)
      })

      // agent workspace: another checkout with an empty machine cache
      const agentCache = join(process.cwd(), 'temp', 'registry-flow-agent-local')
      await createTestCase('registry-flow-agent', files(agentCache)).setup(async (cwd, environment) => {
        environment.processEnvs = { ...environment.processEnvs, DOCKER_CONFIG: configDir }
        await environment.file.remove(agentCache)
        const out = memoryStream()
        environment.stdout = out.stream
        await runProgram(environment, ['hammerkit', 'cache', 'pull', 'build', '--remote', 'registry'], true)
        expect(out.read()).toContain('build: pulled')

        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        await cli.clean()
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(result.state.tasks['build'].state.current).toMatchObject({ type: 'completed', cached: true })
        // restored into this checkout's volume from the registry-built entry
        expect(await listVolume(cli.task('build').data.generates[0].volumeName)).toEqual(['result.txt', 'runs.txt'])
      })
    })
  )
})
