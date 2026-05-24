import { KubernetesObject } from '@kubernetes/client-node/dist/types'
import { KubernetesInstance } from './kubernetes-instance'

export type KubernetesObjectHeader = {
  metadata: {
    name: string
    namespace: string
  }
} & Pick<KubernetesObject, 'apiVersion' | 'kind'>

function statusCodeOf(e: unknown): number | undefined {
  const err = e as { statusCode?: number; response?: { statusCode?: number }; body?: { code?: number } }
  return err?.statusCode ?? err?.response?.statusCode ?? err?.body?.code
}

export async function apply<T extends KubernetesObject>(
  instance: KubernetesInstance,
  spec: T & KubernetesObjectHeader
) {
  try {
    await instance.objectApi.read(spec)
    const response = await instance.objectApi.patch(spec)
    return response.body
  } catch (e) {
    try {
      const response = await instance.objectApi.create(spec)
      return response.body
    } catch (createError) {
      // Two work items can apply the same object concurrently (e.g. a volume
      // shared between a task and a service that inherits its generates). If we
      // lost the create race, the object now exists — read it back instead of
      // failing the whole item.
      if (statusCodeOf(createError) === 409) {
        const response = await instance.objectApi.read(spec)
        return response.body as T & KubernetesObjectHeader
      }
      throw createError
    }
  }
}
