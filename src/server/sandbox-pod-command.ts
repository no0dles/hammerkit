import { Readable, Writable } from 'stream'
import { sandboxPodMain } from './sandbox-pod'

// `hammerkit server-sandbox <directory>`: what a server runs in the pod of a sandbox's
// files on a cluster. It reads one request on its standard input and answers on its
// standard output. Not for people. It imports no more than it needs (see index.ts).
export async function runSandboxPodCommand(directory: string, stdin: Readable, stdout: Writable): Promise<void> {
  // tasks run as their image's user, which is not the pod's: what the pod writes, any
  // of them may change, as in a directory a host shares with its containers
  process.umask(0)
  await sandboxPodMain(directory, stdin, stdout)
}
