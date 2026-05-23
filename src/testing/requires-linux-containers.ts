import { isCI } from '../utils/ci'

export function requiresLinuxContainers(fn: () => Promise<any>): () => Promise<any> {
  if (process.env.LINUX_CONTAINERS) {
    return fn
  }
  if (process.env.HAMMERKIT_FULL_INTEGRATION) {
    return () => Promise.reject(new Error('LINUX_CONTAINERS not set but HAMMERKIT_FULL_INTEGRATION is on'))
  }
  if (isCI) {
    return () => Promise.resolve()
  }
  return fn
}
