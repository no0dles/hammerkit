import { isCI } from '../utils/ci'

export function requiresKubernetes(fn: () => Promise<any>): () => Promise<any> {
  if (process.env.CLUSTER_NAME) {
    return fn
  }
  if (process.env.HAMMERKIT_FULL_INTEGRATION) {
    return () => Promise.reject(new Error('CLUSTER_NAME not set but HAMMERKIT_FULL_INTEGRATION is on'))
  }
  if (isCI) {
    return () => Promise.resolve()
  }
  return fn
}
