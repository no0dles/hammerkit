import { KubernetesInstance } from './kubernetes-instance'
import { statusCodeOf } from './apply'

/**
 * Idempotently make sure `namespace` exists. hammerkit does not otherwise
 * create namespaces — deployments/services/jobs are applied straight into
 * `env.namespace` and silently fail to schedule if it is missing. Creating it
 * up front lets build files (and the integration suite) use per-job /
 * per-suite namespaces for isolation without a separate `kubectl create ns`.
 *
 * Safe to call concurrently: a 409 from a racing create is treated as success.
 */
export async function ensureNamespace(instance: KubernetesInstance, namespace: string): Promise<void> {
  try {
    await instance.coreApi.readNamespace({ name: namespace })
    return
  } catch (e) {
    if (statusCodeOf(e) !== 404) {
      throw e
    }
  }

  try {
    await instance.coreApi.createNamespace({
      body: {
        metadata: {
          name: namespace,
          labels: { 'hammerkit.dev/managed': 'true' },
        },
      },
    })
  } catch (e) {
    // another worker created it between our read and create
    if (statusCodeOf(e) !== 409) {
      throw e
    }
  }
}
