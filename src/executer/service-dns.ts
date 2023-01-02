export interface ServiceHostDns {
  host: string
}
export interface ServiceContainerDns {
  containerId: string
}
export type ServiceDns = ServiceHostDns | ServiceContainerDns

export const isHostServiceDns = (val: ServiceDns): val is ServiceHostDns => 'host' in val
