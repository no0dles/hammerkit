import { restoreKubernetesData } from './restore-kubernetes-data'
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
