import { Container } from 'dockerode'
import { PassThrough } from 'stream'

// `uid:gid` from the text of /proc/<pid>/status (effective ids), or null.
export function parseProcessStatusUser(status: string): string | null {
  const uid = status.match(/^Uid:\s+\d+\s+(\d+)/m)
  const gid = status.match(/^Gid:\s+\d+\s+(\d+)/m)
  if (!uid || !gid) {
    return null
  }
  return `${uid[1]}:${gid[1]}`
}

// The user the container's main process (PID 1) runs as, read inside the
// container so user namespaces and rootless docker report the container's ids.
// Healthchecks run as this user, like a Kubernetes exec probe runs as the
// container's user: a check run as root could otherwise create files the
// service then cannot read (RabbitMQ's Erlang cookie). Null when it can't be
// read (no `cat` in the image, a windows container); the check then runs as
// the exec default, as before.
export async function getMainProcessUser(container: Container, timeoutMs = 2000): Promise<string | null> {
  try {
    const exec = await container.exec({ Cmd: ['cat', '/proc/1/status'], AttachStdout: true, AttachStderr: true })
    const stream = await exec.start({ hijack: true, stdin: false })
    const stdout = new PassThrough()
    const chunks: Buffer[] = []
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    container.modem.demuxStream(stream, stdout, new PassThrough())
    const finished = await Promise.race([
      new Promise<boolean>((resolve) => {
        stream.on('end', () => resolve(true))
        stream.on('error', () => resolve(false))
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
    if (!finished) {
      stream.destroy()
      return null
    }
    const result = await exec.inspect()
    if (result.ExitCode !== 0) {
      return null
    }
    return parseProcessStatusUser(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}
