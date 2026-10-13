import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { WorkerMessage, workerMain } from '../../server/run-worker'

// nothing but the loopback interface: no way out at all
const noInterfaces = 'test "$(ls /sys/class/net)" = lo'

// the process of a server run, with runs.network handed to it as the executor does
async function run(directory: string, task: string, network?: unknown): Promise<WorkerMessage[]> {
  const stdin = new PassThrough()
  stdin.end(
    JSON.stringify({
      entry: join(directory, '.hammerkit.yaml'),
      tasks: [task],
      options: { cache: 'none' },
      accounts: [],
      catalog: { providers: {}, accounts: {} },
      ...(network !== undefined ? { network } : {}),
    })
  )
  const chunks: string[] = []
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  await workerMain(stdin, stdout, { PATH: process.env.PATH }, directory, new AbortController())
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
