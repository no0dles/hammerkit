import { ExecutionBuildService } from './build-file-service'
import { parseStringArray } from './parse-string-array'
import { parseEnvs } from './parse-envs'
import { BuildFile } from './build-file'
import { parseStringMap } from './parse-string-map'

const validKeys = ['image', 'ports', 'envs', 'mounts', 'volumes', 'healthcheck', 'context', 'selector']

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
    const hasImage = !!serviceValue.image
    const hasContextSelector = !!serviceValue.context && !!serviceValue.selector
    if (!hasImage && !hasContextSelector) {
      throw new Error(`${fileName} service ${key} needs an image or a context/selector`)
    }
    if (hasImage && typeof serviceValue.image !== 'string') {
      throw new Error(`${fileName} service ${key} image is not valid`)
    }
    if (hasContextSelector && typeof serviceValue.context !== 'string') {
      throw new Error(`${fileName} service ${key} context is not valid`)
    }
    if (hasImage && hasContextSelector) {
      throw new Error(`${fileName} service ${key} can not have image and context/selector`)
    }

    services[key] = {
      image: serviceValue.image,
      ports: parseStringArray(fileName, key, 'ports', serviceValue.ports),
      envs: parseEnvs(fileName, serviceValue.envs, buildFile.envs),
      mounts: parseStringArray(fileName, key, 'mounts', serviceValue.mounts),
      healthcheck: serviceValue.healthcheck, // TODO validate
      labels: parseStringMap(fileName, 'service', key, serviceValue.labels),
      unknownProps: Object.keys(serviceValue)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = serviceValue[k]
          return map
        }, {}),
      selector: serviceValue.selector, // TODO validate
      context: serviceValue.context,
    }
  }

  return services
}
