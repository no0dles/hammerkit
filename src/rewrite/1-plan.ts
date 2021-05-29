import { ExecutionBuildFile, ExecutionBuildSource, ExecutionBuildTask, ExecutionBuildTaskCmd } from './0-parse'
import { join } from 'path'
import { homedir } from 'os'

export interface TaskTree {
  nodes: TreeNodes
  rootNode: TaskNode
}

export const isTaskTree = (val: TaskTree | TreeNodes): val is TaskTree => !!val.nodes && !!val.rootNode

export interface TreeNodes {
  [key: string]: TaskNode
}

export interface TaskNode {
  id: string
  name: string
  path: string
  watch: boolean
  description: string | null
  deps: TaskNode[]
  src: TaskNodeSource[]
  generates: string[]
  image: string | null
  shell: string | null
  mounts: ContainerMount[]
  envs: { [key: string]: string }
  cmds: TaskNodeCmd[]
  unknownProps: { [key: string]: any }
  sourceBuildFile: ExecutionBuildFile
  sourceTaskName: string
}

export interface TaskNodeSource {
  absolutePath: string
  matcher: (fileName: string, cwd: string) => boolean
}

export interface ContainerMount {
  localPath: string
  containerPath: string
}

export interface TaskNodeCmd {
  cmd: string
  path: string
}

export function nodes(build: ExecutionBuildFile): TreeNodes {
  const nodes: TreeNodes = {}
  addNodes(build, nodes, [], [])
  return nodes
}

function addNodes(build: ExecutionBuildFile, nodes: TreeNodes, files: string[], namePrefix: string[]) {
  if (files.indexOf(build.fileName) !== -1) {
    return
  }

  files.push(build.fileName)
  for (const taskId of Object.keys(build.tasks)) {
    addTask(build, taskId, nodes, { currentWorkdir: build.path, idPrefix: null, namePrefix: namePrefix })
  }

  for (const key of Object.keys(build.references)) {
    addNodes(build.references[key], nodes, files, [...namePrefix, key])
  }
}

export function plan(build: ExecutionBuildFile, taskName: string): TaskTree {
  const nodes: TreeNodes = {}
  const rootNode = addTask(build, taskName, nodes, { currentWorkdir: build.path, idPrefix: null, namePrefix: [] })
  return { nodes, rootNode }
}

function split(ref: string): { prefix?: string; taskName: string } {
  const index = ref.indexOf(':')
  if (index > 0) {
    return { prefix: ref.substr(0, index), taskName: ref.substr(index + 1) }
  } else {
    return { taskName: ref }
  }
}

interface TaskContext {
  currentWorkdir: string
  idPrefix: string | null
  namePrefix: string[]
}

function addTask(build: ExecutionBuildFile, taskName: string, nodes: TreeNodes, context: TaskContext): TaskNode {
  if (build.tasks[taskName]) {
    const id = `${context.currentWorkdir}:${context.idPrefix ? context.idPrefix + ':' : ''}${taskName}`
    if (nodes[id]) {
      return nodes[id]
    }

    const task = build.tasks[taskName]
    const node: TaskNode = {
      path: context.currentWorkdir,
      envs: { ...build.envs, ...(task.envs || {}) },
      id,
      watch: task.watch ?? false,
      description: task.description,
      name: [...context.namePrefix, taskName].join(':'),
      shell: task.shell || null,
      image: task.image,
      mounts: (task.mounts || []).map((m) => splitMount(context.currentWorkdir, m)),
      cmds: [],
      deps: [],
      generates: getAbsolutePaths(task.generates, context.currentWorkdir),
      src: (task.src || []).map((src) => mapSource(src, context.currentWorkdir)),
      unknownProps: task.unknownProps,
      sourceBuildFile: build,
      sourceTaskName: taskName,
    }
    nodes[id] = node

    for (const dep of task.deps || []) {
      addDependency(build, node, taskName, dep, nodes, context)
    }

    node.cmds = planCommand(task.cmds || [], context.currentWorkdir)

    if (task.extend) {
      const extend = findTask(build, task.extend)
      if (extend.task.src) {
        node.src.push(...extend.task.src.map((src) => mapSource(src, context.currentWorkdir)))
      }
      if (!task.image && extend.task.image) {
        node.image = extend.task.image
      }
      if (extend.task.description && !node.description) {
        node.description = extend.task.description
      }
      if (extend.task.generates) {
        node.generates.push(...getAbsolutePaths(extend.task.generates, context.currentWorkdir))
      }
      if (extend.task.mounts) {
        node.mounts.push(...extend.task.mounts.map((m) => splitMount(context.currentWorkdir, m)))
      }
      if (extend.task.envs) {
        node.envs = { ...extend.task.envs, ...node.envs }
      }
      if (!task.cmds && extend.task.cmds) {
        node.cmds = planCommand(extend.task.cmds || [], context.currentWorkdir)
      }
      if (extend.task.deps) {
        for (const dep of extend.task.deps) {
          addDependency(extend.build, node, taskName, dep, nodes, context)
        }
      }
    }

    return node
  } else {
    const ref = split(taskName)
    if (ref.prefix) {
      if (build.references[ref.prefix]) {
        return addTask(build.references[ref.prefix], ref.taskName, nodes, {
          ...context,
          currentWorkdir: build.references[ref.prefix].path,
          idPrefix: null,
          namePrefix: [...context.namePrefix, ref.prefix],
        })
      } else if (build.includes[ref.prefix]) {
        return addTask(build.includes[ref.prefix], ref.taskName, nodes, {
          ...context,
          idPrefix: ref.prefix,
          namePrefix: [...context.namePrefix, ref.prefix],
        })
      }
    }

    throw new Error(`unable to find ${taskName} in ${build.path}`)
  }
}

