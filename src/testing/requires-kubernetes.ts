import { isCI } from '../utils/ci'

export function requiresKubernetes(fn: () => Promise<any>): () => Promise<any> {
  if (!process.env.CLUSTER_NAME && isCI) {
    return () => Promise.resolve()
  }
  return fn
}
