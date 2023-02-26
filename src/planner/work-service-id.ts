import { createHash } from 'crypto'
import { isContainerWorkService, WorkService } from './work-service'

export function getWorkServiceId(service: WorkService): string {
  const jsonData = JSON.stringify(
    isContainerWorkService(service)
      ? {
          cwd: service.cwd ?? undefined,
          image: service.image,
          volumes: service.volumes.map((v) => `${v.name}:${v.containerPath}`).sort(),
          src: service.src.map((s) => s.absolutePath).sort(),
          mounts: service.mounts.map((m) => m.mount).sort(),
        }
      : {
          context: service.context,
          selector: service.selector,
          kubeconfig: service.kubeconfig,
        }
  )
  return createHash('sha1').update(jsonData).digest('hex')
}
