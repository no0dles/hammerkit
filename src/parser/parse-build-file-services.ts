import { ExecutionBuildService } from './build-file-service'
import { parseStringArray } from './parse-string-array'
import { parseEnvs } from './parse-envs'
import { BuildFile } from './build-file'

const validKeys = ['image', 'ports', 'envs', 'mounts', 'volumes', 'healthcheck']

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
    if (!serviceValue.image) {
      throw new Error(`${fileName} service ${key} needs an image`)
    }
    if (typeof serviceValue.image !== 'string') {
      throw new Error(`${fileName} service ${key} image is not valid`)
    }

    services[key] = {
      image: serviceValue.image,
      ports: parseStringArray(fileName, key, 'ports', serviceValue.ports),
      envs: parseEnvs(fileName, serviceValue.envs, buildFile.envs),
      mounts: [], // TODO parse
      volumes: {}, // TODO parse
      healthcheck: serviceValue.healthcheck, // TODO validate
      unknownProps: Object.keys(serviceValue)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = serviceValue[k]
          return map
        }, {}),
    }
  }

  return services
}
