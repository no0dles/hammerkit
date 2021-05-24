import { Consola } from 'consola'
import { Defer } from './defer'

export interface RunArg {
  workers: number
  processEnvs: { [key: string]: string | undefined }
  logger: Consola
  cancelPromise: Defer<void>
}
