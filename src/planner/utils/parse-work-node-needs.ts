import { WorkContext } from '../work-context'
import { BaseWorkService, WorkService } from '../work-service'
import { getWorkServiceId } from '../work-service-id'
import { templateValue } from './template-value'
import { parseWorkPort } from './parse-work-port'
import { parseWorkMount } from './parse-work-mount'
import { parseWorkVolume } from './parse-work-volume'
import { getDefaultKubeConfig } from './get-default-kube-config'
import { BuildFileNameSelector, findBuildService } from './find-build-value'
import { ExecutionBuildService } from '../../parser/build-file-service'
import { assignDependencies } from './assign-dependencies'
import { mapLabels } from './map-labels'

export function getWorkService(context: WorkContext, selector: BuildFileNameSelector): WorkService {
  const service = findBuildService(context, selector)
  const id = getWorkServiceId(service.context.build, service.result)

  if (context.services[id]) {
    return context.services[id]
  }

  const value = parseWorkNodeNeeds(id, service.name, service.result, service.context)
  context.services[id] = value

  assignDependencies(
    (service.result.deps || []).map((dep) => ({
      name: dep,
      context: service.context,
      build: service.context.build,
    })),
    value
  )

  for (const need of service.result.needs || []) {
    if (typeof need === 'string') {
      value.needs.push({
        name: need,
        service: getWorkService(service.context, { name: need }),
      })
    } else {
      value.needs.push({
        name: need.name,
        service: getWorkService(service.context, { name: need.service }),
      })
    }
  }

  return value
}

export function parseWorkNodeNeeds(
  id: string,
  name: string,
  service: ExecutionBuildService,
  context: WorkContext
): WorkService {
  const workService: BaseWorkService = {
    id,
    buildService: service,
    name: [...context.namePrefix, name].join(':'),
    description: service.description,
    ports: (service.ports || []).map((m) => templateValue(m, service.envs)).map((m) => parseWorkPort(m)),
    needs: [],
    deps: [],
    labels: mapLabels(service.labels),
  }
  if (service.image) {
    return {
      ...workService,
      type: 'container-service',
      cmd: service.cmd,
      envs: service.envs || {},
      image: service.image,
      cwd: service.cmd ? context.cwd : null,
      // user: getContainerUser(),
      healthcheck: service.healthcheck,
      mounts: (service.mounts || [])
        .map((m) => templateValue(m, service.envs))
        .map((m) => parseWorkMount(context.build.path, m)),
      volumes: (service.volumes || [])
        .map((m) => templateValue(m, service.envs))
        .map((m) => parseWorkVolume(context.build.path, m)),
    }
  } else if (!!service.context && !!service.selector) {
    return {
      ...workService,
      context: service.context,
      selector: service.selector,
      kubeconfig: service.kubeconfig ?? getDefaultKubeConfig(),
      type: 'kubernetes-service',
    }
  } else {
    throw new Error(`unknown service ${name}`)
  }
}
