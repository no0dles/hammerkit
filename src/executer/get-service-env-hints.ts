import { WorkItemNeed } from '../planner/work-item'
import { isHostServiceDns } from './service-dns'

function toEnvKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function getServiceEnvHints(needs: WorkItemNeed[]): { [key: string]: string } {
  const env: { [key: string]: string } = {}
  for (const need of needs) {
    const state = need.service.state.current
    if (state.type !== 'running') {
      continue
    }
    const key = toEnvKey(need.name)
    const host = isHostServiceDns(state.dns) ? state.dns.host : '127.0.0.1'
    env[`HAMMERKIT_${key}_HOST`] = host

    const ports = need.service.data.ports
    if (ports.length > 0) {
      const primary = ports.find((p) => p.hostPort !== null) ?? ports[0]
      const primaryPort = primary.hostPort ?? primary.containerPort
      env[`HAMMERKIT_${key}_PORT`] = `${primaryPort}`
      for (const port of ports) {
        const portValue = port.hostPort ?? port.containerPort
        env[`HAMMERKIT_${key}_PORT_${port.containerPort}`] = `${portValue}`
      }
    }
  }
  return env
}
