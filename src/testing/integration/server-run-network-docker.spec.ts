import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import Dockerode from 'dockerode'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { WorkerMessage, workerMain } from '../../server/run-worker'
import { hostEnvs } from '../host-env'

// nothing but the loopback interface: no way out at all
const noInterfaces = 'test "$(ls /sys/class/net)" = lo'

// the process of a server run, with runs.network handed to it as the executor does
async function run(directory: string, task: string, network?: unknown, extra: object = {}): Promise<WorkerMessage[]> {
  const stdin = new PassThrough()
  stdin.end(
    JSON.stringify({
      entry: join(directory, '.hammerkit.yaml'),
      tasks: [task],
      options: { cache: 'none' },
      accounts: [],
      catalog: { providers: {}, accounts: {} },
      ...(network !== undefined ? { network } : {}),
      ...extra,
    })
  )
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  await workerMain(stdin, stdout, hostEnvs(), directory, new AbortController())
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

describe('runs.network on a server run (docker)', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-server-network-'))
    writeFileSync(
      join(directory, '.hammerkit.yaml'),
      [
        'tasks:',
        '  open:',
        '    image: alpine:3.21',
        `    cmds: ['${noInterfaces}']`,
        '  allowed:',
        '    image: alpine:3.21',
        '    network: { allow: [example.com] }',
        `    cmds: ['${noInterfaces}']`,
        '',
      ].join('\n')
    )
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it(
    'holds a container task to the ceiling, whatever its build file asks for',
    requiresLinuxContainers(async () => {
      // without a ceiling the task has a way out, so the check below fails
      expect((await run(directory, 'open')).pop()).toEqual({ kind: 'result', ok: false, error: 'open failed' })
      expect((await run(directory, 'open', 'none')).pop()).toEqual({ kind: 'result', ok: true })
      expect((await run(directory, 'allowed', 'none')).pop()).toEqual({ kind: 'result', ok: true })
    }),
    180_000
  )
})

// a busybox web server on the default bridge, where open containers ran before
async function startOnDefaultBridge(docker: Dockerode, name: string): Promise<string> {
  await new Promise((resolve, reject) =>
    docker.pull('busybox:1.36', (err: any, stream: any) =>
      err ? reject(err) : docker.modem.followProgress(stream, resolve)
    )
  )
  const container = await docker.createContainer({
    name,
    Image: 'busybox:1.36',
    Cmd: ['sh', '-c', 'mkdir -p /www && echo ok > /www/index.html && httpd -f -p 8080 -h /www'],
    HostConfig: { AutoRemove: true },
  })
  await container.start()
  return (await container.inspect()).NetworkSettings.IPAddress
}

// whether a container on the default bridge reaches the address
async function reachesFromDefaultBridge(docker: Dockerode, address: string): Promise<boolean> {
  const container = await docker.createContainer({
    Image: 'busybox:1.36',
    Cmd: [
      'sh',
      '-c',
      `for i in $(seq 10); do wget -q -T 2 -O /dev/null http://${address}:8080/ && exit 0; sleep 1; done; exit 1`,
    ],
  })
  try {
    await container.start()
    return (await container.wait()).StatusCode === 0
  } finally {
    await container.remove({ force: true })
  }
}

describe('open containers of a server run (docker)', () => {
  const docker = new Dockerode()
  // the scope the executor hands the run, see volumeScope
  const scope = `ref-${process.pid.toString(16).padStart(24, '0')}`
  const victim = `hk-isolation-victim-${process.pid}`
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-server-isolation-'))
  })

  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true })
    await docker
      .getContainer(victim)
      .remove({ force: true })
      .catch(() => undefined)
    await docker
      .getVolume(`hammerkit-${scope}-data`)
      .remove()
      .catch(() => undefined)
  })

  it(
    "run on the run's own network, reach the services they need, not other containers, and keep their volumes",
    requiresLinuxContainers(async () => {
      const address = await startOnDefaultBridge(docker, victim)
      // without the run's network an open container would reach it
      expect(await reachesFromDefaultBridge(docker, address)).toBe(true)
      writeFileSync(
        join(directory, '.hammerkit.yaml'),
        [
          'services:',
          '  db:',
          '    image: busybox:1.36',
          '    shell: sh',
          '    cmd: mkdir -p /data/www && echo ok > /data/www/index.html && httpd -f -p 8080 -h /data/www',
          '    volumes: [data:/data]',
          'tasks:',
          '  reach:',
          '    image: busybox:1.36',
          '    needs: [{ name: database, service: db }]',
          '    cmds:',
          '      - for i in $(seq 30); do wget -q -T 2 -O /dev/null http://database:8080/ && exit 0; sleep 1; done; exit 1',
          `      - if wget -q -T 3 -O /dev/null http://${address}:8080/; then echo reached; exit 1; fi`,
          '',
        ].join('\n')
      )
      const messages = await run(directory, 'reach', undefined, { volumeScope: scope })
      expect(messages.pop(), JSON.stringify(messages)).toEqual({ kind: 'result', ok: true })
      // the volume is the caller's, not one any build file can name
      expect((await docker.getVolume(`hammerkit-${scope}-data`).inspect()).Name).toEqual(`hammerkit-${scope}-data`)
    }),
    180_000
  )

  it(
    'refuses a volume that names a path of the server',
    requiresLinuxContainers(async () => {
      writeFileSync(
        join(directory, '.hammerkit.yaml'),
        [
          'services:',
          '  db:',
          '    image: busybox:1.36',
          '    cmd: sleep 60',
          '    volumes: [/var/run/docker.sock:/var/run/docker.sock]',
          'tasks:',
          '  reach:',
          '    image: busybox:1.36',
          '    needs: [db]',
          '    cmds: [ls /]',
          '',
        ].join('\n')
      )
      const result = (await run(directory, 'reach', undefined, { volumeScope: scope })).pop()
      expect(result).toMatchObject({ kind: 'result', ok: false })
      expect((result as { error?: string }).error).toContain(
        "db: volume /var/run/docker.sock is not a volume name, a path of the server can't be mounted"
      )
    }),
    60_000
  )
})
