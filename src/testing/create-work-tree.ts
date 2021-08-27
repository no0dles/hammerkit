import { planWorkTree } from '../planner/utils/plan-work-tree'
import { createBuildFile } from './create-build-file'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'

export async function createWorkTree(
  environment: Environment,
  buildFile: unknown,
  rootNodeName: string
): Promise<WorkTree> {
  const file = await createBuildFile(environment, buildFile)
  return planWorkTree(file, rootNodeName)
}
