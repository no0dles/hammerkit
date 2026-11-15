import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeCommand, processEnv } from './execute-command'
import { environmentMock } from './environment-mock'
import { AbortError } from './abort'
import { sleep } from '../utils/sleep'
import { createSecretRegistry } from '../utils/redact'
import { statusConsole } from '../planner/work-item-status'
import { emptyWritable } from '../utils/empty-writable'

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

async function readPid(file: string): Promise<number> {
  for (let i = 0; i < 50; i++) {
    try {
      const pid = parseInt(readFileSync(file, 'utf8'), 10)
      if (pid) {
        return pid
      }
    } catch {
      // not written yet
    }
    await sleep(50)
  }
  throw new Error('command did not start')
}

describe('processEnv', () => {
  // a copy of process.env on Windows names PATH `Path`
  const envs = { Path: 'C:\\Windows', PSModulePath: 'C:\\Modules' }

  it('finds a variable whatever the case of its name on Windows', () => {
    expect(processEnv(envs, 'PATH', true)).toBe('C:\\Windows')
    expect(processEnv({ ...envs, PATH: 'exact' }, 'PATH', true)).toBe('exact')
    expect(processEnv(envs, 'PSModulePath', true)).toBe('C:\\Modules')
    expect(processEnv(envs, 'HOME', true)).toBeUndefined()
  })

  it('keeps names apart by their case elsewhere', () => {
    expect(processEnv(envs, 'PATH', false)).toBeUndefined()
    expect(processEnv({ PATH: '/usr/bin' }, 'PATH', false)).toBe('/usr/bin')
  })
})

describe.skipIf(process.platform === 'win32')('executeCommand abort', () => {
  let cwd: string
  const previous = process.env.HAMMERKIT_STOP_TIMEOUT_MS

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hammerkit-execute-command-'))
    process.env.HAMMERKIT_STOP_TIMEOUT_MS = '300'
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    if (previous === undefined) {
      delete process.env.HAMMERKIT_STOP_TIMEOUT_MS
    } else {
      process.env.HAMMERKIT_STOP_TIMEOUT_MS = previous
    }
  })

  it('kills a process group that ignores SIGTERM after the stop timeout', async () => {
    const environment = environmentMock(cwd)
    const abort = new AbortController()
    const run = executeCommand(
      environment.status.context({ type: 'task', name: 'stubborn' } as any),
      abort.signal,
      cwd,
      `trap '' TERM; echo $$ > pid; sleep 30 & wait`,
      {},
      environment
    )
    const pid = await readPid(join(cwd, 'pid'))

    abort.abort()
    await sleep(100)
    expect(isGroupAlive(pid)).toBe(true)

    await expect(run).rejects.toBeInstanceOf(AbortError)
    await sleep(600)
    expect(isGroupAlive(pid)).toBe(false)
  })

  it('stops a well-behaved command with SIGTERM', async () => {
    const environment = environmentMock(cwd)
    const abort = new AbortController()
    const run = executeCommand(
      environment.status.context({ type: 'task', name: 'polite' } as any),
      abort.signal,
      cwd,
      `echo $$ > pid; sleep 30`,
      {},
      environment
    )
    const pid = await readPid(join(cwd, 'pid'))

    abort.abort()

    await expect(run).rejects.toBeInstanceOf(AbortError)
    await sleep(200)
    expect(isGroupAlive(pid)).toBe(false)
  })
})

// what a command prints is logged by the line, whole, however it arrived: the last line
// without a line feed too, and a secret it prints in two writes is masked
describe.skipIf(process.platform === 'win32')('executeCommand output', () => {
  const SECRET = 'sup3r-s3cret-value'

  async function logsOf(command: string): Promise<string[]> {
    const cwd = mkdtempSync(join(tmpdir(), 'hammerkit-execute-output-'))
    try {
      const secrets = createSecretRegistry()
      secrets.register(SECRET)
      const status = statusConsole(emptyWritable(), secrets)
      const logged: string[] = []
      status.on((message) => {
        if (message.type === 'console') {
          logged.push(`${message.console}:${message.message}`)
        }
      })
      const environment = { ...environmentMock(cwd), processEnvs: { PATH: process.env.PATH } }
      const code = await executeCommand(
        status.context({ type: 'task', name: 'print' }),
        new AbortController().signal,
        cwd,
        command,
        {},
        environment
      )
      expect(code).toBe(0)
      return logged
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it('logs a line it printed in two writes as one line', async () => {
    expect(await logsOf("printf 'ab'; sleep 0.1; printf 'cd\\n'")).toEqual(['stdout:abcd'])
  })

  it('logs its last line without a line feed', async () => {
    expect(await logsOf("printf 'first\\n'; printf 'tail' >&2")).toEqual(['stdout:first', 'stderr:tail'])
  })

  it('masks a secret it printed in two writes', async () => {
    expect(
      await logsOf(`printf '%s' 'token=${SECRET.slice(0, 5)}'; sleep 0.1; printf '%s done\\n' '${SECRET.slice(5)}'`)
    ).toEqual(['stdout:token=*** done'])
  })
})
