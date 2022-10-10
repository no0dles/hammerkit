import { BuildFile } from '../../parser/build-file'
import { BaseWorkNode, WorkNode } from '../work-node'
import { createSubWorkContext, WorkContext } from '../work-context'
import { templateValue } from './template-value'
import { planWorkCommand } from './plan-work-command'
import { splitName } from './split-name'
import { parseWorkNodeMount } from './parse-work-node-mount'
import { planWorkDependency } from './plan-work-dependency'
import { join } from 'path'
import { BuildFileTaskSource } from '../../parser/build-file-task-source'
import { WorkNodeSource } from '../work-node-source'
import { BuildFileTask } from '../../parser/build-file-task'
import { WorkNodeCommand } from '../work-node-command'
import { nodeConsole, statusConsole } from '../work-node-status'
import { getWorkNodeId } from '../work-node-id'
import { WorkNodePort } from '../work-node-port'
import { WorkNodePath } from '../work-node-path'
import { parseWorkNodePort } from './parse-work-node-port'
import { BaseWorkService, WorkService } from '../work-service'
import { getWorkServiceId } from '../work-service-id'
import { LabelValues } from '../../testing/test-suite'
import { BuildFileTaskPlatform } from '../../parser/build-file-task-platform'
import { BuildTaskCommand } from '../../parser/build-file-task-command'
import { CacheMethod } from '../../parser/cache-method'

export interface BuildFileReference {
  build: BuildFile
  name: string
  context: WorkContext
}

export interface PlannedTask {
  build: BuildFile
  buildTask: BuildFileTask
  name: string
  cwd: string
  deps: BuildFileReference[]
  src: BuildFileTaskSource[]
  continuous: boolean
  platform: BuildFileTaskPlatform | null
  description: string | null
  shell: string | null
  generates: string[]
  image: string | null
  mounts: string[]
  cmds: BuildTaskCommand[]
  needs: BuildFileReference[]
  envs: { [key: string]: string }
  ports: string[]
  labels: { [key: string]: string }
  cache: CacheMethod
}

export function planTask(workContext: WorkContext, buildTaskResult: BuildTaskResult): PlannedTask {
  let extendedTask: BuildTaskResult | null = null

  if (buildTaskResult.task.extend) {
    extendedTask = findBuildTask(workContext, { taskName: buildTaskResult.task.extend })
    if (extendedTask.task.extend) {
      throw new Error(`nested extend ${extendedTask.name} is not allowed for task ${buildTaskResult.name}`)
    }
  }

  const envs = {
    ...(extendedTask?.task?.envs || {}),
    ...buildTaskResult.context.build.envs,
    ...(buildTaskResult.task.envs || {}),
  }

  const getReferences = (task: BuildTaskResult | null, prop: 'needs' | 'deps'): BuildFileReference[] => {
    if (!task) {
      return []
    }

    const value = task.task[prop]
    if (!value) {
      return []
    }

    return value.map((d) => ({
      name: d,
      build: buildTaskResult.context.build,
      context: task.context,
    }))
  }

  const mergeReferences = (first: BuildFileReference[], second: BuildFileReference[]): BuildFileReference[] => {
    return [...first, ...second]
  }

  return {
    buildTask: buildTaskResult.task,
    build: buildTaskResult.context.build,
    name: buildTaskResult.name,
    cache: buildTaskResult.task.cache ?? extendedTask?.task?.cache ?? workContext.cacheDefault,
    description: buildTaskResult.task.description ?? extendedTask?.task?.description ?? null,
    continuous: buildTaskResult.task.continuous ?? false,
    cwd: workContext.cwd,
    image: buildTaskResult.task.image ?? extendedTask?.task?.image ?? null,
    platform: buildTaskResult.task.platform ?? extendedTask?.task?.platform ?? null,
    mounts: buildTaskResult.task.mounts || extendedTask?.task?.mounts || [],
    generates: buildTaskResult.task.generates || extendedTask?.task?.generates || [],
    shell: buildTaskResult.task.shell ?? extendedTask?.task?.shell ?? null,
    ports: buildTaskResult.task.ports || extendedTask?.task?.ports || [],
    src: buildTaskResult.task.src || extendedTask?.task?.src || [],
    cmds: buildTaskResult.task.cmds || extendedTask?.task?.cmds || [],
    labels: {
      ...(extendedTask?.task?.labels || {}),
      ...(buildTaskResult.task.labels || {}),
    },
    envs,
    deps: mergeReferences(getReferences(extendedTask, 'deps'), getReferences(buildTaskResult, 'deps')),
    needs: mergeReferences(getReferences(extendedTask, 'needs'), getReferences(buildTaskResult, 'needs')),
  }
}

export type BuildTaskResult = { task: BuildFileTask; name: string; context: WorkContext }
export type BuildTaskSelector = { taskName: string }

export function findBuildTask(context: WorkContext, selector: BuildTaskSelector): BuildTaskResult {
  if (context.build.tasks[selector.taskName]) {
    return { task: context.build.tasks[selector.taskName], context, name: selector.taskName }
  } else {
    const ref = splitName(selector.taskName)
    if (ref.prefix) {
      if (context.build.references[ref.prefix]) {
        return findBuildTask(
          createSubWorkContext(context, {
            name: ref.prefix,
            type: 'references',
          }),
          { taskName: ref.taskName }
        )
      } else if (context.build.includes[ref.prefix]) {
        return findBuildTask(
          createSubWorkContext(context, {
            name: ref.prefix,
            type: 'includes',
          }),
          {
            taskName: ref.taskName,
          }
        )
      }
    }

    throw new Error(`unable to find ${selector.taskName} in ${context.build.path}`)
  }
}

