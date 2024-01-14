import { isCI } from '../utils/ci'

export function requiresWindowsContainers(fn: () => Promise<any>): () => Promise<any> {
  if (!process.env.WINDOWS_CONTAINERS && isCI) {
    return () => Promise.resolve()
  }
  return fn
}
