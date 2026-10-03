import { hostname } from 'os'
import { ContainerInfo } from 'dockerode'
import { isOrphanedContainer, isProcessAlive } from './remove-orphaned-containers'

function container(state: string, labels: { [key: string]: string }): ContainerInfo {
  return { Id: 'cid', State: state, Labels: { app: 'hammerkit', ...labels } } as unknown as ContainerInfo
}

const dead = () => false
const alive = () => true
const here = hostname()

describe('isOrphanedContainer', () => {
  it('treats a task container of a dead process on this machine as orphaned', () => {
    const task = container('running', { 'hammerkit-type': 'task', 'hammerkit-pid': '123', 'hammerkit-host': here })
    expect(isOrphanedContainer(task, dead)).toBe(true)
    expect(isOrphanedContainer(task, alive)).toBe(false)
  })

  it('treats a service of a dead run as orphaned, but not a daemon service', () => {
    const labels = { 'hammerkit-type': 'service', 'hammerkit-pid': '123', 'hammerkit-host': here }
    expect(isOrphanedContainer(container('running', { ...labels, 'hammerkit-daemon': 'false' }), dead)).toBe(true)
    expect(isOrphanedContainer(container('running', { ...labels, 'hammerkit-daemon': 'true' }), dead)).toBe(false)
  })

  it('keeps containers started on another machine', () => {
    const task = container('running', { 'hammerkit-type': 'task', 'hammerkit-pid': '123', 'hammerkit-host': 'other' })
    expect(isOrphanedContainer(task, dead)).toBe(false)
  })

  it('removes the paused state records of hammerkit before 1.9', () => {
    const record = container('paused', { 'hammerkit-type': 'task', 'hammerkit-pid': '123' })
    expect(isOrphanedContainer(record, alive)).toBe(true)
  })

  it('keeps containers without a pid or of an unknown type', () => {
    expect(isOrphanedContainer(container('running', { 'hammerkit-type': 'task', 'hammerkit-host': here }), dead)).toBe(
      false
    )
    expect(isOrphanedContainer(container('running', { 'hammerkit-pid': '123', 'hammerkit-host': here }), dead)).toBe(
      false
    )
  })
})

describe('isProcessAlive', () => {
  it('reports this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })
})
