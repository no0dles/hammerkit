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
import { join, relative, sep } from 'path'
import { getErrorMessage } from '../log'

// Default the build platform to the host architecture so a packaged image runs
// where it was built unless the caller overrides it with `--platform`. Maps
// node's `process.arch` to docker's platform arch naming.
export function getDefaultPlatform(): string {
  const archByNodeArch: { [arch: string]: string } = {
    x64: 'amd64',
    arm64: 'arm64',
    arm: 'arm',
  }
  const arch = archByNodeArch[process.arch] ?? 'amd64'
  return `linux/${arch}`
}

export async function packageWorkTree(
  workTree: WorkTree,
  environment: Environment,
  options: CliPackageOptions
): Promise<void> {
  if (workTree.environment.type !== 'docker') {
    throw new Error('only docker environments are supported')
  }

  const docker = getContainerCli(workTree.environment)
  const platform = options.platform ?? getDefaultPlatform()
  const tag = options.tag ?? 'latest'

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

      const imageName = `${options.registry}/${service.name}:${tag}`
      environment.console.info(`building image ${imageName} for ${service.name} (${platform})`)
      const buildStream = await docker.buildImage(
        {
          src,
          context: buildDir,
        },
        {
          t: imageName,
          platform,
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
              return
            }
            // followProgress returns every build message in `res`, so a
            // non-empty array is normal on success. Only fail when an entry
            // actually carries an error.
            const failure = (res ?? []).find((i) => 'error' in i && !!i.error)
            if (failure && 'error' in failure) {
              const detail = failure.errorDetail?.message ?? failure.error ?? 'unknown error'
              environment.console.error(detail)
              reject(new Error(`build failed: ${detail}`))
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

// Longest common *directory* of the given (absolute file) paths. Compared per
// path segment, not per character, so `/a/foo` and `/a/foobar` share `/a`, not
// `/a/foo`. When every path is identical (e.g. a single source) the shared
// prefix would be the file itself, so the final segment is dropped to land on
// its directory — otherwise the build context copy targets a directory and
// fails with EISDIR.
export function longestCommonPrefix(strs: string[]) {
  if (strs.length === 0) {
    return ''
  }
  const segments = strs.map((s) => s.split(sep))
  const minLength = Math.min(...segments.map((s) => s.length))
  const common: string[] = []
  for (let i = 0; i < minLength; i++) {
    const segment = segments[0][i]
    if (segments.every((s) => s[i] === segment)) {
      common.push(segment)
    } else {
      break
    }
  }
  if (common.length > 0 && segments.every((s) => s.length === common.length)) {
    common.pop()
  }
  return common.join(sep)
}

// Root the packaged files under a real directory instead of the image's `/`.
// Building at `/` breaks tooling that walks up for config and treats the root
// specially — e.g. `npm install` fails with `Tracker "idealTree" already
// exists` when WORKDIR is `/` (which happens whenever a task's cwd is the build
// context root). Paths inside the image become `${CONTAINER_ROOT}/<relative>`.
const CONTAINER_ROOT = '/hammerkit'

function toContainerPath(relativePath: string): string {
  const normalized = relativePath.split(sep).join('/')
  return normalized === '' ? CONTAINER_ROOT : `${CONTAINER_ROOT}/${normalized}`
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
    `WORKDIR ${toContainerPath(relative(dependencyCwd, service.data.cwd))}`,

    options.overrideUser ? 'RUN (addgroup -g 1000 hammerkit && adduser -u 1000 -G hammerkit -s /bin/sh) || true' : '',

    ...service.data.src.map(
      (s) =>
        `COPY ${relative(dependencyCwd, s.absolutePath)} ${toContainerPath(relative(dependencyCwd, s.absolutePath))}`
    ),

    ...deps.flatMap((d) => d.exports),

    ...(options.overrideUser
      ? service.data.src
          .filter((s) => !s.inherited)
          .map((v) => `RUN chown -R 1000:1000 ${toContainerPath(relative(dependencyCwd, v.absolutePath))}`)
      : []),

    ...service.data.volumes
      .filter((v) => !v.inherited)
      .map((v) => `VOLUME ${toContainerPath(relative(dependencyCwd, v.containerPath))}`),
    ...(options.overrideUser
      ? service.data.volumes.map(
          (v) => `RUN chown -R 1000:1000 ${toContainerPath(relative(dependencyCwd, v.containerPath))}`
        )
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
      `WORKDIR ${toContainerPath(relative(cwd, task.data.cwd))}`,
      ...task.data.mounts.map(
        (m) => `COPY ${relative(cwd, m.localPath)} ${toContainerPath(relative(cwd, m.containerPath))}`
      ),
      ...deepDeps.flatMap((t) =>
        t.sources.map(
          (s) =>
            `COPY --from=task-${t.id} ${toContainerPath(relative(cwd, s.absolutePath))} ${toContainerPath(
              relative(cwd, s.absolutePath)
            )}`
        )
      ),
      ...deepDeps.flatMap((d) => d.exports),
      ...task.data.src
        .filter((s) => !s.inherited)
        .map((s) => `COPY ${relative(cwd, s.absolutePath)} ${toContainerPath(relative(cwd, s.absolutePath))}`),
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
          (generate) =>
            `COPY --from=task-${task.id()} ${toContainerPath(relative(cwd, generate.path))} ${toContainerPath(
              relative(cwd, generate.path)
            )}`
        ),
    ],
    deps,
    order: deps.reduce((acc, dep) => Math.max(acc, dep.order), 0) + 1,
  }

  taskIds[task.id()] = instructions

  return instructions
}
