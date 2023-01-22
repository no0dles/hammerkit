import { WorkNodes } from './work-nodes'
import { WorkServices } from './work-services'
import { BuildFileEnvironment } from '../parser/build-file-environment'

export interface WorkTree {
  nodes: WorkNodes
  services: WorkServices
  environments: { [key: string]: BuildFileEnvironment }
}
