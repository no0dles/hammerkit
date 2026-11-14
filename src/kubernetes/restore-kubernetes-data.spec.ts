import { execFileSync } from 'child_process'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Readable } from 'stream'
import { RESTORE_FILE, restoreKubernetesData } from './restore-kubernetes-data'
import { storeKubernetesData } from './store-kubernetes-data'
import { clearStateFiles, getPodForPersistence } from './ensure-persistent-data'
import { getStateFilesDir } from './volumes'

vi.mock('./ensure-persistent-data', async (original) => ({
  ...(await original<object>()),
  clearStateFiles: vi.fn(async () => undefined),
  getPodForPersistence: vi.fn(),
}))
vi.mock('./volumes', async (original) => ({
  ...(await original<object>()),
  getKubernetesPersistence: vi.fn(async () => ({ volumes: [{ name: 'claim' }], mounts: [] })),
}))

// A restore of a task of a service run into the folder of its state, in the task's upload pod
describe('the restore of the outputs of a task of a service run', () => {
  const env = { type: 'kubernetes', namespace: 'hk-run', server: { run: 'run_1', serviceRun: true } } as any
  const task = {
    id: () => 'build',
    name: 'build',
    status: { write: vi.fn() },
    data: { type: 'container-task', cwd: '/repo', generates: [] },
  } as any
  const environment = { file: { exists: async () => false }, abortCtrl: new AbortController() } as any

  beforeEach(() => {
    vi.mocked(clearStateFiles).mockClear()
    vi.mocked(getPodForPersistence).mockImplementation(async (_i, _e, _w, _p, _t, _s, fn) => fn('build-upload'))
  })

  it('removes the folders of other states but the mounted ones, and empties its own first', async () => {
    const mounted = new Set([getStateFilesDir('key-1')])
    await restoreKubernetesData(task, env, {} as any, environment, '/cache', {
      stateKey: 'key-2',
      otherStates: mounted,
    })
    expect(clearStateFiles).toHaveBeenCalledWith({}, env, task, 'build-upload', getStateFilesDir('key-2'), mounted)
  })

  it('leaves the claim as it is without the states to keep', async () => {
    await restoreKubernetesData(task, env, {} as any, environment, '/cache', { stateKey: 'key-2' })
    expect(clearStateFiles).not.toHaveBeenCalled()
  })
})

// run_Kv-5lFVjvxEtgEjQ: `generates: [lcov.info]`, an output that is a file
describe('an output of a task that is a file', () => {
  const env = { type: 'kubernetes', namespace: 'hk-run' } as any
  const task = {
    id: () => 'coverage',
    name: 'coverage',
    status: { write: vi.fn() },
    data: {
      type: 'container-task',
      cwd: '/repo',
      projectRoot: '/repo',
      mounts: [],
      src: [],
      generates: [
        { path: '/repo/lcov.info', inherited: null, isFile: true },
        { path: '/repo/coverage', inherited: null, isFile: false },
      ],
    },
  } as any
  const exec = (commands: string[][]) => ({
    exec: {
      exec: async (_ns: string, _pod: string, _container: string, cmd: string[], out: any, _err: any, data: any) => {
        commands.push(cmd)
        const res = new EventEmitter()
        const done = () => {
          if (out && typeof out.end === 'function') {
            out.end()
          }
          res.emit('close')
        }
        if (data instanceof Readable) {
          data.on('end', done).resume()
        } else {
          setImmediate(done)
        }
        return res
      },
    },
  })

  beforeEach(() => {
    vi.mocked(getPodForPersistence).mockImplementation(async (_i, _e, _w, _p, _t, _s, fn) => fn('coverage-pod'))
  })

  it('is archived by its name and restored in its place, the folders as before', async () => {
    const commands: string[][] = []
    const environment = {
      file: {
        exists: async () => true,
        createWriteStream: () => new PassThrough(),
        readStream: () => Readable.from([]),
      },
      abortCtrl: new AbortController(),
    } as any
    await storeKubernetesData(task, env, exec(commands) as any, environment, '/cache')
    await restoreKubernetesData(task, env, exec(commands) as any, environment, '/cache')
    expect(commands).toEqual([
      ['tar', 'zcf', '-', '-C', '/repo', 'lcov.info'],
      ['tar', 'zcf', '-', '-C', '/repo/coverage', '.'],
      ['sh', '-c', RESTORE_FILE, 'sh', '/dev/hammerkit/coverage/lcov.info'],
      ['sh', '-c', 'mkdir -p "$1" && tar xzf - -C "$1"', 'sh', '/dev/hammerkit/coverage/coverage'],
    ])
  })

  it('takes the place of what is in the claim, by its content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hammerkit-output-file-'))
    try {
      mkdirSync(join(dir, 'repo'))
      writeFileSync(join(dir, 'repo', 'lcov.info'), 'TN:\nend_of_record\n')
      const archive = join(dir, 'lcov.tgz')
      execFileSync('sh', ['-c', 'tar zcf - -C "$1" lcov.info > "$2"', 'sh', join(dir, 'repo'), archive])
      // a directory an older version left, at a name with a hash (see getClaimSubPath)
      const target = join(dir, 'claim', 'lcov.info-0123456789ab')
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'left'), '')

      execFileSync('sh', ['-c', `${RESTORE_FILE} < "$2"`, 'sh', target, archive])

      expect(statSync(target).isFile()).toBe(true)
      expect(readFileSync(target, 'utf8')).toEqual('TN:\nend_of_record\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
