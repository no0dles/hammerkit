import { WorkNodeGenerate } from '../work-node'
import { extname, join } from 'path'
import { templateValue } from './template-value'
import { BuildFileTaskSchema } from '../../schema/build-file-task-schema'
import { BuildFileVolumeSchema } from '../../schema/build-file-volume-schema'
import { getVolumeName } from './plan-work-volume'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function parseWorkGenerate(
  cwd: string,
  schema: BuildFileTaskSchema,
  envs: WorkEnvironmentVariables
): WorkNodeGenerate[] {
  if (!schema.generates) {
    return []
  }

  return schema.generates.map((g) => {
    const generate = mapGenerate(g)
    const filePath = join(cwd, templateValue(generate.path, envs))
    return {
      path: filePath,
      volumeName: getVolumeName(filePath),
      resetOnChange: generate.resetOnChange,
      export: generate.export,
      isFile: extname(generate.path).length > 1,
      inherited: false,
    }
  })
}

export function mapGenerate(generate: BuildFileVolumeSchema): {
  path: string
  resetOnChange: boolean
  export: boolean
} {
  if (typeof generate === 'string') {
    return { path: generate, resetOnChange: false, export: false }
  } else {
    return {
      path: generate.path,
      resetOnChange: generate.resetOnChange ?? false,
      export: generate.export ?? false,
    }
  }
}
