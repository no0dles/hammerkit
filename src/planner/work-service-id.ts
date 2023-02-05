import { createHash } from 'crypto'
import { isContainerWorkService, WorkService } from './work-service'

export function getWorkServiceId(service: WorkService): string {
  const jsonData = JSON.stringify(
    isContainerWorkService(service)
      ? {
          cwd: service.cwd ?? undefined,
          image: service.image,
        }
      : {
          context: service.context,
          selector: service.selector,
          kubeconfig: service.kubeconfig,
        }
  )
  return createHash('sha1').update(jsonData).digest('hex')
}
