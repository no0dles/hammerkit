import { planWorkTree } from '../planner/utils/plan-work-tree'
import { createBuildFile } from './create-build-file'
import { Environment } from '../executer/environment'

export async function createWorkTree(environment: Environment, buildFile: any, rootNodeName: string) {
  const file = await createBuildFile(environment, buildFile)
  return planWorkTree(file, rootNodeName)
}
