import { WorkMount } from '../work-mount'
import { templateValue } from './template-value'
import { parseWorkMount } from './parse-work-mount'
import { BuildFileContainerTaskSchema } from '../../schema/build-file-container-task-schema'
import { BuildFileContainerServiceSchema } from '../../schema/build-file-container-service-schema'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function parseWorkMounts(
  cwd: string,
  schema: BuildFileContainerTaskSchema | BuildFileContainerServiceSchema,
  envs: WorkEnvironmentVariables
): WorkMount[] {
  if (!schema.mounts) {
    return []
  }

  return schema.mounts.map((m) => templateValue(m, envs)).map((m) => parseWorkMount(cwd, m))
}
