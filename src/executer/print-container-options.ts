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

  for (const link of containerOptions.HostConfig?.Links || []) {
    status.write('debug', `link ${link}`)
  }
}
