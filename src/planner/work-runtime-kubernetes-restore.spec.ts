import { kubernetesTaskRuntime } from './work-runtime-kubernetes'
import { getStateDirsInUse } from '../kubernetes/ensure-persistent-data'
import { restoreKubernetesData } from '../kubernetes/restore-kubernetes-data'
import { getStateFilesDir } from '../kubernetes/volumes'

vi.mock('../kubernetes/kubernetes-instance', () => ({ createKubernetesInstances: () => ({}) }))
vi.mock('../kubernetes/ensure-persistent-data', async (original) => ({
  ...(await original<object>()),
  getStateDirsInUse: vi.fn(),
}))
vi.mock('../kubernetes/restore-kubernetes-data', () => ({ restoreKubernetesData: vi.fn() }))

// A move whose dep did not change restores its cache hit into the folder of the same state,
// which the pods of the services that stay up read.
describe('the restore of a task of a service run', () => {
  const env = { type: 'kubernetes', namespace: 'hk-run', server: { run: 'run_1', serviceRun: true } } as any
  const status = { write: vi.fn() }
  const task = {
    id: () => 'build',
    name: 'build',
    status,
    data: { type: 'container-task', name: 'build', cwd: '/repo' },
  } as any

  it('leaves the outputs of a state that pods of the run mount', async () => {
    vi.mocked(getStateDirsInUse).mockResolvedValue(new Set([getStateFilesDir('key-1')]))
    await kubernetesTaskRuntime(task, env).restore({} as any, '/cache', 'key-1')
    expect(restoreKubernetesData).not.toHaveBeenCalled()
    expect(status.write).toHaveBeenCalledWith(
      'info',
      'build: services of the run use its outputs of this state, they stay'
    )
  })

  it('restores the outputs of a state no pod mounts into its folder', async () => {
    vi.mocked(getStateDirsInUse).mockResolvedValue(new Set([getStateFilesDir('key-1')]))
    await kubernetesTaskRuntime(task, env).restore({} as any, '/cache', 'key-2')
    expect(restoreKubernetesData).toHaveBeenCalledWith(task, env, {}, {}, '/cache', { stateKey: 'key-2' })
  })
})
