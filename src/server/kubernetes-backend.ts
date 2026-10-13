import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { V1LimitRange, V1ResourceQuota } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader, statusCodeOf } from '../kubernetes/apply'
import { getRunLabelValue, RUN_LABEL } from '../kubernetes/job-placement'
import { createKubernetesInstances, KubernetesInstance } from '../kubernetes/kubernetes-instance'
import { getErrorMessage } from '../log'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { getVersion } from '../version'
import { HostExecutor, HostExecutorOptions, RunPlacement } from './executor'
import { Run, RunContext, RunExecutor } from './runs'
import { KubernetesBackend, ServerConfig } from './server-config'

// the name of the quota and limit range the server keeps in a caller's namespace
const POLICY_NAME = 'hammerkit'
// where a pod of the cluster finds the token and certificate of its ServiceAccount
const IN_CLUSTER_NAMESPACE = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'

/**
 * The namespace of a caller: the prefix and a hash of their issuer and subject. A
 * subject is the caller's own, so nobody else's runs, claims or quota are in it.
 */
export function getCallerNamespace(prefix: string, owner: { iss: string; sub: string }): string {
  return `${prefix}${createHash('sha256').update(`${owner.iss}\0${owner.sub}`).digest('hex').slice(0, 16)}`
}

// How the server and the processes of its runs reach the cluster: a kubeconfig and
// context the operator names, else the server's default kubeconfig, else the cluster
// the server runs in (its pod's ServiceAccount, found through the variables
// Kubernetes sets in every pod, which a run's process gets too).
export function getClusterAccess(
  backend: KubernetesBackend,
  processEnvs: { [key: string]: string | undefined }
): { kubeConfig?: string; context?: string; env: { [key: string]: string } } {
  if (backend.kubeconfig) {
    return { kubeConfig: backend.kubeconfig, context: backend.context, env: {} }
  }
  const fallback = processEnvs.KUBECONFIG?.split(process.platform === 'win32' ? ';' : ':')[0]
  const kubeConfig = fallback || join(processEnvs.HOME ?? homedir(), '.kube', 'config')
  if (existsSync(kubeConfig)) {
    return { kubeConfig, context: backend.context, env: {} }
  }
  const env: { [key: string]: string } = {}
  for (const name of ['KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT']) {
    const value = processEnvs[name]
    if (value) {
      env[name] = value
    }
  }
  return { context: backend.context, env }
}

