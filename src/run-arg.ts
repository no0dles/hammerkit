import { Consola } from 'consola'
import { Defer } from './defer'
import { CacheMethod } from './optimizer/cache-method'

export interface RunArg {
  workers: number
  processEnvs: { [key: string]: string | undefined }
  logger: Consola
  cancelPromise: Defer<void>
  noContainer: boolean
  cacheMethod: CacheMethod
  watch: boolean
}
