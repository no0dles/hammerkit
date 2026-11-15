import { WorkPort } from '../work-port'

export function parseWorkPort(port: string): WorkPort {
  const parts = port.split(':')
  if (parts.length === 1) {
    const port = parsePort(parts[0], false)
    return { containerPort: port, hostPort: port }
  } else if (parts.length === 2) {
    // `0:80` is not published, as an empty host port: 0 (a free port) is for the endpoints
    // of a server only
    const hostPort = parsePort(parts[0], true)
    return { containerPort: parsePort(parts[1], false), hostPort: hostPort === 0 ? null : hostPort }
  } else {
    throw new Error(`invalid port ${port}`)
  }
}

function parsePort(port: string, optional: true): number | null
function parsePort(port: string, optional: false): number
function parsePort(port: string, optional: boolean): number | null {
  const result = parseInt(port)
  if (isNaN(result) || result === null || result === undefined) {
    if (!optional) {
      throw new Error(`invalid port ${port}`)
    }
    return null
  }
  return result
}
