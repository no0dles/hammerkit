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
    // try to get the resource, if it does not exist an error will be thrown and we will end up in the catch
    // block.
    await instance.objectApi.read(spec)
    // we got the resource, so it exists, so patch it
    //
    // Note that this could fail if the spec refers to a custom resource. For custom resources you may need
    // to specify a different patch merge strategy in the content-type header.
    //
    // See: https://github.com/kubernetes/kubernetes/issues/97423
    const response = await instance.objectApi.patch(spec)
    return response.body
  } catch (e) {
    // we did not get the resource, so it does not exist, so create it
    const response = await instance.objectApi.create(spec)
    return response.body
  }
}
