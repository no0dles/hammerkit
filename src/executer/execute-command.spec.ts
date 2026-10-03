import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeCommand } from './execute-command'
import { environmentMock } from './environment-mock'
import { AbortError } from './abort'
import { sleep } from '../utils/sleep'

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
