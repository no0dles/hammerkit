import { BuildFile } from '../../parser/build-file'
import { BaseWorkNode, WorkNode, WorkNodeGenerate } from '../work-node'
import { createSubWorkContext, WorkContext } from '../work-context'
import { templateValue } from './template-value'
import { planWorkCommand } from './plan-work-command'
import { splitName } from './split-name'
import { parseWorkNodeMount } from './parse-work-node-mount'
import { planWorkDependency } from './plan-work-dependency'
import { extname, join } from 'path'
import { BuildFileTaskSource } from '../../parser/build-file-task-source'
import { WorkNodeSource } from '../work-node-source'
import { BuildFileTask, BuildFileTaskGenerate } from '../../parser/build-file-task'
import { WorkNodeCommand } from '../work-node-command'
import { getWorkNodeId } from '../work-node-id'
import { WorkNodePort } from '../work-node-port'
import { parseWorkNodePort } from './parse-work-node-port'
import { BaseWorkService, WorkService } from '../work-service'
import { getWorkServiceId } from '../work-service-id'
import { BuildFileTaskPlatform } from '../../parser/build-file-task-platform'
import { BuildTaskCommand } from '../../parser/build-file-task-command'
import { CacheMethod } from '../../parser/cache-method'
import { LabelValues } from '../../executer/label-values'
import { homedir, platform } from 'os'
import { parseWorkServiceVolume } from './parse-work-service-volume'
import { WorkMount } from '../work-mount'
import { getContainerVolumes } from './plan-work-volume'
import { getContainerMounts } from './get-container-mounts'
import { normalizePath } from './normalize-path'

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
  continuous: boolean
  deps: BuildFileReference[]
  src: BuildFileTaskSource[]
  platform: BuildFileTaskPlatform | null
  description: string | null
  shell: string | null
  generates: WorkNodeGenerate[]
  image: string | null
  mounts: string[]
  cmds: BuildTaskCommand[]
  needs: BuildFileReference[]
  envs: { [key: string]: string }
  ports: string[]
  labels: { [key: string]: string }
  cache: CacheMethod | null
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
    cache: buildTaskResult.task.cache ?? extendedTask?.task?.cache ?? null,
    description: buildTaskResult.task.description ?? extendedTask?.task?.description ?? null,
    cwd: workContext.cwd,
    image: buildTaskResult.task.image ?? extendedTask?.task?.image ?? null,
    platform: buildTaskResult.task.platform ?? extendedTask?.task?.platform ?? null,
    mounts: buildTaskResult.task.mounts || extendedTask?.task?.mounts || [],
    generates: (buildTaskResult.task.generates || extendedTask?.task?.generates || []).map((g) => mapGenerate(g)),
    shell: buildTaskResult.task.shell ?? extendedTask?.task?.shell ?? null,
    ports: buildTaskResult.task.ports || extendedTask?.task?.ports || [],
    src: buildTaskResult.task.src || extendedTask?.task?.src || [],
    cmds: buildTaskResult.task.cmds || extendedTask?.task?.cmds || [],
    continuous: buildTaskResult.task.continuous ?? extendedTask?.task?.continuous ?? false,
    labels: {
      ...(extendedTask?.task?.labels || {}),
      ...(buildTaskResult.task.labels || {}),
    },
    envs,
    deps: mergeReferences(getReferences(extendedTask, 'deps'), getReferences(buildTaskResult, 'deps')),
    needs: mergeReferences(getReferences(extendedTask, 'needs'), getReferences(buildTaskResult, 'needs')),
  }
}

