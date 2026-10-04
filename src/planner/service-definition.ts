import { createHash } from 'crypto'
import { WorkItem } from './work-item'
import { ContainerWorkService, isContainerWorkService } from './work-service'

// Everything a running container of the service was created from, plus the
// definitions of the services it needs: a dependent links to the container it
// started with, so a recreated need means a recreated dependent too. Stored as
// a container label (a hash, never values) so `up` and `run` recreate a running
// service whose definition changed instead of silently reusing it.
export function getServiceDefinitionHash(item: WorkItem<ContainerWorkService>): string {
  const service = item.data
  const definition = {
    image: service.image,
    cmd: service.cmd?.cmd ?? null,
    shell: service.shell,
    workdir: service.workdir,
    envs: {
      variables: service.envs.variables,
      replacements: service.envs.replacements.map((r) => [r.key, r.name, r.value]),
    },
    ports: service.ports.map((p) => `${p.hostPort ?? ''}:${p.containerPort}`),
    mounts: service.mounts.map((m) => `${m.localPath}:${m.containerPath}:${m.readOnly ? 'ro' : 'rw'}`),
    volumes: service.volumes.map((v) => `${v.name}:${v.containerPath}:${v.readOnly ? 'ro' : 'rw'}`),
    src: service.src.map((s) => s.absolutePath),
    healthcheck: service.healthcheck?.cmd.cmd ?? null,
    needs: item.needs
      .filter((need) => isContainerWorkService(need.service.data))
      .map((need) => `${need.name}=${getServiceDefinitionHash(need.service as WorkItem<ContainerWorkService>)}`),
  }
  return createHash('sha1').update(JSON.stringify(definition)).digest('hex')
}
