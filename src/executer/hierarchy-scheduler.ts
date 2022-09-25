import {
  HammerkitEvent,
  NodeCanceledEvent,
  NodeCompletedEvent,
  NodeCrashEvent,
  NodeErrorEvent,
  NodeWatchCanceledEvent,
  SchedulerInitializeEvent,
  SchedulerTerminationEvent,
  ServiceCanceledEvent,
  ServiceCrashEvent,
  ServiceReadyEvent,
} from './events'
import { WorkService } from '../planner/work-service'
import { SchedulerState } from './scheduler/scheduler-state'
import { Process, ProgressHub, UpdateEmitter } from './emitter'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { checkForLoop } from './scheduler/check-for-loop'
import { getWorkNodeCacheStats, hasStatsChanged } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { join } from 'path'
import { listenOnAbort, waitOnAbort } from '../utils/abort-event'
import { ContainerWorkNode, isContainerWorkNode, WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { FileWatcher } from '../file/file-context'
import { checkIfUpToDate } from './scheduler/enqueue-next'
import { CacheMethod } from '../optimizer/cache-method'
import Dockerode, { Container } from 'dockerode'
import {
  convertToPosixPath,
  execCommand,
  getContainerMounts,
  getContainerVolumes,
  getDocker,
  startContainer,
} from './execute-docker'
import { AbortError, checkForAbort } from './abort'
import { pull } from '../docker/pull'
import { ensureVolumeExists } from './get-docker-executor'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { platform } from 'os'
import { removeContainer } from '../docker/remove-container'
import { getErrorMessage, getLogs } from '../log'
import { templateValue } from '../planner/utils/template-value'
import { getProcessEnvs } from '../environment/get-process-env'
import { exec } from 'child_process'
import { logStream } from '../docker/stream'
import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'
import { failNever } from '../utils/fail-never'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'

export function watchNode(
  node: WorkNode,
  environment: Environment,
  cacheMethod: CacheMethod
): Process<NodeWatchCanceledEvent, HammerkitEvent> {
  return async (abort: AbortSignal, hub) => {
    let currentState = await getWorkNodeCacheStats(node, environment)

    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getWorkNodeCacheStats(node, environment)
      const hasChanged = await hasStatsChanged(node, currentState, newStats, cacheMethod)
      if (!hasChanged) {
        return
      }
      currentState = newStats

      node.status.write('debug', `source changed for node ${node.name}, restart process`)

      hub.emit({
        type: 'node-watch-reset',
        node,
      })
    }, 100)

    const fileWatchers: FileWatcher[] = []
    const sources: string[] = []

    for (const src of node.src) {
      node.status.write('debug', `watch ${src.absolutePath} source`)

      const watcher = environment.file.watch(src.absolutePath, async (fileName) => {
        const absoluteFileName = join(src.absolutePath, fileName)

        if (src.matcher(absoluteFileName, node.cwd)) {
          node.status.write('debug', `source ${absoluteFileName} change for watched task ${node.name}`)
          debouncer.bounce()
        }
      })

      sources.push(src.absolutePath)
      fileWatchers.push(watcher)
    }

    hub.emit({
      type: 'node-watch-start',
      node,
      sources,
    })

    await waitOnAbort(abort)

    debouncer.clear()
    for (const watcher of fileWatchers) {
      watcher.close()
    }

    return {
      type: 'node-watch-canceled',
      node,
    }
  }
}

export function getSchedulerState(input: SchedulerInitializeEvent): SchedulerState {
  const state: SchedulerState = {
    abort: false,
    service: {},
    node: {},
    cacheMethod: input.cacheMethod,
    noContainer: input.noContainer,
    watch: input.watch,
    workers: input.workers,
  }

  for (const node of iterateWorkNodes(input.nodes)) {
    state.node[node.id] = {
      type: 'pending',
      node: node,
    }
  }

  for (const service of iterateWorkServices(input.services)) {
    state.service[service.id] = {
      type: 'pending',
      service,
    }
  }

  checkForLoop(state)

  return state
}

