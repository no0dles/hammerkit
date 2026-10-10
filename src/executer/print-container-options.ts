import { StatusScopedConsole } from '../planner/work-item-status'
import { ContainerCreateOptions } from 'dockerode'

export function printContainerOptions(status: StatusScopedConsole, containerOptions: ContainerCreateOptions) {
  status.write('debug', `create container with image ${containerOptions.Image} with ${containerOptions.Entrypoint}`)

  for (const mount of containerOptions.HostConfig?.Binds || []) {
    status.write('debug', `bind ${mount}`)
  }

  for (const mount of containerOptions.HostConfig?.Binds || []) {
    status.write('debug', `bind ${mount}`)
  }

  if (containerOptions.HostConfig?.NanoCpus) {
    status.write('debug', `limit cpus to ${containerOptions.HostConfig.NanoCpus / 1e9}`)
  }

  if (containerOptions.HostConfig?.Memory) {
    status.write('debug', `limit memory to ${containerOptions.HostConfig.Memory} bytes`)
  }

  if (containerOptions.HostConfig?.MemoryReservation) {
    status.write('debug', `reserve memory ${containerOptions.HostConfig.MemoryReservation} bytes`)
  }

  for (const link of containerOptions.HostConfig?.Links || []) {
    status.write('debug', `link ${link}`)
  }
}
