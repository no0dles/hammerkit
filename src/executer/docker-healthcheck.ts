import Dockerode, { Container } from 'dockerode'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService, getHealthcheckCommand } from '../planner/work-service'
import { describeHealthcheck, WorkHealthcheck } from '../planner/work-healthcheck'
import { Environment } from './environment'
import { checkReadiness } from './check-readiness'
import { getMainProcessUser } from './main-process-user'
import { pull } from '../docker/pull'
import { HELPER_TOOLS_IMAGE } from '../kubernetes/transfer-tools'
import { HELPER_HOST_CONFIG } from '../docker/item-network'
import { getRunLabels } from '../docker/run-labels'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { removeContainer } from '../docker/remove-container'
import { getHealthcheckRequestCommand, HEALTHCHECK_REQUEST_SECONDS } from '../network/healthcheck-request'

// how long docker may take to run one check of a request: its own bound, and the exec around it
const REQUEST_EXEC_TIMEOUT_MS = (HEALTHCHECK_REQUEST_SECONDS + 3) * 1000

export interface DockerHealthcheck {
  // one check: whether the service passed it
  check(): Promise<boolean>
  // removes what the checks ran in
  remove(): Promise<void>
}

/**
 * The checks of a service's healthcheck on Docker. A `cmd` runs in the service's container,
 * as the user of its main process. An `http` or `tcp` check runs in a container of the pinned
 * busybox that shares the service's network namespace: it needs no tool of the image and no
 * published port, and reaches the service whatever network it is on. That container lives
 * while the service is waited for.
 */
export async function prepareDockerHealthcheck(
  docker: Dockerode,
  item: WorkItem<ContainerWorkService>,
  healthcheck: WorkHealthcheck,
  container: Container,
  environment: Environment,
  abort: AbortSignal,
  // the variables of a `cmd` on top of the container's
  env: { [key: string]: string } | undefined
): Promise<DockerHealthcheck> {
  if ('cmd' in healthcheck) {
    const command = getHealthcheckCommand(item.data) ?? []
    return {
      async check() {
        const user = await getMainProcessUser(container)
        return checkReadiness(item.status, command, environment, container, user, abort, env)
      },
      async remove() {},
    }
  }

  await pull(item.status, docker, HELPER_TOOLS_IMAGE, environment)
  const helper = await docker.createContainer({
    Image: HELPER_TOOLS_IMAGE,
    Cmd: ['sleep', '86400'],
    User: '65534:65534',
    Labels: {
      app: 'hammerkit',
      'hammerkit-type': 'healthcheck',
      'hammerkit-healthcheck-of': getWorkInstanceId(item),
      ...getRunLabels(),
      // gone once the service is up, also of `up --daemon`
      'hammerkit-daemon': 'false',
    },
    HostConfig: { ...HELPER_HOST_CONFIG, NetworkMode: `container:${container.id}` },
  })
  try {
    await helper.start()
  } catch (e) {
    await removeContainer(helper).catch(() => undefined)
    throw e
  }
  const command = getHealthcheckRequestCommand('/bin/busybox', healthcheck)
  return {
    check() {
      return checkReadiness(item.status, command, environment, helper, null, abort, undefined, {
        timeout: REQUEST_EXEC_TIMEOUT_MS,
        name: describeHealthcheck(healthcheck),
      })
    },
    remove() {
      return removeContainer(helper)
    },
  }
}
