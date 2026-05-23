import { CacheBackendSchema } from '../schema/cache-schema'
import { Environment } from '../executer/environment'

export interface CacheBackend {
  readonly type: string

  has(taskId: string, stateKey: string, environment: Environment): Promise<boolean>

  pull(taskId: string, stateKey: string, into: string, environment: Environment): Promise<boolean>

  push(taskId: string, stateKey: string, from: string, environment: Environment): Promise<void>
}

export type CacheBackendFactory = (spec: CacheBackendSchema) => CacheBackend