function readInClusterNamespace(): string | undefined {
  try {
    return readFileSync(IN_CLUSTER_NAMESPACE, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Runs the tasks of runs as Jobs on a cluster. A run is planned and driven by a
 * process of the server as on a host (see HostExecutor); what changes is where its
 * container tasks and services go: into the caller's namespace, on the nodes of the
 * operator's pools, with the secrets of providers read in the Job itself. The runs
 * of one caller execute one after the other, since the objects of a task are named
 * by its cache id in the caller's namespace; different callers run side by side.
 * When a run ends, everything made for it is removed.
 */
export class KubernetesExecutor implements RunExecutor {
  // the registry keeps a caller's next run in its queue, not running and timed here
  readonly runningPerCaller = 1
  private readonly host: HostExecutor
  private readonly instance: KubernetesInstance
  private readonly access: ReturnType<typeof getClusterAccess>
  private readonly namespace: string
  // the run that executes, or the last one waiting, per caller namespace
  private readonly queues = new Map<string, Promise<void>>()

  constructor(
    private readonly config: ServerConfig & { backend: KubernetesBackend },
    processEnvs: { [key: string]: string | undefined },
    options: Omit<HostExecutorOptions, 'placement'>
  ) {
    this.access = getClusterAccess(config.backend, processEnvs)
    this.instance = createKubernetesInstances({
      type: 'kubernetes',
      namespace: 'default',
      kubeConfig: this.access.kubeConfig,
      context: this.access.context,
      httpRoutes: [],
    })
    const namespace = config.backend.namespace ?? readInClusterNamespace()
    if (!namespace) {
      throw new Error(
        'backend.namespace: name the namespace of the server, where the credentials of the accounts are; ' +
          'it is only found on its own in a pod of the cluster'
      )
    }
    this.namespace = namespace
    this.host = new HostExecutor({ ...options, placement: this.placement() })
  }

  execute(run: Run, context: RunContext): Promise<void> {
    const namespace = getCallerNamespace(this.config.backend.namespacePrefix, run.owner)
    const previous = this.queues.get(namespace) ?? Promise.resolve()
    const execution = previous.then(() => {
      if (context.signal.aborted) {
        throw new Error('the run was cancelled')
      }
      return this.host.execute(run, context)
    })
    const settled = execution.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(namespace, settled)
    settled.then(() => {
      if (this.queues.get(namespace) === settled) {
        this.queues.delete(namespace)
      }
    })
    return execution
  }

  private placement(): RunPlacement {
    const backend = this.config.backend
    return {
      prepare: async (run: Run, context: RunContext) => {
        const namespace = getCallerNamespace(backend.namespacePrefix, run.owner)
        await this.prepareNamespace(namespace)
        context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `runs in the namespace ${namespace}` })
        const kubernetes: WorkKubernetesEnvironment = {
          type: 'kubernetes',
          namespace,
          kubeConfig: this.access.kubeConfig,
          context: this.access.context,
          httpRoutes: [],
          storageClass: backend.storageClass,
          server: {
            run: run.id,
            namespace: this.namespace,
            pools: backend.pools,
            providers: backend.providers,
            accounts: Object.fromEntries(
              Object.entries(this.config.accounts).flatMap(([name, account]) =>
                account.kubernetes ? [[name, account.kubernetes]] : []
              )
            ),
          },
        }
        return { kubernetes, env: this.access.env }
      },
      release: async (run: Run, context: RunContext) => {
        const namespace = getCallerNamespace(backend.namespacePrefix, run.owner)
        try {
          await removeRunObjects(this.instance, namespace, run.id)
        } catch (e) {
          context.emit({
            type: 'log',
            task: 'hammerkit',
            stream: 'stderr',
            text: `what the run made in ${namespace} could not be removed: ${getErrorMessage(e)}`,
          })
        }
      },
    }
  }

  // The caller's namespace with the operator's quota, and default requests for
  // containers without resources so they are admitted under a quota on compute.
  private async prepareNamespace(namespace: string): Promise<void> {
    const backend = this.config.backend
    try {
      await this.instance.coreApi.readNamespace({ name: namespace })
    } catch (e) {
      if (statusCodeOf(e) !== 404) {
        throw e
      }
      try {
        await this.instance.coreApi.createNamespace({
          body: {
            metadata: {
              name: namespace,
              labels: { 'hammerkit.dev/managed': 'true', 'hammerkit.dev/caller': namespace },
            },
          },
        })
      } catch (createError) {
        if (statusCodeOf(createError) !== 409) {
          throw createError
        }
      }
    }
    const metadata = {
      name: POLICY_NAME,
      namespace,
      annotations: { 'hammerkit.dev/version': getVersion() },
      labels: { 'hammerkit.dev/managed': 'true' },
    }
    if (backend.quota) {
      const quota: V1ResourceQuota & KubernetesObjectHeader = {
        apiVersion: 'v1',
        kind: 'ResourceQuota',
        metadata,
        spec: { hard: backend.quota },
      }
      await apply(this.instance, quota)
    }
    if (backend.defaultResources) {
      const limits: V1LimitRange & KubernetesObjectHeader = {
        apiVersion: 'v1',
        kind: 'LimitRange',
        metadata,
        spec: {
          limits: [
            {
              type: 'Container',
              ...(backend.defaultResources.requests ? { defaultRequest: backend.defaultResources.requests } : {}),
              ...(backend.defaultResources.limits ? { _default: backend.defaultResources.limits } : {}),
            },
          ],
        },
      }
      await apply(this.instance, limits)
    }
  }
}

// Everything a run made in the caller's namespace, by its label: Jobs with their
// pods, Deployments (services and egress proxies), Services, claims, Secrets and
// the NetworkPolicies of limited networks, which go last so no pod of the run
// outlives its policy.
export async function removeRunObjects(instance: KubernetesInstance, namespace: string, run: string): Promise<void> {
  const labelSelector = `${RUN_LABEL}=${getRunLabelValue(run)}`
  const selector = { namespace, labelSelector }
  await instance.batchApi.deleteCollectionNamespacedJob({ ...selector, propagationPolicy: 'Background' })
  await instance.appsApi.deleteCollectionNamespacedDeployment({ ...selector, propagationPolicy: 'Background' })
  await instance.coreApi.deleteCollectionNamespacedPod({ ...selector, gracePeriodSeconds: 0 })
  await instance.coreApi.deleteCollectionNamespacedService(selector)
  await instance.coreApi.deleteCollectionNamespacedSecret(selector)
  await instance.coreApi.deleteCollectionNamespacedPersistentVolumeClaim(selector)
  const policies = await instance.objectApi.list(
    'networking.k8s.io/v1',
    'NetworkPolicy',
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector
  )
  for (const policy of policies.items) {
    // the items of a list do not say their kind
    const metadata = { name: policy.metadata?.name, namespace }
    await instance.objectApi
      .delete({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata })
      .catch((e) => {
        if (statusCodeOf(e) !== 404) {
          throw e
        }
      })
  }
}
