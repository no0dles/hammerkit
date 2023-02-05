import { WorkPort } from '../work-port'
import { templateValue } from './template-value'
import { parseWorkPort } from './parse-work-port'
import { BuildFileServiceSchema } from '../../schema/build-file-service-schema'

export function parseWorkPorts(schema: BuildFileServiceSchema, envs: { [key: string]: string } | null): WorkPort[] {
  return schema.ports.map((m) => templateValue(`${m}`, envs)).map((m) => parseWorkPort(m))
}
