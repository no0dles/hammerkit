import { StatusScopedConsole } from '../planner/work-item-status'
import { ContainerCreateOptions } from 'dockerode'
import { hideServerTools, ServerTools } from '../docker/server-tools'

// `tools`: the server's tools in the container, whose folder is not printed
export function printContainerOptions(
  status: StatusScopedConsole,
  containerOptions: ContainerCreateOptions,
  tools?: ServerTools
) {
  const write = (text: string): void => status.write('debug', hideServerTools(text, tools))
  write(`create container with image ${containerOptions.Image} with ${containerOptions.Entrypoint}`)

  for (const mount of containerOptions.HostConfig?.Binds || []) {
    write(`bind ${mount}`)
  }

  if (containerOptions.HostConfig?.NanoCpus) {
    write(`limit cpus to ${containerOptions.HostConfig.NanoCpus / 1e9}`)
  }

  if (containerOptions.HostConfig?.Memory) {
    write(`limit memory to ${containerOptions.HostConfig.Memory} bytes`)
  }

  if (containerOptions.HostConfig?.MemoryReservation) {
    write(`reserve memory ${containerOptions.HostConfig.MemoryReservation} bytes`)
  }

  for (const link of containerOptions.HostConfig?.Links || []) {
    write(`link ${link}`)
  }
}
