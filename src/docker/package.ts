import { CliPackageOptions } from '../cli'
import { WorkTree } from '../planner/work-tree'
import { Environment } from '../executer/environment'
import { iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { ContainerWorkTask } from '../planner/work-task'
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
      const definition = getServiceInstructions(service.data.cwd, service, options)
      const buildDir = join(tmpdir(), service.id())
      const dockerFileName = join(buildDir, 'Dockerfile')
      await environment.file.createDirectory(buildDir)
      await environment.file.writeFile(dockerFileName, definition.instructions.join('\n'))

      const src: string[] = ['Dockerfile']
      for (const source of definition.sources) {
        const path = relative(service.data.cwd, source.absolutePath)
        await environment.file.copy(source.absolutePath, join(buildDir, path))
        src.push(path)
      }

      const imageName = `${options.registry}/${service.name}`
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
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(buildStream, (err, res) => (err ? reject(err) : resolve(res)))
      })

      await docker.getImage(imageName).push({
        abortSignal: environment.abortCtrl.signal,
      })
    }
  }
}

export interface ContainerDefinition {
  instructions: string[]
  sources: ContainerSource[]
}

export interface ContainerSource {
  absolutePath: string
  matcher: (fileName: string, cwd: string) => boolean
}

function getServiceInstructions(
  cwd: string,
  service: WorkItem<ContainerWorkService>,
  options: CliPackageOptions
): ContainerDefinition {
  const { copyInstructions, dependencyInstructions, sources } = getDependencyInstructions(cwd, service)

  const instructions: string[] = [
    ...dependencyInstructions,
    `FROM ${service.data.image} as service-${service.id()}`,
    `LABEL hammerkit.dev/id=${service.id()}`,
    `LABEL hammerkit.dev/name=${service.name}`,
    ...Object.entries(service.data.envs.variables).map(([key, value]) => `ENV ${key}=${value}`),
    ...service.data.ports.map((p) => `EXPOSE ${p.containerPort}`),
    `WORKDIR ${service.data.cwd}`,

    options.overrideUser ? 'RUN (addgroup -g 1000 hammerkit && adduser -u 1000 -G hammerkit -s /bin/sh) || true' : '',

    ...copyInstructions,

    ...service.data.src
      .filter((s) => !s.inherited)
      .map((s) => `COPY ${relative(cwd, s.absolutePath)} ${s.absolutePath}`),

    ...(options.overrideUser
      ? service.data.src.filter((s) => !s.inherited).map((v) => `RUN chown -R 1000:1000 ${v.absolutePath}`)
      : []),

    ...service.data.volumes.map((v) => `VOLUME ${v.containerPath}`),
    ...(options.overrideUser ? service.data.volumes.map((v) => `RUN chown -R 1000:1000 ${v.containerPath}`) : []),

    options.overrideUser ? 'USER 1000:1000' : '',
  ]

  if (service.data.cmd) {
    instructions.push(
      `CMD [${[service.data.cmd.parsed.command, ...service.data.cmd.parsed.args].map((p) => `"${p}"`).join(', ')}]`
    )
  }
  return {
    instructions,
    sources: [
      ...sources,
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
  task: WorkItem<ContainerWorkTask | ContainerWorkService>
): {
  dependencyInstructions: string[]
  copyInstructions: string[]
  sources: ContainerSource[]
} {
  const copyInstructions: string[] = []
  const dependencyInstructions: string[] = []
  const sources: ContainerSource[] = []

  for (const dep of task.deps) {
    if (isLocalWorkTaskItem(dep)) {
      throw new Error(`local tasks (${dep.name}) are not yet supported`)
    }

    if (isContainerWorkTaskItem(dep)) {
      const depContainer = getTaskInstructions(cwd, dep)
      dependencyInstructions.push(...depContainer.instructions)
      sources.push(...depContainer.sources)

      for (const generate of dep.data.generates) {
        copyInstructions.push(`COPY --from=task-${dep.id()} ${generate.path} ${generate.path}`)
      }
    }
  }

  return { copyInstructions, dependencyInstructions, sources }
}

function getTaskInstructions(cwd: string, task: WorkItem<ContainerWorkTask>): ContainerDefinition {
  const instructions: string[] = []
  const sources: ContainerSource[] = []

  const { copyInstructions, dependencyInstructions } = getDependencyInstructions(cwd, task)

  instructions.push(
    ...[
      ...dependencyInstructions,
      `FROM ${task.data.image} as task-${task.id()}`,
      ...Object.entries(task.data.envs.variables).map(([key, value]) => `ENV ${key}=${value}`),
      `WORKDIR ${task.data.cwd}`,
      ...task.data.mounts.map((m) => `COPY ${relative(cwd, m.localPath)} ${m.containerPath}`),
      ...copyInstructions,
      ...task.data.src
        .filter((s) => !s.inherited)
        .map((s) => `COPY ${relative(cwd, s.absolutePath)} ${s.absolutePath}`),
      ...task.data.cmds.map((command) => `RUN ${command.cmd}`),
      '####################',
    ]
  )
  sources.push(
    ...task.data.src.filter((s) => !s.inherited).map((s) => ({ absolutePath: s.absolutePath, matcher: s.matcher }))
  )

  return { instructions, sources }
}
