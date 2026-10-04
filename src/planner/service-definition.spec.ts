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

  it('changes for a dependent when a service it needs changes', () => {
    const api = (db: WorkItem<ContainerWorkService>) => getServiceDefinitionHash(service('api', {}, [db]))
    expect(api(service('db', {}))).toEqual(api(service('db', {})))
    expect(api(service('db', { image: 'postgres:17' }))).not.toEqual(api(service('db', {})))
  })
})