export async function schedule(
  emitter: UpdateEmitter<HammerkitEvent>,
  initialState: SchedulerState,
  environment: Environment
): Promise<SchedulerTerminationEvent> {
  let current: HammerkitEvent | null = null
  let state = initialState

  do {
    await enqueuePending(state, environment, emitter)

    current = await emitter.next()

    if (current) {
      state = updateState(state, current)
    }
  } while (!!current)

  // check if complete

  const success = !Object.values(state.node).some((n) => n.type !== 'completed')

  return {
    type: 'scheduler-termination',
    state,
    success,
  }
}

function updateState(current: SchedulerState, evt: HammerkitEvent): SchedulerState {
  if (evt.type === 'node-crash') {
    current.node[evt.node.id] = {
      type: 'crash',
      //abortController,
      node: evt.node,
      exitCode: evt.exitCode,
    }

    return current
  } else if (evt.type === 'node-watch-reset') {
    const nodeState = current.node[evt.node.id]
    if (nodeState.type === 'running') {
      nodeState.abortController.abort() // TODO await stop
    }
    current.node[evt.node.id] = {
      type: 'pending',
      node: evt.node,
    }
    return current
  } else if (evt.type === 'node-watch-canceled') {
    return current
  } else if (evt.type === 'scheduler-termination') {
    return current
  } else if (evt.type === 'node-store-state') {
    return current
  } else if (evt.type === 'scheduler-update') {
    return current
  } else if (evt.type === 'node-start') {
    return current
  } else if (evt.type === 'node-prune-state') {
    return current
  } else if (evt.type === 'node-restore-state') {
    return current
  } else if (evt.type === 'cache-store') {
    return current
  } else if (evt.type === 'cache-restore') {
    return current
  } else if (evt.type === 'node-cleanup') {
    return current
  } else if (evt.type === 'node-canceled') {
    current.node[evt.node.id] = {
      type: 'canceled',
      node: evt.node,
    }
    return current
  } else if (evt.type === 'node-completed') {
    const nodeState = current.node[evt.node.id]
    if (nodeState.type === 'running') {
      current.node[evt.node.id] = {
        type: 'completed',
        node: evt.node,
        duration: new Date().getTime() - nodeState.started.getTime(),
      }
    } else {
      current.node[evt.node.id] = {
        type: 'completed',
        node: evt.node,
        duration: NaN,
      }
    }
    return current
  } else if (evt.type === 'node-error') {
    current.node[evt.node.id] = {
      type: 'error',
      node: evt.node,
      errorMessage: evt.errorMessage,
    }
    return current
  } else if (evt.type === 'node-watch-start') {
    return current
  } else if (evt.type === 'scheduler-initialize') {
    return current
  } else if (evt.type === 'scheduler-start-container-node') {
    return current
  } else if (evt.type === 'scheduler-start-local-node') {
    return current
  } else if (evt.type === 'scheduler-start-service') {
    return current
  } else if (evt.type === 'scheduler-up') {
    return current
  } else if (evt.type === 'scheduler-up-result') {
    return current
  } else if (evt.type === 'service-canceled') {
    current.service[evt.service.id] = {
      type: 'end',
      service: evt.service,
      reason: 'canceled',
    }
    return current
  } else if (evt.type === 'service-cleanup') {
    return current
  } else if (evt.type === 'service-crash') {
    current.service[evt.service.id] = {
      type: 'end',
      service: evt.service,
      reason: 'crash',
    }
    return current
  } else if (evt.type === 'service-prune') {
    return current
  } else if (evt.type === 'service-start') {
    return current
  } else if (evt.type === 'service-ready') {
    const serviceState = current.service[evt.service.id]
    if (serviceState.type === 'running') {
      current.service[evt.service.id] = {
        type: 'ready',
        service: evt.service,
        containerId: evt.containerId,
        abortController: serviceState.abortController,
      }
    } else {
      throw new Error('') // TODO
    }
    return current
  } else if (evt.type === 'cache-clean') {
    return current
  } else {
    failNever(evt, 'unknown evt type')
  }
}

