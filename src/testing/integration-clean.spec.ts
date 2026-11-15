import { ContainerInfo } from 'dockerode'
import { hostname } from 'os'
import { getLeftoverContainers } from './integration-clean'

function container(id: string, labels: { [key: string]: string }): ContainerInfo {
  return { Id: id, Labels: { app: 'hammerkit', ...labels }, State: 'running' } as unknown as ContainerInfo
}

describe('integration clean', () => {
  // The Docker daemon of a dev machine or CI host may run other hammerkit processes at the
  // same time, such as a CI runner's: the cleanup before a run must leave their containers.
  it('removes only the containers of hammerkit processes of this machine that are gone', () => {
    const host = hostname()
    const containers = [
      container('gone', { 'hammerkit-type': 'task', 'hammerkit-pid': '100', 'hammerkit-host': host }),
      container('gone-healthcheck', {
        'hammerkit-type': 'healthcheck',
        'hammerkit-pid': '100',
        'hammerkit-host': host,
      }),
      container('running', { 'hammerkit-type': 'task', 'hammerkit-pid': '200', 'hammerkit-host': host }),
      container('running-service', { 'hammerkit-type': 'service', 'hammerkit-pid': '200', 'hammerkit-host': host }),
      container('daemon', {
        'hammerkit-type': 'service',
        'hammerkit-pid': '100',
        'hammerkit-host': host,
        'hammerkit-daemon': 'true',
      }),
      container('other-host', { 'hammerkit-type': 'task', 'hammerkit-pid': '100', 'hammerkit-host': `${host}-other` }),
      container('unlabeled', { 'hammerkit-type': 'task' }),
    ]
    const alive = (pid: number) => pid === 200
    expect(getLeftoverContainers(containers, alive).map((c) => c.Id)).toEqual(['gone', 'gone-healthcheck'])
  })
})
