import { KubernetesObject } from '@kubernetes/client-node/dist/types'
import { KubernetesInstance } from './kubernetes-instance'

export type KubernetesObjectHeader = {
  metadata: {
    name: string
    namespace: string
  }
} & Pick<KubernetesObject, 'apiVersion' | 'kind'>

export async function apply<T extends KubernetesObject>(
  instance: KubernetesInstance,
  spec: T & KubernetesObjectHeader
) {
  try {
    await instance.objectApi.read(spec)
    const response = await instance.objectApi.patch(spec)
    return response.body
  } catch (e) {
    const response = await instance.objectApi.create(spec)
    return response.body
  }
}
