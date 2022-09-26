import { WorkService } from '../planner/work-service'
import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'
import Dockerode, { Container } from 'dockerode'
import { execCommand } from './execute-docker'

export async function checkReadiness(
  service: WorkService,
  healthCheck: ExecutionBuildServiceHealthCheck,
  docker: Dockerode,
  container: Container,
  abort: AbortSignal
): Promise<boolean> {
  const result = await execCommand(
    service,
    docker,
    container,
    undefined,
    healthCheck.cmd.split(' '),
    undefined,
    2000,
    abort
  )

  if (result.type === 'timeout') {
    return false
  } else if (result.type === 'canceled') {
    return false
  } else {
    if (result.result.ExitCode === 0) {
      service.status.write('debug', `healthcheck ${healthCheck.cmd} succeeded`)
      return true
    } else {
      service.status.write('debug', `healthcheck ${healthCheck.cmd} failed with ${result.result.ExitCode}`)
      return false
    }
  }
}
