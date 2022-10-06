import { CacheMethod } from '../parser/cache-method'

export interface TestSuiteOptions {
  workers?: number
  noContainer?: boolean
  cacheMethod?: CacheMethod
  watch?: boolean
}
