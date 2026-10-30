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

  it("puts the run's scope in front of every volume a container service declares, once", () => {
    const shared = { name: 'cache', containerPath: '/cache', inherited: null }
    const db = { name: 'pg-data', containerPath: '/var/lib/postgresql/data', inherited: null }
    // the output of a dep, which the dep's task writes under this name
    const output = { name: 'hammerkit-1234', containerPath: '/app/node_modules', inherited: { name: 'install' } }
    const workTree: any = {
      services: {
        db: { data: { type: 'container-service', image: 'postgres', volumes: [db, shared, output] } },
        cache: { data: { type: 'container-service', image: 'postgres', volumes: [shared] } },
        api: { data: { type: 'kubernetes-service' } },
      },
      tasks: {},
    }
    scopeServiceVolumes(workTree, 'ref-0123456789abcdef01234567')
    expect(db.name).toBe('hammerkit-ref-0123456789abcdef01234567-pg-data')
    expect(shared.name).toBe('hammerkit-ref-0123456789abcdef01234567-cache')
    expect(output.name).toBe('hammerkit-1234')
  })
})