async function enqueuePending(state: SchedulerState, environment: Environment, emitter: UpdateEmitter<HammerkitEvent>) {
  if (environment.abortCtrl.signal.aborted) {
    return
  }

  for (const [nodeId, nodeState] of Object.entries(state.node)) {
    if (nodeState.type === 'pending') {
      const runningNodeCount = Object.values(state.node).filter((n) => n.type === 'running').length
      if (state.workers !== 0 && runningNodeCount >= state.workers) {
        return
      }

      const pendingNeeds = nodeState.node.needs.filter((need) => state.service[need.id].type === 'pending')
      const runningNeeds = nodeState.node.needs.filter((need) => state.service[need.id].type === 'running')
      const hasOpenDeps = nodeState.node.deps.some(
        (dep) => state.node[dep.id].type === 'pending' || state.node[dep.id].type === 'running'
      )

      if (hasOpenDeps) {
        continue
      }

      const isUpToDate = await checkIfUpToDate(state.cacheMethod, nodeState.node, environment)
      if (isUpToDate) {
        state.node[nodeId] = {
          type: 'completed',
          node: nodeState.node,
          duration: 0,
        }
        continue
      }

      if (pendingNeeds.length > 0) {
        for (const pendingNeed of pendingNeeds) {
          const abortController = new AbortController()
          state.service[pendingNeed.id] = {
            type: 'running',
            service: pendingNeed,
            abortController,
          }
          emitter.task(`service:${pendingNeed.id}`, dockerService(pendingNeed, emitter), abortController.signal)
        }
        continue
      }

      if (runningNeeds.length > 0) {
        continue
      }

      const serviceContainers: { [key: string]: string } = {}
      for (const need of nodeState.node.needs) {
        const serviceState = state.service[need.id]
        if (serviceState.type === 'ready') {
          serviceContainers[need.id] = serviceState.containerId
        }
      }

      const abortController = new AbortController()
      state.node[nodeState.node.id] = {
        type: 'running',
        node: nodeState.node,
        started: new Date(),
        abortController,
        result: Promise.resolve(),
      }

      if (isContainerWorkNode(nodeState.node) && !state.noContainer) {
        emitter.task(
          `node:${nodeState.node.id}`,
          dockerNode(nodeState.node, serviceContainers, environment),
          abortController.signal
        )
      } else {
        emitter.task(
          `node:${nodeState.node.id}`,
          localNode(nodeState.node, environment, emitter),
          abortController.signal
        )
      }
    }
  }

  for (const [serviceId, serviceState] of Object.entries(state.service)) {
    if (serviceState.type !== 'ready' && serviceState.type !== 'running') {
      continue
    }

    let hasNeed = false
    for (const nodeState of Object.values(state.node)) {
      if (nodeState.type === 'running' || nodeState.type === 'pending') {
        if (nodeState.node.needs.some((n) => n.id === serviceId)) {
          hasNeed = true
        }
      }
    }

    if (!hasNeed) {
      serviceState.abortController.abort()
    }
  }
}

export async function setUserPermission(
  directory: string,
  node: ContainerWorkNode,
  docker: Dockerode,
  container: Container,
  user: string,
  abort: AbortSignal
) {
  node.status.write('debug', `set permission on ${directory}`)
  const result = await execCommand(
    node,
    docker,
    container,
    '/',
    ['chown', user, directory],
    undefined,
    undefined,
    abort
  )
  if (result.type === 'canceled') {
    return
  }
  if (result.type === 'timeout' || result.result.ExitCode !== 0) {
    node.status.write('warn', `unable to set permissions for ${directory}`)
  }
}

