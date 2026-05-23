import { CliPackageOptions } from '../cli'
import { WorkTree } from '../planner/work-tree'
import { Environment } from '../executer/environment'
import { iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { ContainerWorkTask, LocalWorkTask } from '../planner/work-task'
import {
  isContainerWorkServiceItem,
  isContainerWorkTaskItem,
  isLocalWorkTaskItem,
  WorkItem,
} from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { getContainerCli } from '../executer/execute-docker'
import { tmpdir } from 'node:os'
import { join, relative } from 'path'
import { getErrorMessage } from '../log'

export async function packageWorkTree(
  workTree: WorkTree,
  environment: Environment,
  options: CliPackageOptions
): Promise<void> {
  if (workTree.environment.type !== 'docker') {
    throw new Error('only docker environments are supported')
  }

  const docker = getContainerCli(workTree.environment)

  for (const service of iterateWorkServices(workTree)) {
    if (isContainerWorkServiceItem(service)) {
      environment.console.info(`preparing files for ${service.name}`)
      const definition = getServiceInstructions(service, options)
      const buildDir = join(tmpdir(), service.id())
      const dockerFileName = join(buildDir, 'Dockerfile')
      const dockerFileContent = definition.instructions.join('\n')
      await environment.file.createDirectory(buildDir)
      await environment.file.writeFile(dockerFileName, dockerFileContent)
      environment.console.debug(`create dockerfile ${dockerFileName}`)
      environment.console.debug(`with cwd ${definition.cwd}`)

      const src: string[] = ['Dockerfile']
      for (const source of definition.sources) {
        const path = relative(definition.cwd, source.absolutePath)
        environment.console.debug(`copying ${source.absolutePath} to ${join(buildDir, path)}`)
        await environment.file.copy(source.absolutePath, join(buildDir, path))
        src.push(path)
      }

      const imageName = `${options.registry}/${service.name}`
      environment.console.info(`building image ${imageName} for ${service.name}`)
      const buildStream = await docker.buildImage(
        {
          src,
          context: buildDir,
        },
        {
          t: imageName,

          abortSignal: environment.abortCtrl.signal,
        }
      )
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(
          buildStream,
          (err, res) => {
            if (err) {
              environment.console.error(getErrorMessage(err))
              reject(err)
            } else if (res.length > 0) {
              environment.console.error(res.map((i) => ('stream' in i ? i.stream : i.error)).join(''))
              reject(new Error('build failed'))
            } else {
              resolve()
            }
          },
          (res) => {
            if (res.stream) {
              if (res.stream === '\n') {
                return
              }
              if (res.stream.endsWith('\n')) {
                environment.console.info(res.stream.substr(0, res.stream.length - 1))
              } else {
                environment.console.info(res.stream)
              }
            }
          }
        )
      })
      environment.console.info(`generated image ${imageName} for ${service.name}`)

      if (options.push) {
        environment.console.info(`pushing image ${imageName} to ${options.registry}`)
        const img = docker.getImage(imageName)
        const pushStream = await img.push({
          abortSignal: environment.abortCtrl.signal,
          authconfig: {
            username: options.username || '',
            password: options.password || '',
            serveraddress: options.registry,
          },
        })
        await new Promise((resolve, reject) => {
          docker.modem.followProgress(
            pushStream,
            (err, res) => (err ? reject(err) : resolve(res)),
            (res) => {
              if (res.stream) {
                environment.console.info(res.stream)
              }
            }
          )
        })
        environment.console.info(`pushed image ${imageName} to ${options.registry}`)
      }
    }
  }
}

export interface TaskInstructions {
  id: string
  instructions: string[]
  sources: ContainerSource[]
  cwd: string
  exports: string[]
  order: number
  deps: TaskInstructions[]
}

export interface ContainerSource {
  absolutePath: string
  matcher: (fileName: string, cwd: string) => boolean
}

function getDependencySources(
  service: WorkItem<ContainerWorkTask | ContainerWorkService>,
  taskIds: string[]
): ContainerSource[] {
  const result: ContainerSource[] = [...service.data.src.filter((s) => !s.inherited)]

  taskIds.push(service.id())

  for (const dep of service.deps) {
    if (taskIds.includes(dep.id())) {
      continue
    }

    if (isLocalWorkTaskItem(dep)) {
      throw new Error(`local tasks (${dep.name}) are not yet supported`)
    }

    if (isContainerWorkTaskItem(dep)) {
      result.push(...getDependencySources(dep, taskIds))
    }
  }

  return result
}

function getDependencyCwd(cwd: string, service: WorkItem<ContainerWorkService>): string {
  const sources = getDependencySources(service, [])
  return longestCommonPrefix(sources.map((s) => s.absolutePath))
}

function longestCommonPrefix(strs: string[]) {
  if (strs.length === 0) {
    return ''
  }
  let prefix = strs[0]
  for (let i = 1; i < strs.length; i++) {
    while (strs[i].indexOf(prefix) !== 0) {
      prefix = prefix.substring(0, prefix.length - 1)
      if (prefix === '') {
        return ''
      }
    }
  }
  return prefix
}

