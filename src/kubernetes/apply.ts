import { KubernetesObject, V1Deployment } from '@kubernetes/client-node'
import { KubernetesInstance } from './kubernetes-instance'

export type KubernetesObjectHeader = {
  metadata: {
    name: string
    namespace: string
  }
} & Pick<KubernetesObject, 'apiVersion' | 'kind'>

// The client throws an ApiException carrying the HTTP status as `code`; watch
// errors carry it as `statusCode`.
export function statusCodeOf(e: unknown): number | undefined {
  const err = e as { code?: unknown; statusCode?: number }
  return typeof err?.code === 'number' ? err.code : err?.statusCode
}

export async function apply<T extends KubernetesObject>(
  instance: KubernetesInstance,
  spec: T & KubernetesObjectHeader
): Promise<T> {
  try {
    await instance.objectApi.read(spec)
    return await instance.objectApi.patch(spec)
  } catch (e) {
    try {
      return await instance.objectApi.create(spec)
    } catch (createError) {
      // Two work items can apply the same object concurrently (e.g. a volume
      // shared between a task and a service that inherits its generates). If we
      // lost the create race, the object now exists — read it back instead of
      // failing the whole item.
      if (statusCodeOf(createError) === 409) {
        return await instance.objectApi.read<T>(spec)
      }
      throw createError
    }
  }
}

/**
 * Makes the object exactly as given: replaced as a whole when it exists, so what was
 * dropped from it goes too, which a merge patch would keep (a key of a quota, a rule
 * of a policy).
 */
export async function replace<T extends KubernetesObject>(
  instance: KubernetesInstance,
  spec: T & KubernetesObjectHeader
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let current: KubernetesObject | undefined
    try {
      current = await instance.objectApi.read(spec)
    } catch (e) {
      if (statusCodeOf(e) !== 404) {
        throw e
      }
      try {
        return await instance.objectApi.create(spec)
      } catch (createError) {
        if (statusCodeOf(createError) !== 409) {
          throw createError
        }
        current = await instance.objectApi.read(spec)
      }
    }
    try {
      return await instance.objectApi.replace<T>({
        ...spec,
        metadata: { ...spec.metadata, resourceVersion: current.metadata?.resourceVersion },
      })
    } catch (e) {
      // replaced by someone else since it was read (the server sets up a caller's
      // namespace for a run and for a sandbox at the same time): read it again
      if (statusCodeOf(e) !== 409 || attempt >= 3) {
        throw e
      }
    }
  }
}

/**
 * Makes a Deployment exactly as given, as `replace` does, with a JSON patch of all of it:
 * the runRole of a server has `patch` on Deployments, not `update` (see the backend docs).
 * The patch applies only to the version it read, another change in between reads it again.
 */
export async function replaceDeployment(
  instance: KubernetesInstance,
  spec: V1Deployment & KubernetesObjectHeader
): Promise<V1Deployment> {
  const { name, namespace } = spec.metadata
  for (let attempt = 1; ; attempt++) {
    let current: V1Deployment
    try {
      current = await instance.appsApi.readNamespacedDeployment({ name, namespace })
    } catch (e) {
      if (statusCodeOf(e) !== 404) {
        throw e
      }
      try {
        return await instance.appsApi.createNamespacedDeployment({ namespace, body: spec })
      } catch (createError) {
        if (statusCodeOf(createError) !== 409 || attempt >= 3) {
          throw createError
        }
        continue
      }
    }
    try {
      return await instance.appsApi.patchNamespacedDeployment({
        name,
        namespace,
        body: [
          { op: 'test', path: '/metadata/resourceVersion', value: current.metadata?.resourceVersion },
          { op: 'add', path: '/metadata/labels', value: spec.metadata.labels ?? {} },
          { op: 'add', path: '/metadata/annotations', value: spec.metadata.annotations ?? {} },
          { op: 'add', path: '/spec', value: spec.spec },
        ],
      })
    } catch (e) {
      // changed since it was read: its test fails (422), or a conflict (409)
      const code = statusCodeOf(e)
      if ((code !== 409 && code !== 422) || attempt >= 3) {
        throw e
      }
    }
  }
}