export function dockerService(
  service: WorkService,
  emitter: UpdateEmitter<HammerkitEvent>
): Process<ServiceReadyEvent | ServiceCanceledEvent | ServiceCrashEvent, HammerkitEvent> {
  return async (abort, emitter) => {
    let container: Container | null = null

    try {
      checkForAbort(abort)

      const docker = await getDocker(service)
      await pull(service, docker, service.image)

      checkForAbort(abort)
      service.status.write('debug', `create container with image ${service.image}`)
      container = await docker.createContainer({
        Image: service.image,
        Env: Object.keys(service.envs).map((k) => `${k}=${service.envs[k]}`),
        Labels: { app: 'hammerkit', 'hammerkit-id': service.id, 'hammerkit-type': 'service' },
        ExposedPorts: service.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
          map[`${port.containerPort}/tcp`] = {}
          return map
        }, {}),
        HostConfig: {
          PortBindings: service.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
        },
      })

      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      logStream(service, docker, stream)

      await container.start()
      emitter.emit({
        type: 'scheduler-start-service',
        service,
        abortSignal: abort,
      })

      if (!service.healthcheck) {
        emitter.emit({
          type: 'service-ready',
          service: service,
          containerId: container.id,
        })
      } else {
        let ready = false
        do {
          ready = await checkReadiness(service, service.healthcheck, docker, container, abort)
          if (!ready) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
          }
        } while (!ready)

        emitter.emit({
          type: 'service-ready',
          service,
          containerId: container.id,
        })
      }

      await waitOnAbort(abort)

      return {
        type: 'service-canceled',
        service: service,
      }
    } catch (e) {
      if (e instanceof AbortError) {
        return {
          type: 'service-canceled',
          service: service,
        }
      } else {
        return {
          type: 'service-crash',
          service,
          errorMessage: getErrorMessage(e),
        }
      }
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          service.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}

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

export function localNode(
  node: WorkNode,
  environment: Environment,
  emitter: UpdateEmitter<HammerkitEvent>
): Process<NodeCanceledEvent | NodeErrorEvent | NodeCrashEvent | NodeCompletedEvent, HammerkitEvent> {
  return async (abort, emitter) => {
    node.status.write('info', `execute ${node.name} locally`)

    emitter.emit({
      type: 'scheduler-start-local-node',
      node,
      //abortSignal: abortController.signal,
      abortSignal: abort,
    })

    emitter.emit({
      type: 'node-start',
      node: node,
    })

    try {
      const envs = getProcessEnvs(replaceEnvVariables(node, environment.processEnvs), environment)
      for (const cmd of node.cmds) {
        checkForAbort(abort)

        const command = templateValue(cmd.cmd, envs)
        node.status.write('info', `execute cmd ${command} locally`)

        const exitCode = await executeCommand(node, emitter, abort, cmd.path, command, envs)
        if (exitCode !== 0) {
          return {
            type: 'node-crash',
            node: node,
            exitCode,
            command,
          }
        }
      }

      await writeWorkNodeCache(node, environment)

      return {
        type: 'node-completed',
        node: node,
      }
    } catch (e) {
      if (e instanceof AbortError) {
        return {
          type: 'node-canceled',
          node,
        }
      } else {
        return {
          type: 'node-error',
          node,
          errorMessage: getErrorMessage(e),
        }
      }
    }
  }
}

async function executeCommand(
  node: WorkNode,
  eventBus: ProgressHub<HammerkitEvent>,
  abortSignal: AbortSignal,
  cwd: string,
  command: string,
  envs: { [key: string]: string }
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ps = exec(command, {
      env: envs,
      cwd,
      shell: platform() === 'win32' ? 'powershell.exe' : undefined,
    })
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        node.console.write('stdout', log)
      }
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        node.console.write('stderr', log)
      }
    })
    ps.on('error', (err) => {
      reject(err)
    })
    ps.on('close', (code) => {
      if (abortSignal.aborted) {
        reject(new AbortError())
        return
      }

      resolve(code ?? 0)
    })

    listenOnAbort(abortSignal, () => {
      ps.kill()
    })
  })
}

