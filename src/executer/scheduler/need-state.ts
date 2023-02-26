import { ServiceDns } from '../service-dns'

export interface NeedState {
  ready: boolean
  dns: { [key: string]: ServiceDns }
  services: {
    [key: string]: ServiceReadyState
  }
}

export type ServiceReadyState =
  | { name: string; ready: true; stateKey: string }
  | { name: string; ready: false; stateKey: string | null }
