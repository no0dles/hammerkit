import { isCI } from '../utils/ci'

export function requiresLinuxContainers(fn: () => Promise<any>): () => Promise<any> {
  if (!process.env.LINUX_CONTAINERS && isCI) {
    return () => Promise.resolve()
  }
  return fn
}
