import {Consola} from 'consola';

export interface RunArg {
  workers: number
  processEnvs: {[key:string]: string|undefined}
  logger: Consola
}