function mapGenerate(generate: string | BuildFileTaskGenerate): WorkNodeGenerate {
  if (typeof generate === 'string') {
    return { path: generate, resetOnChange: false, export: false, inherited: false, isFile: false }
  } else {
    return {
      path: generate.path,
      resetOnChange: generate.resetOnChange ?? false,
      export: generate.export ?? false,
      inherited: false,
      isFile: false,
    }
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

export function getWorkNode(context: WorkContext, selector: BuildTaskSelector): WorkNode {
  const rootNode = findBuildTask(context, selector)
  const plannedTask = planTask(rootNode.context, rootNode)

  const id = getWorkNodeId(plannedTask)
  if (context.workTree.nodes[id]) {
    return context.workTree.nodes[id]
  }

  const node = parseWorkNode(id, plannedTask, rootNode.context)
  context.workTree.nodes[id] = node

  const depNodes: WorkNode[] = []
  for (const plannedDep of plannedTask.deps) {
    const depName = templateValue(plannedDep.name, plannedDep.build.envs)
    const depNode = getWorkNode(plannedDep.context, { taskName: depName })
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

function parseWorkNode(id: string, task: PlannedTask, context: WorkContext): WorkNode {
  const name = [...context.namePrefix, task.name].join(':')

  const generates = parseLocalWorkNodeGenerate(task, context, task.envs)
  const baseWorkNode: BaseWorkNode = {
    envs: task.envs,
    id,
    description: templateValue(task.description, task.envs),
    continuous: task.continuous,
    name,
    cwd: task.cwd,
    cmds: parseWorkNodeCommand(task, context, task.envs),
    deps: [],
    buildFile: task.build,
    taskName: task.name,
    src: parseLocalWorkNodeSource(task, context, task.envs),
    generates,
    plannedTask: task,
    needs: parseWorkNodeNeeds(task.needs, context),
    labels: mapLabels(task.labels),
    caching: task.cache ?? null,
  }

  if (task.image) {
    const mounts = getContainerMounts(baseWorkNode, parseContainerWorkNodeMount(task, context, generates, task.envs))
    return {
      ...baseWorkNode,
      type: 'container',
      user: getContainerUser(),
      image: templateValue(task.image, task.envs),
      shell: templateValue(task.shell, task.envs) || '/bin/sh',
      mounts,
      ports: parseContainerWorkNodePorts(task, context, task.envs),
      volumes: getContainerVolumes(baseWorkNode, mounts),
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
  generates: WorkNodeGenerate[],
  envs: { [key: string]: string } | null
): WorkMount[] {
  const mounts = task.mounts.map((m) => templateValue(m, envs)).map((m) => parseWorkNodeMount(context.cwd, m))
  const fileGenerates = generates
    .filter((g) => g.isFile)
    .map<WorkMount>((g) => ({
      localPath: g.path,
      containerPath: g.path,
    }))
  return [...mounts, ...fileGenerates]
}

function parseLocalWorkNodeGenerate(
  task: PlannedTask,
  context: WorkContext,
  envs: { [key: string]: string } | null
): WorkNodeGenerate[] {
  return task.generates.map((g) => {
    const filePath = join(context.cwd, templateValue(g.path, envs))
    return {
      path: filePath,
      resetOnChange: g.resetOnChange,
      export: g.export,
      isFile: extname(g.path).length > 1,
      inherited: g.inherited,
    }
  })
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

function getContainerUser(): string | null {
  return platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
    ? `${process.getuid()}:${process.getgid()}`
    : null
}

export function parseWorkNodeNeeds(needs: BuildFileReference[], context: WorkContext): WorkService[] {
  const result: WorkService[] = []

  for (const need of needs) {
    const service = need.build.services[need.name]
    const id = getWorkServiceId(need.build, service)
    if (!context.workTree.services[id]) {
      const workService: BaseWorkService = {
        id,
        buildService: service,
        name: need.name,
        description: service.description,
        ports: (service.ports || []).map((m) => templateValue(m, service.envs)).map((m) => parseWorkNodePort(m)),
      }
      if (service.image) {
        context.workTree.services[id] = {
          ...workService,
          type: 'container-service',
          cmd: service.cmd,
          envs: service.envs || {},
          image: service.image,
          // user: getContainerUser(),
          healthcheck: service.healthcheck,
          mounts: (service.mounts || [])
            .map((m) => templateValue(m, service.envs))
            .map((m) => parseWorkNodeMount(need.build.path, m)),
          volumes: (service.volumes || [])
            .map((m) => templateValue(m, service.envs))
            .map((m) => parseWorkServiceVolume(need.build.path, m)),
        }
      } else if (!!service.context && !!service.selector) {
        context.workTree.services[id] = {
          ...workService,
          context: service.context,
          selector: service.selector,
          kubeconfig: service.kubeconfig ?? getDefaultKubeConfig(),
          type: 'kubernetes-service',
        }
      }
    }
    if (!result.some((s) => s.id === id)) {
      result.push(context.workTree.services[id])
    }
  }

  return result
}

function getDefaultKubeConfig(): string {
  return join(homedir(), '.kube/config')
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
