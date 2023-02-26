import { WorkPort } from '../work-port'
import { templateValue } from './template-value'
import { parseWorkPort } from './parse-work-port'
import { BuildFileServiceSchema } from '../../schema/build-file-service-schema'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function parseWorkPorts(schema: BuildFileServiceSchema, envs: WorkEnvironmentVariables): WorkPort[] {
  return schema.ports.map((m) => templateValue(`${m}`, envs)).map((m) => parseWorkPort(m))
}
