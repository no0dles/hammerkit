import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { getRunLabelValue, RUN_LABEL } from './job-placement'
import { ID_LABEL } from './resources'
import { statusCodeOf } from './apply'

/**
 * What a service run made for items it has no more, once it moved to another commit: the
 * Deployment, Service, Secret, policies and Jobs of a service or task whose id changed (a new
 * image, other volumes). Their claims stay, with the namespace of the run.
 */
export async function removeStaleItems(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  ids: string[]
): Promise<void> {
  if (!env.server) {
    return
  }
  const namespace = env.namespace
  const labelSelector = getStaleItemSelector(env.server.run, ids)
  const selector = { namespace, labelSelector }
  await instance.appsApi.deleteCollectionNamespacedDeployment({ ...selector, propagationPolicy: 'Background' })
  await instance.batchApi.deleteCollectionNamespacedJob({ ...selector, propagationPolicy: 'Background' })
  await instance.coreApi.deleteCollectionNamespacedService(selector)
  await instance.coreApi.deleteCollectionNamespacedSecret(selector)
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

// the objects of the run's items but those of `ids`
export function getStaleItemSelector(run: string, ids: string[]): string {
  const current = [...new Set(ids)].sort()
  return [
    `${RUN_LABEL}=${getRunLabelValue(run)}`,
    ID_LABEL,
    ...(current.length > 0 ? [`${ID_LABEL} notin (${current.join(',')})`] : []),
  ].join(',')
}
