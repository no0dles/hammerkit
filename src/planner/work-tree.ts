import { WorkNodes } from './work-nodes'
import { WorkServices } from './work-services'
import { BuildFileEnvironment } from '../parser/build-file-environment'
import { ContainerWorkNode, LocalWorkNode } from './work-node'
import { ContainerWorkService, KubernetesWorkService } from './work-service'

export interface WorkTree {
  nodes: WorkNodes
  services: WorkServices
  environments: { [key: string]: BuildFileEnvironment }
}
