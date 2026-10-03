import { KubernetesObject } from '@kubernetes/client-node'
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
