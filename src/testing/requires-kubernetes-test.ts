import { isCI } from '../utils/ci'

export function requiresKubernetesTest(fn: () => Promise<any>): () => Promise<any> {
  if (!process.env.CLUSTER_NAME && isCI) {
    return () => Promise.resolve()
  }
  return fn
}
