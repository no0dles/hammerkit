import { BuildFile } from './parser/build-file'
import { WorkTree } from './planner/work-tree'
import { planWorkTree } from './planner/utils/plan-work-tree'
import { iterateWorkNodes, iterateWorkServices, planWorkNodes } from './planner/utils/plan-work-nodes'
import { isContextTaskFilter, WorkScope } from './executer/work-scope'
import { Environment } from './executer/environment'
import { replaceEnvVariables } from './environment/replace-env-variables'
import { isContainerWorkService } from './planner/work-service'
import { isContainerWorkNode } from './planner/work-node'
import { extendHostVariables } from './environment/get-process-env'

export function getWorkScope(buildFile: BuildFile, contextFilter: WorkScope, environment: Environment): WorkTree {
  const tree = isContextTaskFilter(contextFilter)
    ? planWorkTree(buildFile, { taskName: contextFilter.taskName })
    : planWorkNodes(buildFile, contextFilter)
  for (const node of iterateWorkNodes(tree.nodes)) {
    node.envs = replaceEnvVariables(node.envs, environment.processEnvs)
    if (!isContainerWorkNode(node)) {
      node.envs = extendHostVariables(node.envs, environment)
    }
  }
  for (const service of iterateWorkServices(tree.services)) {
    if (isContainerWorkService(service)) {
      service.envs = replaceEnvVariables(service.envs, environment.processEnvs)
    }
  }
  return tree
}