export function getWorkNode(context: WorkContext, selector: BuildTaskSelector, noContainer: boolean): WorkNode {
  const rootNode = findBuildTask(context, selector)
  const plannedTask = planTask(rootNode.context, rootNode)

  const id = getWorkNodeId(plannedTask)
  if (context.workTree.nodes[id]) {
    return context.workTree.nodes[id]
  }

  const node = parseWorkNode(id, plannedTask, rootNode.context, noContainer)
  context.workTree.nodes[id] = node

  const depNodes: WorkNode[] = []
  for (const plannedDep of plannedTask.deps) {
    const depName = templateValue(plannedDep.name, plannedDep.build.envs)
    const depNode = getWorkNode(plannedDep.context, { taskName: depName }, noContainer)
    if (!depNodes.some((d) => d.id === depNode.id)) {
      depNodes.push(depNode)
    }
  }

  planWorkDependency(depNodes, node)

  return node
}

export function mapLabels(labels: { [key: string]: string }): LabelValues {
  const result: LabelValues = {}
  for (const [key, value] of Object.entries(labels)) {
    result[key] = [value]
  }
  return result
}

function parseWorkNode(id: string, task: PlannedTask, context: WorkContext, noContainer: boolean): WorkNode {
  const name = [...context.namePrefix, task.name].join(':')

  const baseWorkNode: BaseWorkNode = {
    envs: task.envs,
    id,
    continuous: task.continuous,
    description: templateValue(task.description, task.envs),
    name,
    cwd: task.cwd,
    cmds: parseWorkNodeCommand(task, context, task.envs),
    deps: [],
    buildFile: task.build,
    taskName: task.name,
    src: parseLocalWorkNodeSource(task, context, task.envs),
    generates: parseLocalWorkNodeGenerate(task, context, task.envs),
    plannedTask: task,
    needs: parseWorkNodeNeeds(task.needs, context),
    console: nodeConsole(),
    status: statusConsole(),
    labels: mapLabels(task.labels),
    caching: task.cache,
  }

  if (task.image && !noContainer) {
    // TODO check if possible with needs if noContainer
    return {
      ...baseWorkNode,
      type: 'container',
      image: templateValue(task.image, task.envs),
      shell: templateValue(task.shell, task.envs) || '/bin/sh',
      mounts: parseContainerWorkNodeMount(task, context, task.envs),
      ports: parseContainerWorkNodePorts(task, context, task.envs),
    }
  } else {
    return {
      ...baseWorkNode,
      type: 'local',
    }
  }
}

export function parseContainerWorkNodePorts(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodePort[] {
  return task.ports.map((m) => templateValue(m, envs)).map((m) => parseWorkNodePort(m))
}

function parseContainerWorkNodeMount(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodePath[] {
  return task.mounts.map((m) => templateValue(m, envs)).map((m) => parseWorkNodeMount(context.cwd, m))
}

function parseLocalWorkNodeGenerate(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): { path: string; inherited: boolean }[] {
  return getAbsolutePaths(task.generates, context.cwd)
    .map((g) => templateValue(g, envs))
    .map((path) => ({ path, inherited: false }))
}

function parseLocalWorkNodeSource(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodeSource[] {
  return task.src
    .map((src) => ({
      relativePath: templateValue(src.relativePath, envs),
      matcher: src.matcher,
    }))
    .map((src) => mapSource(src, context.cwd))
}

export function parseWorkNodeNeeds(needs: BuildFileReference[], context: WorkContext): WorkService[] {
  const result: WorkService[] = []

  for (const need of needs) {
    const service = need.build.services[need.name]
    const id = getWorkServiceId(need.build, service)
    if (!context.workTree.services[id]) {
      const workService: BaseWorkService = {
        id,
        name: need.name,
        console: nodeConsole(),
        status: statusConsole(),
        caching: context.cacheDefault,
        ports: (service.ports || []).map((m) => templateValue(m, service.envs)).map((m) => parseWorkNodePort(m)),
      }
      if (service.image) {
        context.workTree.services[id] = {
          ...workService,
          envs: service.envs || {},
          image: service.image,
          healthcheck: service.healthcheck,
          mounts: (service.mounts || [])
            .map((m) => templateValue(m, service.envs))
            .map((m) => parseWorkNodeMount(need.build.path, m)),
          //caching: service.cache ??,
          //volumes: service.volumes || {}, // TODO volume impl
        }
      } else if (!!service.context && !!service.selector) {
        context.workTree.services[id] = {
          ...workService,
          context: service.context,
          selector: service.selector,
        }
      }
    }
    if (!result.some((s) => s.id === id)) {
      result.push(context.workTree.services[id])
    }
  }

  return result
}

function parseWorkNodeCommand(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodeCommand[] {
  return planWorkCommand(
    task.cmds.map((cmd) => {
      if (typeof cmd === 'string') {
        return templateValue(cmd, envs)
      } else {
        return {
          cmd: templateValue(cmd.cmd, envs),
          path: templateValue(cmd.path, envs),
          type: cmd.type,
        }
      }
    }),
    context.cwd
  )
}

export function mapSource(src: BuildFileTaskSource, workDir: string): WorkNodeSource {
  return {
    matcher: src.matcher,
    absolutePath: join(workDir, src.relativePath),
  }
}

export function getAbsolutePaths(dirs: string[] | null, workingDir: string): string[] {
  if (!dirs) {
    return []
  }
  return dirs.map((dir) => join(workingDir, dir))
}
