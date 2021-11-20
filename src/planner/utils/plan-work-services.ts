import { BuildFile } from '../../parser/build-file'
import { WorkServices } from '../work-services'
import { parseWorkNodeNeeds } from './plan-work-node'

export function planWorkServices(build: BuildFile, serviceName: string): WorkServices {
  const services: WorkServices = {}

  parseWorkNodeNeeds(
    [
      {
        build,
        name: serviceName,
      },
    ],
    services
  )

  return services
}