function getServiceInstructions(service: WorkItem<ContainerWorkService>, options: CliPackageOptions): TaskInstructions {
  const dependencyCwd = getDependencyCwd(service.data.cwd, service)
  const tasks: { [task: string]: TaskInstructions } = {}
  const deps = getDependencyInstructions(dependencyCwd, service, tasks)

  // const orderedDeps = Object.entries(tasks).sort(([, a], [, b]) => a.order - b.order)

  const instructions: string[] = [
    ...Object.values(tasks).flatMap((t) => t.instructions),

    `FROM ${service.data.image} as service-${service.id()}`,
    `LABEL hammerkit.dev/id=${service.id()}`,
    `LABEL hammerkit.dev/name=${service.name}`,

    ...Object.entries(service.data.envs.variables).map(([key, value]) => `ENV ${key}=${value}`),

    ...service.data.ports.map((p) => `EXPOSE ${p.containerPort}`),
    `WORKDIR /${relative(dependencyCwd, service.data.cwd)}`,

    options.overrideUser ? 'RUN (addgroup -g 1000 hammerkit && adduser -u 1000 -G hammerkit -s /bin/sh) || true' : '',

    ...service.data.src.map(
      (s) => `COPY ${relative(dependencyCwd, s.absolutePath)} /${relative(dependencyCwd, s.absolutePath)}`
    ),

    ...deps.flatMap((d) => d.exports),

    ...(options.overrideUser
      ? service.data.src
          .filter((s) => !s.inherited)
          .map((v) => `RUN chown -R 1000:1000 /${relative(dependencyCwd, v.absolutePath)}`)
      : []),

    ...service.data.volumes
      .filter((v) => !v.inherited)
      .map((v) => `VOLUME ${relative(dependencyCwd, v.containerPath)}`),
    ...(options.overrideUser
      ? service.data.volumes.map((v) => `RUN chown -R 1000:1000 /${relative(dependencyCwd, v.containerPath)}`)
      : []),

    options.overrideUser ? 'USER 1000:1000' : '',
  ]

  if (service.data.cmd) {
    instructions.push(
      `CMD [${[service.data.cmd.parsed.command, ...service.data.cmd.parsed.args].map((p) => `"${p}"`).join(', ')}]`
    )
  }

  return {
    id: service.id(),
    instructions,
    cwd: dependencyCwd,
    exports: [],
    deps,
    order: 0,
    sources: [
      ...Object.values(tasks).flatMap((t) => t.sources),
      ...service.data.src
        .filter((s) => !s.inherited)
        .map((s) => ({
          absolutePath: s.absolutePath,
          matcher: s.matcher,
        })),
    ],
  }
}

function getDependencyInstructions(
  cwd: string,
  task: WorkItem<ContainerWorkTask | ContainerWorkService | LocalWorkTask>,
  taskIds: { [task: string]: TaskInstructions }
): TaskInstructions[] {
  return task.deps.map((dep) => {
    if (taskIds[dep.id()]) {
      return taskIds[dep.id()]
    } else {
      const data = dep.data
      if (data.type === 'local-task') {
        throw new Error(`local tasks (${task.name}) are not yet supported`)
      }

      return getTaskInstructions(cwd, { ...dep, data }, taskIds)
    }
  })
}

function resolveRecursiveDependencies(
  deps: TaskInstructions[],
  result: {
    [task: string]: TaskInstructions
  }
): TaskInstructions[] {
  for (const dep of deps) {
    if (result[dep.id]) {
      continue
    } else {
      result[dep.id] = dep
      resolveRecursiveDependencies(dep.deps, result)
    }
  }
  return Object.values(result)
}

function getTaskInstructions(
  cwd: string,
  task: WorkItem<ContainerWorkTask>,
  taskIds: {
    [task: string]: TaskInstructions
  }
): TaskInstructions {
  const deps = getDependencyInstructions(cwd, task, taskIds)
  const deepDeps = resolveRecursiveDependencies(deps, {})

  const instructions: TaskInstructions = {
    id: task.id(),
    instructions: [
      `FROM ${task.data.image} as task-${task.id()}`,
      ...Object.entries(task.data.envs.variables).map(([key, value]) => `ENV ${key}=${value}`),
      `WORKDIR /${relative(cwd, task.data.cwd)}`,
      ...task.data.mounts.map((m) => `COPY ${relative(cwd, m.localPath)} /${relative(cwd, m.containerPath)}`),
      ...deepDeps.flatMap((t) =>
        t.sources.map(
          (s) => `COPY --from=task-${t.id} /${relative(cwd, s.absolutePath)} /${relative(cwd, s.absolutePath)}`
        )
      ),
      ...deepDeps.flatMap((d) => d.exports),
      ...task.data.src
        .filter((s) => !s.inherited)
        .map((s) => `COPY ${relative(cwd, s.absolutePath)} /${relative(cwd, s.absolutePath)}`),
      ...task.data.cmds.map((command) => `RUN ${command.cmd}`),
      '####################',
    ],
    cwd,
    sources: [
      ...task.data.src.filter((s) => !s.inherited).map((s) => ({ absolutePath: s.absolutePath, matcher: s.matcher })),
    ],
    exports: [
      ...task.data.generates
        .filter((g) => !g.inherited)
        .map(
          (generate) => `COPY --from=task-${task.id()} ${relative(cwd, generate.path)} /${relative(cwd, generate.path)}`
        ),
    ],
    deps,
    order: deps.reduce((acc, dep) => Math.max(acc, dep.order), 0) + 1,
  }

  taskIds[task.id()] = instructions

  return instructions
}
