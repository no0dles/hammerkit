import { WorkNodePort } from '../work-node-port'

export function parseWorkNodePort(port: string): WorkNodePort {
  const parts = port.split(':')
  if (parts.length === 1) {
    const port = parsePort(parts[0])
    return { containerPort: port, hostPort: port }
  } else if (parts.length === 2) {
    return { containerPort: parsePort(parts[1]), hostPort: parsePort(parts[0]) }
  } else {
    throw new Error(`invalid port ${port}`)
  }
}

function parsePort(port: string): number {
  const result = parseInt(port)
  if (isNaN(result) || result === null || result === undefined) {
    throw new Error(`invalid port ${port}`)
  }
  return result
}
