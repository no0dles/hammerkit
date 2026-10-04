import { getServiceDefinitionHash } from './service-definition'
import { WorkItem } from './work-item'
import { ContainerWorkService } from './work-service'

function service(name: string, data: Partial<ContainerWorkService>, needs: WorkItem<ContainerWorkService>[] = []) {
  return {
    name,
    needs: needs.map((need) => ({ name: need.name, service: need })),
    data: {
      type: 'container-service',
      image: 'postgres:16',
      cmd: null,
      shell: null,
      workdir: null,
      envs: { variables: { A: '1' }, replacements: [] },
      ports: [],
      mounts: [],
      volumes: [],
      src: [],
      healthcheck: null,
      secrets: [],
      ...data,
    },
  } as unknown as WorkItem<ContainerWorkService>
}

describe('service definition hash', () => {
  it('is stable for the same definition and changes with any part of it', () => {
    const base = getServiceDefinitionHash(service('db', {}))
    expect(getServiceDefinitionHash(service('db', {}))).toEqual(base)
    expect(getServiceDefinitionHash(service('db', { image: 'postgres:17' }))).not.toEqual(base)
    expect(getServiceDefinitionHash(service('db', { envs: { variables: { A: '2' }, replacements: [] } }))).not.toEqual(
      base
    )
    expect(
      getServiceDefinitionHash(service('db', { ports: [{ hostPort: 5432, containerPort: 5432 }] } as any))
    ).not.toEqual(base)
  })

  it('changes with where a secret goes, never with its value', () => {
    const secret = (name: string, digest: string) => ({
      source: { type: 'env', name: 'DB_PASSWORD' },
      target: { type: 'env', name },
      cache: false,
      digest: () => digest,
    })
    const base = getServiceDefinitionHash(service('db', { secrets: [secret('POSTGRES_PASSWORD', 'a')] } as any))
    expect(getServiceDefinitionHash(service('db', { secrets: [secret('POSTGRES_PASSWORD', 'b')] } as any))).toEqual(
      base
    )
    expect(getServiceDefinitionHash(service('db', { secrets: [secret('PGPASSWORD', 'a')] } as any))).not.toEqual(base)
  })

  it('changes for a dependent when a service it needs changes', () => {
    const api = (db: WorkItem<ContainerWorkService>) => getServiceDefinitionHash(service('api', {}, [db]))
    expect(api(service('db', {}))).toEqual(api(service('db', {})))
    expect(api(service('db', { image: 'postgres:17' }))).not.toEqual(api(service('db', {})))
  })
})
