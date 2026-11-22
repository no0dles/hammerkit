import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { getRunnerScripts, RunnerScripts, RUNNER_TOOLS_IMAGE } from './sandbox-runner'

// The scripts of the runner as a runner runs them, under a real busybox: the one
// HAMMERKIT_TEST_BUSYBOX names (CI copies the runner's own out of its tools image), else one on
// the PATH. The scripts read /proc, so only Linux runs them. The variable may be relative to
// the working directory. A file it names that is not there fails in CI, and skips elsewhere.
function findBusybox(): string | undefined {
  if (process.platform !== 'linux') {
    return undefined
  }
  const given = process.env.HAMMERKIT_TEST_BUSYBOX
  if (given) {
    const path = resolve(given)
    if (existsSync(path)) {
      return path
    }
    const message = `HAMMERKIT_TEST_BUSYBOX names ${given}, which is not there`
    if (process.env.CI) {
      throw new Error(message)
    }
    process.stderr.write(`${message}: the scripts of the runner are not run under a real busybox\n`)
  }
  const found = spawnSync('sh', ['-c', 'command -v busybox'], { encoding: 'utf8' })
  return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : undefined
}

const busybox = findBusybox()

// The job that runs the unit specs on Linux copies the busybox out of the tools image. The
// workflow is not in the sources of that task, so this runs where the checkout is (Windows).
const workflowFile = join(__dirname, '..', '..', '.github', 'workflows', 'test.yaml')
it.runIf(existsSync(workflowFile))('runs the scripts in CI under the busybox of the runner', () => {
  expect(readFileSync(workflowFile, 'utf8')).toContain(`docker create ${RUNNER_TOOLS_IMAGE}`)
})