function mapSource(src: ExecutionBuildSource, workDir: string): TaskNodeSource {
  return {
    matcher: src.matcher,
    absolutePath: join(workDir, src.relativePath),
  }
}

function splitMount(cwd: string, dir: string): ContainerMount {
  const parts = dir.split(':')
  if (parts.length === 1) {
    if (dir.startsWith('/')) {
      return { localPath: parseLocalMount(cwd, dir), containerPath: dir }
    } else {
      return { localPath: parseLocalMount(cwd, dir), containerPath: join(cwd, dir) }
    }
  } else if (parts.length === 2) {
    if (parts[1].startsWith('/')) {
      return { localPath: parseLocalMount(cwd, parts[0]), containerPath: parts[1] }
    } else {
      return { localPath: parseLocalMount(cwd, parts[0]), containerPath: join(cwd, parts[1]) }
    }
  } else {
    throw new Error(`invalid mount ${dir}`)
  }
}

function parseLocalMount(cwd: string, dir: string) {
  if (dir.startsWith('/')) {
    return dir
  } else if (dir.startsWith('$PWD')) {
    return join(homedir(), dir.substr('$PWD'.length))
  } else {
    return join(cwd, dir)
  }
}

function addDependency(
  build: ExecutionBuildFile,
  node: TaskNode,
  taskName: string,
  dep: string,
  nodes: TreeNodes,
  context: TaskContext
) {
  const depNode = addTask(build, dep, nodes, {
    ...context,
    idPrefix: null,
  })
  if (!depNode) {
    throw new Error(`unable to find dependency ${dep} for task ${taskName} in ${build.path}`)
  }
  node.deps.push(depNode)
  for (const src of depNode.src) {
    if (node.src.indexOf(src) === -1) {
      node.src.push(src)
    }
  }
  for (const generate of depNode.generates) {
    if (node.generates.indexOf(generate) === -1) {
      node.generates.push(generate)
    }
  }
}

function getAbsolutePaths(dirs: string[] | null, workingDir: string): string[] {
  if (!dirs) {
    return []
  }
  return dirs.map((dir) => join(workingDir, dir))
}

function planCommand(cmds: ExecutionBuildTaskCmd[], workingDir: string): TaskNodeCmd[] {
  const result: TaskNodeCmd[] = []
  for (const cmd of cmds) {
    if (typeof cmd === 'string') {
      result.push({ cmd: cmd, path: workingDir })
    } else {
      result.push({
        cmd: cmd.cmd,
        path: join(workingDir, cmd.path || ''),
      })
    }
  }
  return result
}

function findTask(
  build: ExecutionBuildFile,
  taskName: string
): { task: ExecutionBuildTask; build: ExecutionBuildFile } {
  if (build.tasks[taskName]) {
    return { task: build.tasks[taskName], build }
  } else {
    const ref = split(taskName)
    if (ref.prefix && build.includes[ref.prefix]) {
      return findTask(build.includes[ref.prefix], ref.taskName)
    }

    throw new Error(`unable to find ${taskName} in ${build.path}`)
  }
}
