import { ExecutionBuildService } from './build-file-service'
import { parseStringArray } from './parse-string-array'
import { parseEnvs } from './parse-envs'
import { BuildFile } from './build-file'
import { parseStringMap } from './parse-string-map'
import { parseHealthcheck } from './parse-healthcheck'
import { ParseContext, parseContextDescription } from './parse-context'
import { parseString } from './parse-string'
import { parseServiceSelector } from './parse-service-selector'
import { parseNeedArray } from './parse-need-array'

const validKeys = ['image', 'ports', 'envs', 'mounts', 'volumes', 'healthcheck', 'context', 'selector', 'kubeconfig']

export function parseBuildFileServices(
  fileName: string,
  value: unknown,
  buildFile: BuildFile
): { [key: string]: ExecutionBuildService } {
  const services: { [key: string]: ExecutionBuildService } = {}

  if (!value) {
    return services
  }

  if (typeof value !== 'object') {
    throw new Error(`${fileName} services need to be an object`)
  }

  for (const [key, serviceValue] of Object.entries(value || {})) {
    const ctx: ParseContext = { fileName, name: key, type: 'service' }

    const hasImage = !!serviceValue.image
    const hasContextSelector = !!serviceValue.context && !!serviceValue.selector
    const hasHealthcheck = !!serviceValue.healthcheck

    if (!hasImage && !hasContextSelector) {
      throw new Error(`${parseContextDescription(ctx)} needs an image or a context/selector`)
    }
    if (hasImage && hasContextSelector) {
      throw new Error(`${parseContextDescription(ctx)} can not have an image and a context/selector`)
    }
    if (hasContextSelector && hasHealthcheck) {
      throw new Error(`${parseContextDescription(ctx)} healthchecks only work with images`)
    }

    services[key] = {
      image: parseString(ctx, 'image', serviceValue.image, !hasImage),
      description: parseString(ctx, 'description', serviceValue.description, true),
      ports: parseStringArray(ctx, 'ports', serviceValue.ports),
      envs: parseEnvs(ctx, serviceValue.envs, buildFile.envs),
      mounts: parseStringArray(ctx, 'mounts', serviceValue.mounts),
      volumes: parseStringArray(ctx, 'volumes', serviceValue.volumes),
      healthcheck: parseHealthcheck(ctx, serviceValue.healthcheck),
      labels: parseStringMap(ctx, 'labels', serviceValue.labels),
      cmd: parseString(ctx, 'cmd', serviceValue.cmd, true),
      needs: parseNeedArray(ctx, 'needs', serviceValue.needs),
      deps: parseStringArray(ctx, 'deps', serviceValue.deps),
      unknownProps: Object.keys(serviceValue)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = serviceValue[k]
          return map
        }, {}),
      kubeconfig: parseString(ctx, 'kubeconfig', serviceValue.kubeconfig, true),
      selector: parseServiceSelector(ctx, serviceValue.selector, !hasContextSelector),
      context: parseString(ctx, 'context', serviceValue.context, !hasContextSelector),
    }
  }

  return services
}