describe.runIf(busybox)('the scripts of the runner, under a real busybox', () => {
  let root: string
  let sandbox: string
  let scripts: RunnerScripts
  let directory: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hammerkit-runner-scripts-'))
    sandbox = join(root, 'sandbox')
    mkdirSync(join(root, 'scratch'), { recursive: true })
    mkdirSync(sandbox)
    // the clean up of a runner kills every process of its container: here it empties a folder
    scripts = getRunnerScripts(`${busybox} rm -rf ${join(root, 'scratch')}/*`, [], {
      busybox: busybox as string,
      sandbox,
    })
    directory = join(sandbox, '.hammerkit', 'commands', 'a'.repeat(24), 'b'.repeat(24))
  })

  afterEach(() => {
    // what a test left running goes with its process group
    const commands = join(sandbox, '.hammerkit', 'commands')
    for (const run of existsSync(commands) ? readdirSync(commands) : []) {
      sh(scripts.remove, [join(commands, run), ''])
    }
    rmSync(root, { recursive: true, force: true })
  })

  function sh(script: string, args: string[]): { out: string; err: string; status: number | null } {
    const result = spawnSync(busybox as string, ['sh', '-c', script, 'hammerkit', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
    })
    return { out: result.stdout, err: result.stderr, status: result.status }
  }

  const start = (command: string, mode: 'fresh' | 'adopt' = 'fresh', nonce = 'n1', cwd = sandbox) =>
    sh(scripts.start, [directory, mode, nonce, join(root, 'run'), cwd, 'sh', '-c', command]).out.trim()
  const status = () => sh(scripts.status, [directory]).out.trim()

  async function until(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 300 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(condition(), what).toBe(true)
  }

  it('runs a command apart, follows a partial line from an offset, and writes the exit code after the output', async () => {
    expect(start(`printf 'one\\ntw'; sleep 1; printf 'o\\n'; echo oops >&2; exit 7`)).toBe('started')
    expect(status()).toBe('running')
    // the start of a command that runs takes it, by its nonce
    expect(start('echo never', 'adopt', 'n1')).toBe('running')
    // the link of the run's directory leads to the files
    expect(statSync(join(root, 'run')).isDirectory()).toBe(true)
    let complete = true
    await until(() => {
      if (existsSync(join(directory, 'exit'))) {
        complete &&= readFileSync(join(directory, 'out'), 'utf8') === 'one\ntwo\n'
        return true
      }
      return false
    }, 'the command ended')
    expect(complete).toBe(true)
    expect(status()).toBe('finished 7')
    expect(sh(scripts.follow, [directory, '0', '0'])).toEqual({ out: 'one\ntwo\n', err: 'oops\n', status: 0 })
    // from the end of the last whole line the log has
    expect(sh(scripts.follow, [directory, '4', '0'])).toEqual({ out: 'two\n', err: 'oops\n', status: 0 })
    expect(sh(scripts.follow, [directory, '8', '5'])).toEqual({ out: '', err: '', status: 0 })
  })

  it('follows a command that runs until it ended', async () => {
    expect(start(`echo first; sleep 1; echo second`)).toBe('started')
    expect(sh(scripts.follow, [directory, '0', '0'])).toEqual({ out: 'first\nsecond\n', err: '', status: 0 })
    expect(status()).toBe('finished 0')
  })

  it('keeps 4 MiB of an output of 5, and the command goes on', async () => {
    expect(start(`head -c 5242880 /dev/zero | tr '\\0' a; echo; echo still-going >&2; exit 3`)).toBe('started')
    await until(() => existsSync(join(directory, 'exit')), 'the command ended')
    expect(status()).toBe('finished 3')
    expect(statSync(join(directory, 'out')).size).toBe(4 * 1024 * 1024)
    expect(readFileSync(join(directory, 'err'), 'utf8')).toBe('still-going\n')
  })

  it('kills the process group of a cancelled command, and marks it cancelled', async () => {
    expect(start(`sleep 30 & sleep 30`)).toBe('started')
    const pid = Number(readFileSync(join(directory, 'pid'), 'utf8').split(' ')[1])
    expect(() => process.kill(-pid, 0)).not.toThrow()
    expect(sh(scripts.cancel, [directory]).status).toBe(0)
    await until(() => {
      try {
        process.kill(-pid, 0)
        return false
      } catch {
        return true
      }
    }, 'the group is gone')
    expect(status()).toBe('cancelled')
    expect(sh(scripts.follow, [directory, '0', '0']).status).toBe(0)
    // a start after it does not start it again
    expect(start('echo again')).toBe('cancelled')
  })

  it('does not start a command a cancel came before', () => {
    expect(sh(scripts.cancel, [directory]).status).toBe(0)
    expect(start('echo never')).toBe('cancelled')
    expect(existsSync(join(directory, 'out'))).toBe(false)
  })

  it('starts a command anew whose directory something else filled, and takes it only when told it is the run’s', async () => {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'exit'), '0\n')
    writeFileSync(join(directory, 'out'), 'forged\n')
    // a resumed run whose log says it started it takes what is there
    expect(start('echo never', 'adopt', '')).toBe('finished 0')
    // a start again after a broken connection only its own
    expect(start('echo ran', 'adopt', 'other')).toBe('started')
    await until(() => existsSync(join(directory, 'exit')), 'the command ended')
    expect(readFileSync(join(directory, 'out'), 'utf8')).toBe('ran\n')
  })

  it('does not take a pid that is not the wrapper of the command for one that runs', () => {
    mkdirSync(directory, { recursive: true })
    const host = spawnSync(busybox as string, ['hostname'], { encoding: 'utf8' }).stdout.trim()
    // a process that lives, but is something else
    writeFileSync(join(directory, 'pid'), `${host} ${process.pid}\n`)
    expect(status()).toBe('none')
    writeFileSync(join(directory, 'pid'), `${host} ../1\n`)
    expect(status()).toBe('none')
    expect(sh(scripts.follow, [directory, '0', '0']).status).toBe(3)
  })

  it('marks a command that did not run as the runner changed', async () => {
    // its directory is not one of the sandbox
    expect(start('echo never', 'fresh', 'n1', root)).toBe('started')
    await until(() => existsSync(join(directory, 'exit')), 'the wrapper ended')
    expect(status()).toBe('finished 125 changed')
  })

  it('kills what a run still runs and removes its commands, and the files of other runs at the next start', async () => {
    expect(start(`sleep 30`)).toBe('started')
    const pid = Number(readFileSync(join(directory, 'pid'), 'utf8').split(' ')[1])
    const runDirectory = join(sandbox, '.hammerkit', 'commands', 'a'.repeat(24))
    expect(sh(scripts.find, [runDirectory]).out.trim()).toBe('yes')
    expect(sh(scripts.remove, [runDirectory, '']).status).toBe(0)
    await until(() => {
      try {
        process.kill(-pid, 0)
        return false
      } catch {
        return true
      }
    }, 'the group is gone')
    expect(existsSync(runDirectory)).toBe(false)

    // what another run left goes, but not what only lies next to the runs
    const other = join(sandbox, '.hammerkit', 'commands', 'c'.repeat(24))
    const kept = join(sandbox, '.hammerkit', 'commands', 'not-a-run')
    mkdirSync(other, { recursive: true })
    mkdirSync(kept, { recursive: true })
    expect(start('echo next')).toBe('started')
    expect(existsSync(other)).toBe(false)
    expect(existsSync(kept)).toBe(true)
  })
})
