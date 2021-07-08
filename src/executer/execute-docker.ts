import { awaitStream } from '../docker/stream'
import Dockerode, { Container } from 'dockerode'
import { pull } from '../docker/pull'
import { ContainerWorkNode } from '../planner/work-node'
import { Defer } from '../defer'
import { Context, ExecutionContext } from '../run-arg'
import { WorkNodePath } from '../planner/work-node-path'

export async function getContainerVolumes(
  node: ContainerWorkNode,
  checkSources: boolean,
  context: Context
): Promise<WorkNodePath[]> {
  const result: WorkNodePath[] = []

  for (const source of node.src) {
    if (!checkSources || (await context.file.exists(source.absolutePath))) {
      result.push({
        localPath: source.absolutePath,
        containerPath: source.absolutePath,
      })
    } else {
      node.status.console.write('internal', 'warn', `source ${source.absolutePath} does not exists`)
    }
  }

  for (const generate of node.generates) {
    result.push({
      localPath: generate,
      containerPath: generate,
    })
  }

  for (const volume of node.mounts) {
    result.push(volume)
  }

  for (const volume of result) {
    const otherVolumes = result.filter(
      (v) => v.containerPath === volume.containerPath && v.localPath !== volume.localPath
    )
    if (otherVolumes.length > 0) {
      throw new Error(
        `duplicate container mount with different sources ${[
          volume.localPath,
          ...otherVolumes.map((ov) => ov.localPath),
        ].join(', ')}`
      )
    }
  }
  return result.filter((v, i) => result.findIndex((iv) => iv.containerPath == v.containerPath) === i)
}

export async function executeDocker(
  node: ContainerWorkNode,
  context: ExecutionContext,
  cancelDefer: Defer<void>
): Promise<void> {
  node.status.console.write('internal', 'debug', `execute ${node.name} as docker task`)
  const docker = new Dockerode()
  const volumes = await getContainerVolumes(node, true, context.context)
  await pull(node, docker, node.image)

  node.status.console.write('internal', 'debug', `create container with image ${node.image} with ${node.shell}`)
  const container = await docker.createContainer({
    Image: node.image,
    Tty: true,
    Entrypoint: node.shell,
    Env: Object.keys(node.envs).map((k) => `${k}=${node.envs[k]}`),
    WorkingDir: node.cwd,
    Labels: { app: 'hammerkit' },
    HostConfig: {
      Binds: volumes.map((v) => `${v.localPath}:${v.containerPath}`),
    },
  })

  for (const volume of volumes) {
    node.status.console.write('internal', 'debug', `mount volume ${volume.localPath}:${volume.containerPath}`)
  }

  cancelDefer.promise.then(() => {
    container.remove({ force: true })
  })

  const user = `${process.getuid()}:${process.getgid()}`

  try {
    await container.start()

    const setUserPermission = async (directory: string) => {
      node.status.console.write('internal', 'debug', 'set permission on ' + directory)
      const result = await execCommand(node, docker, container, '/', ['chown', user, directory], undefined)
      if (result.ExitCode !== 0) {
        node.status.console.write('internal', 'warn', `unable to set permissions for ${directory}`)
      }
    }

    await setUserPermission(node.cwd)
    for (const volume of volumes) {
      await setUserPermission(volume.containerPath)
    }

    for (const cmd of node.cmds) {
      if (cancelDefer.isResolved) {
        return
      }

      node.status.console.write('internal', 'info', `execute ${cmd.cmd} in container`)
      const result = await execCommand(node, docker, container, cmd.path, [node.shell || 'sh', '-c', cmd.cmd], user)
      if (result.ExitCode !== 0) {
        node.status.console.write('internal', 'error', `command ${cmd.cmd} failed with ${result.ExitCode}`)
        throw new Error(`command ${cmd.cmd} failed with ${result.ExitCode}`)
      }
    }
  } finally {
    node.status.console.write('internal', 'debug', `remove container`)
    await container.remove({ force: true })
  }
}

async function execCommand(
  node: ContainerWorkNode,
  docker: Dockerode,
  container: Container,
  cwd: string,
  cmd: string[],
  user: string | undefined
) {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStderr: true,
    User: user,
  })

  const stream = await exec.start({ stdin: true, Detach: false, Tty: false })
  await awaitStream(node, docker, stream)
  return exec.inspect()
}