export function dockerNode(
  node: ContainerWorkNode,
  serviceContainers: { [key: string]: string },
  environment: Environment
): Process<NodeCanceledEvent | NodeErrorEvent | NodeCrashEvent | NodeCompletedEvent, HammerkitEvent> {
  return async (abort, emitter) => {
    let container: Container | null = null

    try {
      const docker = await getDocker(node)

      const volumes = await getContainerVolumes(node)
      const mounts = await getContainerMounts(node, environment)

      checkForAbort(abort)
      await pull(node, docker, node.image)

      checkForAbort(abort)
      for (const volume of volumes) {
        await ensureVolumeExists(docker, volume.name)
      }

      const links: string[] = []
      for (const need of node.needs) {
        const container = serviceContainers[need.id]
        if (!container) {
          throw new Error(`service ${need.name} is not running`)
        }
        links.push(`${container}:${need.name}`)
      }

      const envs = replaceEnvVariables(node, environment.processEnvs)

      checkForAbort(abort)
      node.status.write('debug', `create container with image ${node.image} with ${node.shell}`)
      container = await docker.createContainer({
        Image: node.image,
        Tty: true,
        Entrypoint: node.shell,
        Cmd: ['-c', 'sleep 3600'],
        Env: Object.keys(envs).map((k) => `${k}=${envs[k]}`),
        WorkingDir: convertToPosixPath(node.cwd),
        Labels: { app: 'hammerkit', 'hammerkit-id': node.id, 'hammerkit-type': 'task' },
        HostConfig: {
          Binds: [
            ...mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
            ...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
          ],
          PortBindings: node.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
          Links: links,
          AutoRemove: true,
        },
        ExposedPorts: node.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
          map[`${port.containerPort}/tcp`] = {}
          return map
        }, {}),
      })

      const user =
        platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
          ? `${process.getuid()}:${process.getgid()}`
          : undefined

      for (const mount of mounts) {
        node.status.write('debug', `bind mount ${mount.localPath}:${mount.containerPath}`)
      }
      for (const volume of volumes) {
        node.status.write('debug', `volume mount ${volume.name}:${volume.containerPath}`)
      }

      emitter.emit({
        type: 'node-start',
        node: node,
      })

      node.status.write('debug', `starting container with image ${node.image}`)
      await startContainer(node, container)

      emitter.emit({
        type: 'scheduler-start-container-node',
        node,
        //abortSignal: abortController.signal,
        abortSignal: abort,
        serviceContainers,
      })

      if (user) {
        await setUserPermission(node.cwd, node, docker, container, user, abort)
        for (const volume of volumes) {
          await setUserPermission(volume.containerPath, node, docker, container, user, abort)
        }
        for (const mount of mounts) {
          await setUserPermission(mount.containerPath, node, docker, container, user, abort)
        }
      }

      for (const cmd of node.cmds) {
        checkForAbort(abort)

        const command = templateValue(cmd.cmd, node.envs)
        node.status.write('info', `execute cmd ${command} in container`)

        const result = await execCommand(
          node,
          docker,
          container,
          convertToPosixPath(cmd.path),
          [node.shell, '-c', command],
          user,
          undefined,
          abort
        )

        if (result.type === 'timeout') {
          throw new Error(`command ${command} timed out`)
        }

        if (result.type === 'canceled') {
          return {
            type: 'node-canceled',
            node,
          }
        }

        if (result.result.ExitCode !== 0) {
          return {
            type: 'node-crash',
            node: node,
            command,
            exitCode: result.result.ExitCode ?? 1,
          }
        }
      }

      await writeWorkNodeCache(node, environment)

      return {
        type: 'node-completed',
        node,
      }
    } catch (e) {
      if (e instanceof AbortError) {
        return {
          type: 'node-canceled',
          node,
        }
      } else {
        return {
          type: 'node-error',
          node,
          errorMessage: getErrorMessage(e),
        }
      }
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          node.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}
