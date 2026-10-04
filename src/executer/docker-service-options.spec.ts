import { buildServiceCreateOptions } from './docker-service'
import { getServiceHostname } from '../planner/utils/service-hostname'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ExecuteOptions } from '../runtime/runtime'
import { ServiceState } from './scheduler/service-state'

function service(name: string): WorkItem<ContainerWorkService> {
  return {
    id: () => name,
    name,
    status: { write: vi.fn() } as any,
    needs: [],
    deps: [],
    requiredBy: [],
    data: {
      type: 'container-service',
      name,
      cwd: '/project',
      projectRoot: '/project',
      image: 'postgres:16',
      cmd: null,
      shell: null,
      workdir: null,
      envs: { variables: {}, replacements: [] },
      src: [],
      mounts: [
        { localPath: '/project/init.sql', containerPath: '/init.sql', isFile: true, mount: '', readOnly: true },
        { localPath: '/project/data', containerPath: '/data', isFile: false, mount: '', readOnly: false },
      ],
      volumes: [
        {
          name: 'pg',
          containerPath: '/var/lib/postgresql/data',
          resetOnChange: false,
          inherited: null,
          export: false,
          readOnly: false,
        },
        {
          name: 'secrets',
          containerPath: '/run/secrets',
          resetOnChange: false,
          inherited: null,
          export: false,
          readOnly: true,
        },
      ],
      ports: [{ containerPort: 5432, hostPort: 15432 }],
      healthcheck: null,
    } as unknown as ContainerWorkService,
  }
}

function options(publishPorts: boolean): ExecuteOptions<ServiceState> {
  return { stateKey: 'state', daemon: false, publishPorts } as unknown as ExecuteOptions<ServiceState>
}

const network = { links: [], hosts: [] }

describe('service container options', () => {
  it('uses the service name as hostname, so it resolves its own name', () => {
    expect(buildServiceCreateOptions(service('postgres'), options(false), network).Hostname).toEqual('postgres')
    expect(getServiceHostname('lib:Data_Base')).toEqual('lib-data-base')
  })

  it('mounts read-only mounts and volumes with :ro', () => {
    const binds = buildServiceCreateOptions(service('postgres'), options(false), network).HostConfig?.Binds
    expect(binds).toContain('/project/init.sql:/init.sql:ro')
    expect(binds).toContain('/project/data:/data')
    expect(binds).toContain('pg:/var/lib/postgresql/data')
    expect(binds).toContain('secrets:/run/secrets:ro')
  })

  it('publishes host ports only when asked to', () => {
    const published = buildServiceCreateOptions(service('postgres'), options(true), network)
    expect(published.HostConfig?.PortBindings).toEqual({ '5432/tcp': [{ HostPort: '15432' }] })
    const unpublished = buildServiceCreateOptions(service('postgres'), options(false), network)
    expect(unpublished.HostConfig?.PortBindings).toEqual({})
    expect(unpublished.ExposedPorts).toEqual({ '5432/tcp': {} })
  })
})
