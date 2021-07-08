import { Duplex, Writable } from 'stream'
import { getLogs } from '../log'
import Dockerode from 'dockerode'
import { ContainerWorkNode } from '../planner/work-node'

class NoopStream extends Writable {
  constructor(private fn: (log: string) => void) {
    super()
  }

  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    for (const log of getLogs(chunk)) {
      this.fn(log.endsWith('\n') ? log.substr(0, log.length - 1) : log)
    }
    setImmediate(callback)
  }
}

export async function awaitStream(node: ContainerWorkNode, docker: Dockerode, stream: Duplex): Promise<void> {
  docker.modem.demuxStream(
    stream,
    new NoopStream((log) => node.status.console.write('process', 'info', log)),
    new NoopStream((log) => node.status.console.write('process', 'info', log))
  )

  await new Promise<void>((resolve, reject) => {
    stream.on('error', (err) => {
      reject(err)
    })
    stream.on('end', () => {
      resolve()
    })
    stream.on('close', () => {
      resolve()
    })
  })
}
