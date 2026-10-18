import { isVolumeName, scopeServiceVolumes } from './hosted-volumes'

describe('volumes on a server', () => {
  it('takes names Docker reads as volumes, never paths', () => {
    for (const name of ['pg-data', 'hammerkit-abc', 'cache_1', 'a.b', 'A1']) {
      expect(isVolumeName(name), name).toBe(true)
    }
    for (const name of ['/var/run/docker.sock', '/', './data', '../data', 'C:\\data', '-x', '.x', 'a', '', 'a/b']) {
      expect(isVolumeName(name), name).toBe(false)
    }
  })

  it("puts the run's scope in front of every volume of a container service, once", () => {
    const shared = { name: 'hammerkit-1234', containerPath: '/cache' }
    const db = { name: 'pg-data', containerPath: '/var/lib/postgresql/data' }
    const workTree: any = {
      services: {
        db: { data: { type: 'container-service', image: 'postgres', volumes: [db, shared] } },
        cache: { data: { type: 'container-service', image: 'postgres', volumes: [shared] } },
        api: { data: { type: 'kubernetes-service' } },
      },
      tasks: {},
    }
    scopeServiceVolumes(workTree, 'ref-0123456789abcdef01234567')
    expect(db.name).toBe('hammerkit-ref-0123456789abcdef01234567-pg-data')
    expect(shared.name).toBe('hammerkit-ref-0123456789abcdef01234567-hammerkit-1234')
  })
})
