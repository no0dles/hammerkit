import { WorkTree } from '../work-tree'
import { ReferenceEnvironment } from '../../schema/reference-parser'
import { WorkEnvironment } from '../work-environment'

export function appendWorkEnvironment(workTree: WorkTree, referenced: ReferenceEnvironment): WorkEnvironment {
  const env: WorkEnvironment = {
    namespace: referenced.schema.namespace,
    context: referenced.schema.context,
    ingresses: referenced.schema.ingresses ?? [],
  }
  workTree.environments[referenced.name] = env
  return env
}
