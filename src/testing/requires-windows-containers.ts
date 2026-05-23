import { isCI } from '../utils/ci'

export function requiresWindowsContainers(fn: () => Promise<any>): () => Promise<any> {
  if (process.env.WINDOWS_CONTAINERS) {
    return fn
  }
  if (process.env.HAMMERKIT_FULL_INTEGRATION) {
    return () => Promise.reject(new Error('WINDOWS_CONTAINERS not set but HAMMERKIT_FULL_INTEGRATION is on'))
  }
  if (isCI) {
    return () => Promise.resolve()
  }
  return fn
}
