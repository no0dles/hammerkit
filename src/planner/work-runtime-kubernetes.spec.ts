import { V1ContainerStatus } from '@kubernetes/client-node'
import { describeFailedJob } from './work-runtime-kubernetes'
import { KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { WorkKubernetesEnvironment } from './work-environment'
import { JobSecret } from '../kubernetes/job-secrets'
import { WorkSecret } from './work-secret'
import { NETWORK_GATE_CONTAINER } from '../kubernetes/network-gate'

describe('describeFailedJob', () => {
  const env: WorkKubernetesEnvironment = {
    type: 'kubernetes',
    namespace: 'demo',
    context: 'ctx',
    httpRoutes: [],
    networkPolicyEnforced: true,
  }
  const secret: JobSecret = {
    index: 0,
    secret: {
      source: { type: 'provider', provider: 'files', ref: 'missing', account: 'ci' },
      target: { type: 'env', name: 'API_KEY' },
    } as WorkSecret,
    source: { provider: 'files', ref: 'missing', account: 'ci' } as any,
  }

  function failed(name: string, exitCode: number, message?: string): V1ContainerStatus {
    return {
      name,
      image: 'alpine',
      imageID: '',
      ready: false,
      restartCount: 0,
      state: { terminated: { exitCode, reason: 'Error', message } },
    }
  }

  function job(statuses: V1ContainerStatus[], containerStatuses: V1ContainerStatus[] = []): KubernetesInstance {
    return {
      coreApi: {
        listNamespacedPod: async () => ({
          items: [
            { metadata: { name: 'build-job-x' }, status: { initContainerStatuses: statuses, containerStatuses } },
          ],
        }),
      },
    } as unknown as KubernetesInstance
  }

  it('says the network policy was not in force when the gate failed', async () => {
    const message = 'hammerkit: the network policy of this pod is not enforced, it still reaches 10.96.0.10'
    expect(
      await describeFailedJob(job([failed(NETWORK_GATE_CONTAINER, 1, message)]), env, 'build', 'build-job', 'cmd-1', [])
    ).toEqual({ type: 'error', message: `build: ${message}` })
  })

  it('names the secret an init container could not read, never its output', async () => {
    const instance = job([failed(NETWORK_GATE_CONTAINER, 0), failed('secret-0', 1)])
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-1', [secret])).toEqual({
      type: 'error',
      message: 'secret API_KEY (files:missing as ci) could not be read: Error 1',
    })
  })

  it('leaves the reason to the command when every init container succeeded', async () => {
    const instance = job([failed(NETWORK_GATE_CONTAINER, 0), failed('secret-0', 0)])
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-1', [secret])).toBeUndefined()
  })

  it('gives the exit code of the command, as a crash on a host', async () => {
    const instance = job([failed(NETWORK_GATE_CONTAINER, 0)], [failed('cmd-2', 0), failed('cmd-1', 3)])
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-1', [])).toEqual({
      type: 'crash',
      exitCode: 3,
    })
    expect(await describeFailedJob(instance, env, 'build', 'build-job', 'cmd-2', [])).toBeUndefined()
  })
})
