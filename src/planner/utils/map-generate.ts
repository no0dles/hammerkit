import { BuildFileTaskGenerate } from '../../parser/build-file-task'
import { WorkNodeGenerate } from '../work-node'

export function mapGenerate(generate: string | BuildFileTaskGenerate): WorkNodeGenerate {
  if (typeof generate === 'string') {
    return { path: generate, resetOnChange: false, export: false, inherited: false, isFile: false }
  } else {
    return {
      path: generate.path,
      resetOnChange: generate.resetOnChange ?? false,
      export: generate.export ?? false,
      inherited: false,
      isFile: false,
    }
  }
}
